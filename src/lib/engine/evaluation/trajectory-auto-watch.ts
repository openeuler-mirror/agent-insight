import { prismaRaw as prisma } from '@/lib/storage/prisma';
import {
    autoWatchAgentNamesMatch,
    isAutoWatchWindowMatch,
    loadTrajectoryCandidateAgentMap,
    mergeWatchedAgentIntoRawAnalysis,
    normalizeAutoWatchAgent,
    normalizeAutoWatchEnabledAt,
    resolveWatchedAgentForRunRows,
    safeParseAutoWatchRecord,
    type AutoWatchRunRowLike,
} from '@/lib/engine/evaluation/trajectory-auto-watch-helper';

const inFlightTaskKeys = new Set<string>();
const pendingTaskKeys = new Set<string>();

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
                agentName: true,
            },
        });
        if (!execution) return;

        const session = await prisma.session.findUnique({
            where: { taskId: safeTaskId },
            select: { endTime: true },
        });
        if (!session?.endTime) return;

        const executionAgent = (await loadTrajectoryCandidateAgentMap(safeUser, [safeTaskId])).get(safeTaskId) || '';
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
            const raw = safeParseAutoWatchRecord(row.rawAnalysisJson);
            if (raw.autoWatch !== true) continue;
            const group = rowsByRun.get(row.evaluatorRunId) || [];
            group.push(row);
            rowsByRun.set(row.evaluatorRunId, group);
        }

        for (const [runId, runRows] of rowsByRun) {
            if (runRows.length === 0) continue;
            const watchedAgent = await resolveWatchedAgentForRunRows(safeUser, runRows as AutoWatchRunRowLike[]);
            if (!watchedAgent || !autoWatchAgentNamesMatch(watchedAgent, executionAgent)) continue;
            const firstRaw = safeParseAutoWatchRecord(runRows[0]?.rawAnalysisJson);
            const autoWatchEnabledAt = normalizeAutoWatchEnabledAt(firstRaw.autoWatchEnabledAt);
            if (!isAutoWatchWindowMatch(autoWatchEnabledAt, session.endTime)) continue;

            const rowsNeedingWatchedAgentRepair = runRows.filter(row => {
                const raw = safeParseAutoWatchRecord(row.rawAnalysisJson);
                return normalizeAutoWatchAgent(raw.watchedAgent) !== watchedAgent;
            });
            if (rowsNeedingWatchedAgentRepair.length > 0) {
                await prisma.$transaction(
                    rowsNeedingWatchedAgentRepair.map(row => prisma.trajectoryEvalResult.update({
                        where: { id: row.id },
                        data: {
                            rawAnalysisJson: mergeWatchedAgentIntoRawAnalysis(row.rawAnalysisJson, watchedAgent),
                        },
                    })),
                );
            }

            const existingTaskIds = new Set(
                runRows
                    .map(row => row.taskId || row.executionId || '')
                    .filter(Boolean),
            );
            if (existingTaskIds.has(safeTaskId) || existingTaskIds.has(execution.id)) continue;

            const response = await fetch(`${safeBaseUrl}/api/eval/trajectory/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user: safeUser,
                    evaluatorRunId: runId,
                    taskIds: [safeTaskId],
                    autoWatch: true,
                    watchedAgent,
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
