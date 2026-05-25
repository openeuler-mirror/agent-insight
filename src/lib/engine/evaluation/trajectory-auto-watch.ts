import { prismaRaw as prisma } from '@/lib/storage/prisma';
import { isEvaluatorAgentName } from '@/lib/evaluator-agent';

type JsonRecord = Record<string, unknown>;

const inFlightTaskKeys = new Set<string>();
const pendingTaskKeys = new Set<string>();

function safeParseRecord(text: string | null | undefined): JsonRecord {
    if (!text) return {};
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : {};
    } catch {
        return {};
    }
}

function normalizeAgentName(value: unknown): string {
    return String(value || '').trim();
}

function namesMatch(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
}

async function resolveExecutionAgent(taskId: string, executionAgentName?: string | null): Promise<string> {
    const direct = normalizeAgentName(executionAgentName);
    if (direct) return direct;

    const session = await prisma.session.findUnique({
        where: { taskId },
        select: { interactions: true },
    });
    if (!session?.interactions) return '';

    try {
        const interactions = JSON.parse(session.interactions);
        if (!Array.isArray(interactions)) return '';
        return interactions
            .map((item: { agent?: unknown }) => normalizeAgentName(item.agent))
            .find(name => name && !isEvaluatorAgentName(name)) || '';
    } catch {
        return '';
    }
}

export async function triggerTrajectoryAutoWatchForTask(
    user: string | null | undefined,
    taskId: string | null | undefined,
    baseUrl?: string | null,
): Promise<void> {
    const safeUser = String(user || '').trim();
    const safeTaskId = String(taskId || '').trim();
    const safeBaseUrl = String(baseUrl || '').replace(/\/$/, '');
    if (!safeUser || !safeTaskId || !safeBaseUrl) return;

    const key = `${safeUser}::${safeTaskId}`;
    if (inFlightTaskKeys.has(key)) {
        pendingTaskKeys.add(key);
        return;
    }
    inFlightTaskKeys.add(key);

    try {
        const execution = await prisma.execution.findFirst({
            where: {
                taskId: safeTaskId,
                OR: [{ user: safeUser }, { user: null }],
            },
            orderBy: { timestamp: 'desc' },
            select: {
                id: true,
                taskId: true,
                timestamp: true,
                finalResult: true,
                agentName: true,
            },
        });
        if (!execution || !String(execution.finalResult || '').trim()) return;

        const executionAgent = await resolveExecutionAgent(safeTaskId, execution.agentName);
        if (!executionAgent) return;

        const rows = await prisma.trajectoryEvalResult.findMany({
            where: {
                user: safeUser,
                rawAnalysisJson: { contains: 'autoWatch' },
            },
            orderBy: { createdAt: 'asc' },
        });

        const rowsByRun = new Map<string, typeof rows>();
        for (const row of rows) {
            const raw = safeParseRecord(row.rawAnalysisJson);
            if (raw.autoWatch !== true) continue;
            const watchedAgent = normalizeAgentName(raw.watchedAgent);
            if (!watchedAgent || !namesMatch(watchedAgent, executionAgent)) continue;
            const group = rowsByRun.get(row.evaluatorRunId) || [];
            group.push(row);
            rowsByRun.set(row.evaluatorRunId, group);
        }

        for (const [runId, runRows] of rowsByRun) {
            if (runRows.length === 0) continue;
            const existingTaskIds = new Set(
                runRows
                    .map(row => row.taskId || row.executionId || '')
                    .filter(Boolean),
            );
            if (existingTaskIds.has(safeTaskId) || existingTaskIds.has(execution.id)) continue;

            const runCreatedAt = runRows
                .map(row => row.createdAt.getTime())
                .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
            if (execution.timestamp && execution.timestamp.getTime() < runCreatedAt) continue;

            const response = await fetch(`${safeBaseUrl}/api/eval/trajectory/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user: safeUser,
                    evaluatorRunId: runId,
                    taskIds: [safeTaskId],
                    autoWatch: true,
                    watchedAgent: executionAgent,
                }),
            });

            if (!response.ok) {
                const body = await response.json().catch(() => null) as { error?: unknown } | null;
                const message = typeof body?.error === 'string' ? body.error : response.statusText;
                if (!/already exists|no valid tasks to run/i.test(message)) {
                    console.warn(`[trajectory-auto-watch] append failed for run ${runId}: ${message}`);
                }
            }
        }
    } catch (error) {
        console.error('[trajectory-auto-watch] failed:', error);
    } finally {
        inFlightTaskKeys.delete(key);
        if (pendingTaskKeys.delete(key)) {
            void triggerTrajectoryAutoWatchForTask(safeUser, safeTaskId, safeBaseUrl);
        }
    }
}
