import { type ExecutionRecord, readRecords } from '@/lib/storage/data-service';
import {
    getPrimaryExecutionAgentName,
    isEvaluatorAgentName,
    isEvaluatorTraceRecord,
} from '@/lib/evaluator-agent';

type JsonRecord = Record<string, unknown>;

export interface AutoWatchRunRowLike {
    id: string;
    taskId: string | null;
    executionId: string | null;
    rawAnalysisJson: string | null;
}

export interface AutoWatchAgentResolution {
    agent: string;
    missingTaskIds: string[];
    distinctAgents: string[];
}

export function normalizeAutoWatchEnabledAt(value: unknown): string {
    const text = String(value || '').trim();
    if (!text) return '';
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

export function isAutoWatchWindowMatch(
    enabledAt: string | null | undefined,
    candidateCompletedAt: Date | string | null | undefined,
): boolean {
    const normalizedEnabledAt = normalizeAutoWatchEnabledAt(enabledAt);
    if (!normalizedEnabledAt) return false;
    const enabledMs = new Date(normalizedEnabledAt).getTime();
    const completedMs = candidateCompletedAt instanceof Date
        ? candidateCompletedAt.getTime()
        : new Date(String(candidateCompletedAt || '')).getTime();
    if (!Number.isFinite(enabledMs) || !Number.isFinite(completedMs)) return false;
    return completedMs >= enabledMs;
}

export function safeParseAutoWatchRecord(text: string | null | undefined): JsonRecord {
    if (!text) return {};
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : {};
    } catch {
        return {};
    }
}

export function normalizeAutoWatchAgent(value: unknown): string {
    return String(value || '').trim();
}

export function autoWatchAgentNamesMatch(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function resolveTrajectoryCandidateExecutionAgent(record?: ExecutionRecord | null): string {
    if (!record || isEvaluatorTraceRecord(record)) return '';
    return normalizeAutoWatchAgent(getPrimaryExecutionAgentName(record));
}

export function mergeWatchedAgentIntoRawAnalysis(
    rawAnalysisJson: string | null | undefined,
    watchedAgent: string,
): string {
    const parsed = safeParseAutoWatchRecord(rawAnalysisJson);
    const next: Record<string, unknown> = {
        ...parsed,
    };
    if (watchedAgent) next.watchedAgent = watchedAgent;
    else delete next.watchedAgent;
    return JSON.stringify(next);
}

export async function loadTrajectoryCandidateAgentMap(
    user: string | null | undefined,
    taskIds: string[],
): Promise<Map<string, string>> {
    const safeUser = String(user || '').trim();
    const uniqueTaskIds = Array.from(new Set(
        taskIds.map(taskId => normalizeAutoWatchAgent(taskId)).filter(Boolean),
    ));
    const out = new Map<string, string>();
    if (!safeUser || uniqueTaskIds.length === 0) return out;

    const records = await readRecords(
        safeUser,
        { taskIds: uniqueTaskIds },
        { attachEvaluations: false },
    );
    for (const record of records) {
        const taskId = normalizeAutoWatchAgent(record.task_id);
        if (!taskId || out.has(taskId)) continue;
        const agent = resolveTrajectoryCandidateExecutionAgent(record);
        if (agent) out.set(taskId, agent);
    }
    return out;
}

export async function resolveSingleTrajectoryCandidateAgent(
    user: string | null | undefined,
    taskIds: string[],
): Promise<AutoWatchAgentResolution> {
    const uniqueTaskIds = Array.from(new Set(
        taskIds.map(taskId => normalizeAutoWatchAgent(taskId)).filter(Boolean),
    ));
    const agentMap = await loadTrajectoryCandidateAgentMap(user, uniqueTaskIds);
    const missingTaskIds = uniqueTaskIds.filter(taskId => !agentMap.has(taskId));
    const distinctAgents = Array.from(new Set(
        uniqueTaskIds
            .map(taskId => agentMap.get(taskId) || '')
            .filter(Boolean),
    ));
    return {
        agent: distinctAgents.length === 1 && missingTaskIds.length === 0 ? distinctAgents[0] || '' : '',
        missingTaskIds,
        distinctAgents,
    };
}

export async function resolveWatchedAgentForRunRows(
    user: string | null | undefined,
    rows: AutoWatchRunRowLike[],
): Promise<string> {
    for (const row of rows) {
        const watchedAgent = normalizeAutoWatchAgent(safeParseAutoWatchRecord(row.rawAnalysisJson).watchedAgent);
        if (watchedAgent && !isEvaluatorAgentName(watchedAgent)) return watchedAgent;
    }

    const resolution = await resolveSingleTrajectoryCandidateAgent(
        user,
        rows.map(row => row.taskId || '').filter(Boolean),
    );
    return resolution.agent;
}
