import { db } from '@/lib/storage/prisma';
import { recomputeExecutionSkills } from '@/lib/storage/data-service';
import {
    TRACE_BUNDLE_FORMAT,
    TRACE_BUNDLE_VERSION,
    buildTraceIdentityMap,
    remapTraceBundle,
    sortTraceBundleNodes,
    traceIdentityRemaps,
    validateTraceBundle,
    type PortableTraceExecution,
    type PortableTraceSession,
    type TraceBundleNodeV1,
    type TraceBundleV1,
} from '@/lib/trace-transfer';

function parseStringArray(value: unknown): string[] {
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
    if (typeof value !== 'string' || !value) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
        return [];
    }
}

function parseInvokedSkills(value: unknown): Array<{ name: string; version: number | null }> {
    let parsed = value;
    if (typeof value === 'string' && value) {
        try { parsed = JSON.parse(value); } catch { return []; }
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
        if (!item || typeof item !== 'object' || typeof item.name !== 'string' || !item.name.trim()) return [];
        return [{ name: item.name, version: typeof item.version === 'number' ? item.version : null }];
    });
}

function iso(value: unknown, fallback = new Date(0)): string {
    const date = value instanceof Date ? value : new Date(value as string | number | Date);
    return Number.isFinite(date.getTime()) ? date.toISOString() : fallback.toISOString();
}

function portableExecution(record: any): PortableTraceExecution {
    return {
        id: String(record.id),
        taskId: record.taskId ?? null,
        query: record.query ?? null,
        framework: record.framework ?? null,
        tokens: record.tokens ?? null,
        cost: record.cost ?? null,
        latency: record.latency ?? null,
        toolCallCount: record.toolCallCount ?? null,
        llmCallCount: record.llmCallCount ?? null,
        inputTokens: record.inputTokens ?? null,
        outputTokens: record.outputTokens ?? null,
        toolCallErrorCount: record.toolCallErrorCount ?? null,
        cacheReadInputTokens: record.cacheReadInputTokens ?? null,
        cacheCreationInputTokens: record.cacheCreationInputTokens ?? null,
        maxSingleCallTokens: record.maxSingleCallTokens ?? null,
        reasoningTokens: record.reasoningTokens ?? null,
        timestamp: iso(record.timestamp, new Date()),
        model: record.model ?? null,
        endpoint: record.endpoint ?? null,
        agentName: record.agentName ?? null,
        finalResult: record.finalResult ?? null,
        skill: record.skill ?? null,
        skills: parseStringArray(record.skills),
        invokedSkills: parseInvokedSkills(record.invokedSkills),
        skillVersion: record.skillVersion ?? null,
        label: record.label ?? null,
        observedAgents: parseStringArray(record.observedAgents),
        parentExecutionId: record.parentExecutionId ?? null,
        rootExecutionId: record.rootExecutionId ?? null,
        agentSessionId: record.agentSessionId ?? null,
        subagentType: record.subagentType ?? null,
        subagentName: record.subagentName ?? null,
        isSubagent: record.isSubagent === true,
    };
}

function portableSession(session: any, taskId: string | null): PortableTraceSession | null {
    if (!session || !taskId) return null;
    let interactions: unknown[] = [];
    if (Array.isArray(session.interactions)) interactions = session.interactions;
    else if (typeof session.interactions === 'string') {
        try {
            const parsed = JSON.parse(session.interactions);
            if (Array.isArray(parsed)) interactions = parsed;
        } catch {}
    }
    return {
        taskId,
        label: session.label ?? null,
        query: session.query ?? null,
        startTime: iso(session.startTime, new Date()),
        endTime: session.endTime ? iso(session.endTime) : null,
        interactions,
        model: session.model ?? null,
    };
}

function ownsTrace(record: any, user: string): boolean {
    return record?.user == null || record.user === user;
}

export async function exportTraceBundle(executionId: string, user: string): Promise<TraceBundleV1> {
    const selected = await db.findExecutionById(executionId);
    if (!selected || !ownsTrace(selected, user)) throw new Error('Trace not found');

    const rootId = selected.isSubagent
        ? (selected.rootExecutionId || selected.parentExecutionId)
        : selected.id;
    if (!rootId) throw new Error('Trace root not found');
    const root = rootId === selected.id ? selected : await db.findExecutionById(rootId);
    if (!root || !ownsTrace(root, user)) throw new Error('Trace root not found');

    const possibleChildren = await db.findExecutions({ rootExecutionId: root.id }, { timestamp: 'desc' });
    const children = possibleChildren
        .filter((record: any) => record.id !== root.id && record.rootExecutionId === root.id && record.isSubagent === true && ownsTrace(record, user))
        .sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const records = [root, ...children];
    const executions: TraceBundleNodeV1[] = await Promise.all(records.map(async (record: any) => {
        const storedSession = record.taskId ? await db.findSessionByTaskId(record.taskId) : null;
        const session = storedSession && ownsTrace(storedSession, user) ? storedSession : null;
        return {
            execution: portableExecution(record),
            session: portableSession(session, record.taskId ?? null),
        };
    }));

    return validateTraceBundle({
        format: TRACE_BUNDLE_FORMAT,
        version: TRACE_BUNDLE_VERSION,
        exportedAt: new Date().toISOString(),
        rootExecutionId: root.id,
        executions,
    });
}

async function identityTaken(identity: string): Promise<boolean> {
    const [execution, session, taskExecutions] = await Promise.all([
        db.findExecutionById(identity),
        db.findSessionByTaskId(identity),
        db.findExecutions({ taskId: identity }, { timestamp: 'desc' }),
    ]);
    return !!execution || !!session || taskExecutions.length > 0;
}

function executionCreateData(execution: PortableTraceExecution, user: string): Record<string, unknown> {
    return {
        id: execution.id,
        taskId: execution.taskId,
        query: execution.query,
        framework: execution.framework,
        tokens: execution.tokens,
        cost: execution.cost,
        latency: execution.latency,
        toolCallCount: execution.toolCallCount,
        llmCallCount: execution.llmCallCount,
        inputTokens: execution.inputTokens,
        outputTokens: execution.outputTokens,
        toolCallErrorCount: execution.toolCallErrorCount,
        cacheReadInputTokens: execution.cacheReadInputTokens,
        cacheCreationInputTokens: execution.cacheCreationInputTokens,
        maxSingleCallTokens: execution.maxSingleCallTokens,
        reasoningTokens: execution.reasoningTokens,
        timestamp: new Date(execution.timestamp),
        model: execution.model,
        endpoint: execution.endpoint,
        agentName: execution.agentName,
        finalResult: execution.finalResult,
        skill: execution.skill,
        skills: execution.skills.length ? JSON.stringify(execution.skills) : null,
        invokedSkills: execution.invokedSkills.length ? JSON.stringify(execution.invokedSkills) : null,
        skillVersion: execution.skillVersion,
        label: execution.label,
        user,
        observedAgents: execution.observedAgents.length ? JSON.stringify(execution.observedAgents) : null,
        parentExecutionId: execution.parentExecutionId,
        rootExecutionId: execution.rootExecutionId,
        agentSessionId: execution.agentSessionId,
        subagentType: execution.subagentType,
        subagentName: execution.subagentName,
        isSubagent: execution.isSubagent,
    };
}

function sessionCreateData(session: PortableTraceSession, user: string): Record<string, unknown> {
    return {
        taskId: session.taskId,
        label: session.label,
        query: session.query,
        startTime: new Date(session.startTime),
        endTime: session.endTime ? new Date(session.endTime) : null,
        interactions: JSON.stringify(session.interactions),
        user,
        model: session.model,
    };
}

async function deleteSessionForRollback(taskId: string): Promise<void> {
    const client: any = db.getClient();
    try {
        if (client?.session?.delete) {
            await client.session.delete({ where: { taskId } });
        } else if (typeof client?.query === 'function') {
            await client.query('DELETE FROM "Session" WHERE "taskId" = $1', [taskId]);
        }
    } catch {}
}

export interface ImportTraceBundleResult {
    originalRootExecutionId: string;
    rootExecutionId: string;
    rootTaskId: string | null;
    executionCount: number;
    subagentCount: number;
    remappedIds: ReturnType<typeof traceIdentityRemaps>;
}

export async function importTraceBundle(value: unknown, user: string): Promise<ImportTraceBundleResult> {
    const original = validateTraceBundle(value);
    const identityMap = await buildTraceIdentityMap(original, identityTaken);
    const bundle = remapTraceBundle(original, identityMap);
    validateTraceBundle(bundle);
    const nodes = sortTraceBundleNodes(bundle);
    const createdExecutionIds: string[] = [];
    const createdTaskIds: string[] = [];

    try {
        for (const node of nodes) {
            const execution = node.execution;
            await db.upsertExecution({
                where: { id: execution.id },
                create: executionCreateData(execution, user),
                update: {},
            });
            createdExecutionIds.push(execution.id);
            if (node.session) {
                await db.upsertSession(
                    node.session.taskId,
                    sessionCreateData(node.session, user),
                    {},
                );
                createdTaskIds.push(node.session.taskId);
            }
        }

        for (const node of nodes) {
            await recomputeExecutionSkills(
                node.execution.id,
                node.execution.framework,
                node.session?.interactions ?? [],
                user,
                node.execution.skill,
            );
        }
    } catch (error) {
        for (const taskId of [...createdTaskIds].reverse()) await deleteSessionForRollback(taskId);
        for (const executionId of [...createdExecutionIds].reverse()) {
            try { await db.deleteExecution(executionId); } catch {}
        }
        throw error;
    }

    const root = nodes.find(node => node.execution.id === bundle.rootExecutionId)!;
    return {
        originalRootExecutionId: original.rootExecutionId,
        rootExecutionId: bundle.rootExecutionId,
        rootTaskId: root.execution.taskId,
        executionCount: nodes.length,
        subagentCount: nodes.filter(node => node.execution.isSubagent).length,
        remappedIds: traceIdentityRemaps(identityMap),
    };
}
