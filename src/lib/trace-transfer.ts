import { randomUUID } from 'node:crypto';
import type { LangfuseTraceNode } from '@/lib/ingest/otel/adapters/langfuse-trace';

export const TRACE_BUNDLE_FORMAT = 'agent-insight.trace-bundle' as const;
export const TRACE_BUNDLE_VERSION = 1 as const;
export const TRACE_BUNDLE_MAX_EXECUTIONS = 500;
export const TRACE_BUNDLE_MAX_BYTES = 50 * 1024 * 1024;

export interface PortableTraceExecution {
    id: string;
    taskId: string | null;
    query: string | null;
    framework: string | null;
    tokens: number | null;
    cost: number | null;
    latency: number | null;
    toolCallCount: number | null;
    llmCallCount: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    toolCallErrorCount: number | null;
    cacheReadInputTokens: number | null;
    cacheCreationInputTokens: number | null;
    maxSingleCallTokens: number | null;
    reasoningTokens: number | null;
    timestamp: string;
    model: string | null;
    endpoint: string | null;
    agentName: string | null;
    finalResult: string | null;
    skill: string | null;
    skills: string[];
    invokedSkills: Array<{ name: string; version: number | null }>;
    skillVersion: number | null;
    label: string | null;
    observedAgents: string[];
    parentExecutionId: string | null;
    rootExecutionId: string | null;
    agentSessionId: string | null;
    subagentType: string | null;
    subagentName: string | null;
    isSubagent: boolean;
}

export interface PortableTraceSession {
    taskId: string;
    label: string | null;
    query: string | null;
    startTime: string;
    endTime: string | null;
    interactions: unknown[];
    langfuseTraceNodes?: LangfuseTraceNode[];
    model: string | null;
}

export interface TraceBundleNodeV1 {
    execution: PortableTraceExecution;
    session: PortableTraceSession | null;
}

export interface TraceBundleV1 {
    format: typeof TRACE_BUNDLE_FORMAT;
    version: typeof TRACE_BUNDLE_VERSION;
    exportedAt: string;
    rootExecutionId: string;
    executions: TraceBundleNodeV1[];
}

export interface TraceIdentityRemap {
    original: string;
    imported: string;
}

export class TraceBundleValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TraceBundleValidationError';
    }
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function validDateString(value: unknown): value is string {
    return nonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function assertPortableExecution(value: unknown, index: number): asserts value is PortableTraceExecution {
    if (!value || typeof value !== 'object') {
        throw new TraceBundleValidationError(`executions[${index}].execution must be an object`);
    }
    const execution = value as Partial<PortableTraceExecution>;
    if (!nonEmptyString(execution.id)) {
        throw new TraceBundleValidationError(`executions[${index}].execution.id is required`);
    }
    if (execution.taskId != null && !nonEmptyString(execution.taskId)) {
        throw new TraceBundleValidationError(`executions[${index}].execution.taskId is invalid`);
    }
    if (!validDateString(execution.timestamp)) {
        throw new TraceBundleValidationError(`executions[${index}].execution.timestamp is invalid`);
    }
    if (typeof execution.isSubagent !== 'boolean') {
        throw new TraceBundleValidationError(`executions[${index}].execution.isSubagent must be boolean`);
    }
    if (!Array.isArray(execution.skills) || !Array.isArray(execution.invokedSkills) || !Array.isArray(execution.observedAgents)) {
        throw new TraceBundleValidationError(`executions[${index}] has invalid skill or agent arrays`);
    }
}

function assertPortableSession(value: unknown, execution: PortableTraceExecution, index: number): asserts value is PortableTraceSession | null {
    if (value == null) return;
    if (!value || typeof value !== 'object') {
        throw new TraceBundleValidationError(`executions[${index}].session must be an object or null`);
    }
    const session = value as Partial<PortableTraceSession>;
    if (!nonEmptyString(session.taskId) || !validDateString(session.startTime) || !Array.isArray(session.interactions)) {
        throw new TraceBundleValidationError(`executions[${index}].session is invalid`);
    }
    if (session.endTime != null && !validDateString(session.endTime)) {
        throw new TraceBundleValidationError(`executions[${index}].session.endTime is invalid`);
    }
    if (session.langfuseTraceNodes != null && !Array.isArray(session.langfuseTraceNodes)) {
        throw new TraceBundleValidationError(`executions[${index}].session.langfuseTraceNodes is invalid`);
    }
    if (execution.taskId !== session.taskId) {
        throw new TraceBundleValidationError(`executions[${index}] execution.taskId must equal session.taskId`);
    }
}

export function validateTraceBundle(value: unknown): TraceBundleV1 {
    if (!value || typeof value !== 'object') {
        throw new TraceBundleValidationError('Trace bundle must be an object');
    }
    const bundle = value as Partial<TraceBundleV1>;
    if (bundle.format !== TRACE_BUNDLE_FORMAT) {
        throw new TraceBundleValidationError(`Unsupported trace bundle format: ${String(bundle.format || '')}`);
    }
    if (bundle.version !== TRACE_BUNDLE_VERSION) {
        throw new TraceBundleValidationError(`Unsupported trace bundle version: ${String(bundle.version ?? '')}`);
    }
    if (!validDateString(bundle.exportedAt)) {
        throw new TraceBundleValidationError('exportedAt is invalid');
    }
    if (!nonEmptyString(bundle.rootExecutionId)) {
        throw new TraceBundleValidationError('rootExecutionId is required');
    }
    if (!Array.isArray(bundle.executions) || bundle.executions.length === 0) {
        throw new TraceBundleValidationError('executions must contain at least one node');
    }
    if (bundle.executions.length > TRACE_BUNDLE_MAX_EXECUTIONS) {
        throw new TraceBundleValidationError(`executions exceeds the ${TRACE_BUNDLE_MAX_EXECUTIONS} node limit`);
    }

    const ids = new Set<string>();
    const taskIds = new Set<string>();
    for (let index = 0; index < bundle.executions.length; index++) {
        const node = bundle.executions[index];
        if (!node || typeof node !== 'object') {
            throw new TraceBundleValidationError(`executions[${index}] must be an object`);
        }
        assertPortableExecution(node.execution, index);
        assertPortableSession(node.session, node.execution, index);
        if (ids.has(node.execution.id)) {
            throw new TraceBundleValidationError(`Duplicate execution id: ${node.execution.id}`);
        }
        ids.add(node.execution.id);
        if (node.execution.taskId) {
            if (taskIds.has(node.execution.taskId)) {
                throw new TraceBundleValidationError(`Duplicate task id: ${node.execution.taskId}`);
            }
            taskIds.add(node.execution.taskId);
        }
    }

    const root = bundle.executions.find(node => node.execution.id === bundle.rootExecutionId);
    if (!root) throw new TraceBundleValidationError('rootExecutionId does not reference an execution');
    if (root.execution.isSubagent) throw new TraceBundleValidationError('Root execution cannot be a subagent');
    if (root.execution.parentExecutionId) throw new TraceBundleValidationError('Root execution cannot have a parent');
    if (root.execution.rootExecutionId && root.execution.rootExecutionId !== bundle.rootExecutionId) {
        throw new TraceBundleValidationError('Root execution points to a different root');
    }

    const parentById = new Map<string, string | null>();
    for (const node of bundle.executions) {
        const execution = node.execution;
        const parent = execution.parentExecutionId;
        if (execution.id !== bundle.rootExecutionId) {
            if (!execution.isSubagent) throw new TraceBundleValidationError('Child execution must be a subagent');
            if (!parent || !ids.has(parent)) throw new TraceBundleValidationError('Child execution has a missing parent');
            if (execution.rootExecutionId !== bundle.rootExecutionId) {
                throw new TraceBundleValidationError('Child execution points to a different root');
            }
        }
        parentById.set(execution.id, parent);
    }

    for (const id of ids) {
        const seen = new Set<string>();
        let cursor: string | null | undefined = id;
        while (cursor) {
            if (seen.has(cursor)) throw new TraceBundleValidationError(`Execution tree contains a cycle at ${cursor}`);
            seen.add(cursor);
            cursor = parentById.get(cursor);
        }
    }

    return bundle as TraceBundleV1;
}

export function collectTraceBundleIdentities(bundle: TraceBundleV1): string[] {
    const values = new Set<string>();
    for (const node of bundle.executions) {
        values.add(node.execution.id);
        if (node.execution.taskId) values.add(node.execution.taskId);
    }
    return [...values];
}

export async function buildTraceIdentityMap(
    bundle: TraceBundleV1,
    isTaken: (identity: string) => Promise<boolean>,
    generateIdentity: () => string = () => `import_${randomUUID()}`,
): Promise<Map<string, string>> {
    const originals = collectTraceBundleIdentities(bundle);
    const reserved = new Set(originals);
    const mapped = new Set<string>();
    const result = new Map<string, string>();

    for (const original of originals) {
        if (!(await isTaken(original))) {
            result.set(original, original);
            mapped.add(original);
            continue;
        }
        let candidate = '';
        do {
            candidate = generateIdentity();
        } while (!candidate || reserved.has(candidate) || mapped.has(candidate) || await isTaken(candidate));
        result.set(original, candidate);
        mapped.add(candidate);
    }
    return result;
}

const SESSION_REFERENCE_KEYS = new Set([
    'session_id', 'sessionId', 'subagent_session_id', 'subagentSessionId',
    'agent_session_id', 'agentSessionId', 'parent_session_id', 'parentSessionId',
    'root_session_id', 'rootSessionId',
    'execution_id', 'executionId', 'parent_execution_id', 'parentExecutionId',
    'root_execution_id', 'rootExecutionId',
]);
const JSON_STRING_KEYS = new Set(['arguments', 'args', 'input', 'output']);

function rewriteInteractionValue(value: unknown, identityMap: Map<string, string>, key?: string): unknown {
    if (typeof value === 'string') {
        if (key && SESSION_REFERENCE_KEYS.has(key)) return identityMap.get(value) ?? value;
        if (key && JSON_STRING_KEYS.has(key)) {
            const trimmed = value.trim();
            if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                try {
                    const parsed = JSON.parse(value);
                    return JSON.stringify(rewriteInteractionValue(parsed, identityMap));
                } catch {
                    return value;
                }
            }
        }
        return value;
    }
    if (Array.isArray(value)) return value.map(item => rewriteInteractionValue(item, identityMap));
    if (!value || typeof value !== 'object') return value;
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        output[childKey] = rewriteInteractionValue(childValue, identityMap, childKey);
    }
    return output;
}

export function remapTraceBundle(bundle: TraceBundleV1, identityMap: Map<string, string>): TraceBundleV1 {
    const mapped = (value: string | null): string | null => value ? (identityMap.get(value) ?? value) : null;
    return {
        ...bundle,
        rootExecutionId: mapped(bundle.rootExecutionId) as string,
        executions: bundle.executions.map(node => ({
            execution: {
                ...node.execution,
                id: mapped(node.execution.id) as string,
                taskId: mapped(node.execution.taskId),
                parentExecutionId: mapped(node.execution.parentExecutionId),
                rootExecutionId: mapped(node.execution.rootExecutionId),
                agentSessionId: mapped(node.execution.agentSessionId),
            },
            session: node.session ? {
                ...node.session,
                taskId: mapped(node.session.taskId) as string,
                interactions: rewriteInteractionValue(node.session.interactions, identityMap) as unknown[],
                ...(node.session.langfuseTraceNodes ? {
                    langfuseTraceNodes: rewriteInteractionValue(
                        node.session.langfuseTraceNodes,
                        identityMap,
                    ) as LangfuseTraceNode[],
                } : {}),
            } : null,
        })),
    };
}

export function sortTraceBundleNodes(bundle: TraceBundleV1): TraceBundleNodeV1[] {
    const byId = new Map(bundle.executions.map(node => [node.execution.id, node]));
    const result: TraceBundleNodeV1[] = [];
    const visited = new Set<string>();
    const visit = (id: string) => {
        if (visited.has(id)) return;
        const node = byId.get(id);
        if (!node) return;
        if (node.execution.parentExecutionId) visit(node.execution.parentExecutionId);
        visited.add(id);
        result.push(node);
    };
    for (const node of bundle.executions) visit(node.execution.id);
    return result;
}

export function traceIdentityRemaps(identityMap: Map<string, string>): TraceIdentityRemap[] {
    return [...identityMap.entries()]
        .filter(([original, imported]) => original !== imported)
        .map(([original, imported]) => ({ original, imported }));
}
