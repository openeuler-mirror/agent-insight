// trace-collector — 圈定分析集合 T（FR-001 / DC-001）。
// 只读已落库字段做投影查询 + join 轨迹 + 解析 JSON；绝不在此触发 judge/轨迹评测（D-001）。

import { prisma } from '@/lib/storage/prisma';
import type { FailureItem, SkillImprovementItem } from '@/lib/engine/evaluation/judge';
import type { TraceLite, TrajectoryLite, ResultMetricKey, ResultMetricLite } from './types';
import { MAX_TRACES } from './config';

export interface CollectInput {
    user: string | null;
    agent: string;
    from: Date;
    to: Date;
    filters?: { skill?: string };
}

export interface CollectResult {
    traces: TraceLite[];
    truncated: boolean;
}

// 投影：仅取聚合所需列（对齐 dashboard/stats 的 select 范式，避免拉大字段）。
const EXEC_SELECT = {
    id: true, taskId: true, query: true, timestamp: true,
    agentName: true, framework: true, model: true,
    isAnswerCorrect: true, answerScore: true, toolCallErrorCount: true, failures: true,
    toolCallCount: true, llmCallCount: true, skillTriggerRate: true, invokedSkills: true,
    tokens: true, cost: true, latency: true, skillIssues: true,
} as const;

// 选中行的形状（prisma 客户端在本仓库返回弱类型，显式标注以避免 implicit-any）。
interface SelectedExecRow {
    id: string;
    taskId: string | null; query: string | null; timestamp: Date;
    agentName: string | null; framework: string | null; model: string | null;
    isAnswerCorrect: boolean | null; answerScore: number | null; toolCallErrorCount: number | null; failures: string | null;
    toolCallCount: number | null; llmCallCount: number | null; skillTriggerRate: number | null; invokedSkills: string | null;
    tokens: number | null; cost: number | null; latency: number | null; skillIssues: string | null;
}

function safeParseArray<T>(json: string | null | undefined): T[] {
    if (!json) return [];
    try {
        const v = JSON.parse(json);
        return Array.isArray(v) ? (v as T[]) : [];
    } catch {
        return [];
    }
}

function parseInvokedSkills(json: string | null | undefined): { name: string; version: number | null }[] {
    const arr = safeParseArray<unknown>(json);
    return arr
        .map((s) => {
            if (typeof s === 'string') return { name: s, version: null };
            const o = (s ?? {}) as { name?: unknown; version?: unknown };
            return { name: String(o.name ?? ''), version: typeof o.version === 'number' ? o.version : null };
        })
        .filter((s) => s.name);
}

/** 解析 TrajectoryEvalResult.dimensionScoresJson → TrajectoryLite。 */
function toTrajectoryLite(row: { trajectoryScore: number | null; dimensionScoresJson: string | null }): TrajectoryLite | null {
    if (row.trajectoryScore == null && !row.dimensionScoresJson) return null;
    let dims: TrajectoryLite['dims'] = { toolChoice: 0, redundancy: 0 };
    try {
        const d = row.dimensionScoresJson ? JSON.parse(row.dimensionScoresJson) : {};
        dims = {
            completeness: typeof d.completeness === 'number' ? d.completeness : null,
            toolChoice: typeof d.toolChoice === 'number' ? d.toolChoice : 0,
            redundancy: typeof d.redundancy === 'number' ? d.redundancy : 0,
            attribution: typeof d.attribution === 'number' ? d.attribution : null,
        };
    } catch { /* ignore，保留默认 */ }
    return { score: row.trajectoryScore ?? 0, dims };
}

/**
 * collectTraces — 按 (agentName + isSubagent=false + timestamp∈[from,to] + {user}OR{null} + skill) 投影取回 T，
 * join TrajectoryEvalResult（按 executionId），解析 failures/skillIssues。
 */
export async function collectTraces(input: CollectInput): Promise<CollectResult> {
    const { user, agent, from, to, filters } = input;

    const where = {
        agentName: agent,
        isSubagent: false,                       // 强制只取 root（BR / 安全作用域）
        timestamp: { gte: from, lte: to },
        ...(user ? { OR: [{ user }, { user: null }] } : {}), // 用户作用域（对齐 listObservedAgentNames）
        ...(filters?.skill ? { skill: filters.skill } : {}),
    };

    const rows = await prisma.execution.findMany({
        where,
        select: EXEC_SELECT,
        orderBy: { timestamp: 'desc' },
        take: MAX_TRACES + 1,                    // 多取 1 条用于探测是否截断
    });

    const truncated = rows.length > MAX_TRACES;
    const sliced: SelectedExecRow[] = (truncated ? rows.slice(0, MAX_TRACES) : rows) as SelectedExecRow[];

    // join 轨迹评测（独立表，1:1 by executionId）
    const ids = sliced.map((r) => r.id).filter(Boolean);
    const trajByExec = new Map<string, TrajectoryLite>();
    const resultByExec = new Map<string, Partial<Record<ResultMetricKey, ResultMetricLite>>>();
    if (ids.length) {
        try {
            const trajRows = await prisma.trajectoryEvalResult.findMany({
                where: { executionId: { in: ids }, status: 'done' },
                select: { executionId: true, trajectoryScore: true, dimensionScoresJson: true },
                orderBy: { createdAt: 'desc' },
            });
            for (const tr of trajRows) {
                if (!tr.executionId || trajByExec.has(tr.executionId)) continue; // 取最新一条
                const lite = toTrajectoryLite(tr);
                if (lite) trajByExec.set(tr.executionId, lite);
            }
        } catch (e) {
            console.warn('[quality] trajectory join failed, falling back to deterministic-only:', e);
        }
    }

    if (ids.length) {
        try {
            const evalRows = await prisma.traceEvaluation.findMany({
                where: { executionId: { in: ids }, evaluatorId: 'result-quality' },
                select: { executionId: true, metricKey: true, status: true, evaluatorVersion: true, interactionsHash: true, score: true, method: true, confidence: true, evidenceJson: true, note: true, errorMessage: true },
            });
            const keyMap: Record<string, ResultMetricKey> = {
                faithfulness: 'faithfulness',
                'instruction-adherence': 'instructionAdherence',
                'answer-quality': 'answerQuality',
                accuracy: 'accuracy',
            };
            for (const row of evalRows) {
                const key = keyMap[row.metricKey];
                if (!key) continue;
                let evidence: Record<string, unknown> | undefined;
                try { evidence = row.evidenceJson ? JSON.parse(row.evidenceJson) : undefined; } catch { /* ignore */ }
                const current = resultByExec.get(row.executionId) ?? {};
                current[key] = {
                    key,
                    status: row.status as ResultMetricLite['status'],
                    evaluatorVersion: row.evaluatorVersion,
                    inputHash: row.interactionsHash,
                    score: row.score,
                    method: row.method,
                    confidence: row.confidence,
                    evidence,
                    note: row.note ?? undefined,
                    errorMessage: row.errorMessage ?? undefined,
                };
                resultByExec.set(row.executionId, current);
            }
        } catch (e) {
            console.warn('[quality] result evaluation join failed:', e);
        }
    }

    const traces: TraceLite[] = sliced.map((r) => {
        const toolCallCount = r.toolCallCount ?? undefined;
        const llmCallCount = r.llmCallCount ?? undefined;
        return {
            executionId: r.id,
            taskId: r.taskId ?? undefined,
            ts: r.timestamp,
            agentName: r.agentName ?? undefined,
            framework: r.framework ?? undefined,
            model: r.model ?? undefined,
            query: r.query ?? undefined,
            isAnswerCorrect: r.isAnswerCorrect,
            answerScore: r.answerScore,
            resultMetrics: resultByExec.get(r.id),
            toolCallErrorCount: r.toolCallErrorCount ?? undefined,
            failures: safeParseArray<FailureItem>(r.failures),
            toolCallCount,
            llmCallCount,
            stepCount: (toolCallCount != null || llmCallCount != null)
                ? (toolCallCount ?? 0) + (llmCallCount ?? 0)
                : undefined,
            trajectory: trajByExec.get(r.id) ?? null,
            skillTriggerRate: r.skillTriggerRate,
            invokedSkills: parseInvokedSkills(r.invokedSkills),
            tokens: r.tokens ?? undefined,
            cost: r.cost ?? undefined,
            latency: r.latency ?? undefined,
            skillIssues: safeParseArray<SkillImprovementItem>(r.skillIssues),
        };
    });

    return { traces, truncated };
}
