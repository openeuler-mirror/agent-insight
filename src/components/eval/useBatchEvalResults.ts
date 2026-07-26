'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/client/api';

export interface BatchEvalResultMeta {
    resultId?: string;
    caseId?: string;
    taskId?: string;
    /** 评估器自己跑出来的那条 trace (评估 session id) —— 跳链路追踪看评测器怎么判的。
     * 兼容旧用法：= 轨迹评估器 session（优先），无则结果评估器 session。 */
    evaluationTraceId?: string;
    /** 结果评估器(任务完成度) 的评估 session —— 「结果分」怎么判的 */
    resultEvalTraceId?: string;
    /** 轨迹评估器(轨迹质量) 的评估 session —— 「轨迹分」怎么判的 */
    trajEvalTraceId?: string;
    datasetId?: string;
    status?: string;
    /** 结果分 (任务完成度评估器), 已 ×100 转 0-100 */
    resultScore?: number | null;
    /** 轨迹分 (轨迹质量评估器), 已 ×100 转 0-100 */
    trajScore?: number | null;
    errorMessage?: string;
}

const EMPTY_RESULT_MAP = new Map<string, BatchEvalResultMeta>();

/**
 * 拉某个评测任务(批次, evaluatorRunId)下所有评测记录, 建 taskId → 元信息 的 map。
 * 用例分析 ② 评测执行表用它给每行补"评估 Trace / datasetId"等 displayedTraces / caseStates 里没有的字段。
 * pollMs > 0 时定时刷新 (评测异步完成后 evaluatorSessionId 才落库)。
 */
export function useBatchEvalResults(
    user: string | null | undefined,
    evaluatorRunId: string | undefined,
    pollMs = 0,
    options?: { latestByCase?: boolean },
): Map<string, BatchEvalResultMeta> {
    const latestByCase = options?.latestByCase !== false;
    const scopeKey = user && evaluatorRunId ? `${user}\u0000${evaluatorRunId}\u0000${latestByCase ? 'latest' : 'all'}` : '';
    const [result, setResult] = useState<{ scopeKey: string; map: Map<string, BatchEvalResultMeta> }>({
        scopeKey: '',
        map: new Map(),
    });
    useEffect(() => {
        if (!user || !evaluatorRunId) return;
        let cancelled = false;
        let requestSequence = 0;
        const load = async () => {
            const currentSequence = ++requestSequence;
            try {
                const latestParam = latestByCase ? '&latestByCase=1' : '';
                // 评测走实验后，runId = experimentId，读实验侧 eval-results（形状与旧 trajectory/results 对齐）
                const res = await apiFetch(`/api/experiments/eval-results?user=${encodeURIComponent(user)}&runId=${encodeURIComponent(evaluatorRunId)}${latestParam}&limit=500`);
                const data = await res.json();
                const rows = Array.isArray(data?.results) ? data.results : [];
                const m = new Map<string, BatchEvalResultMeta>();
                for (const r of rows) {
                    const row = (r && typeof r === 'object') ? r as Record<string, unknown> : {};
                    const key = row.taskId || row.executionId;
                    if (!key || row.watchPlaceholder || row.placeholderOnly) continue;
                    if (m.has(String(key))) continue;
                    const raw = (row.rawAnalysis && typeof row.rawAnalysis === 'object') ? row.rawAnalysis as Record<string, unknown> : {};
                    const resultEvaluation = (raw.resultEvaluation && typeof raw.resultEvaluation === 'object')
                        ? raw.resultEvaluation as Record<string, unknown>
                        : {};
                    // raw.evaluatorSessionId = 轨迹质量评估器 session；resultEvaluation.evaluatorSessionId = 结果评估器 session。
                    const trajEvalTraceId = (typeof raw.evaluatorSessionId === 'string' && raw.evaluatorSessionId.trim())
                        ? raw.evaluatorSessionId.trim() : '';
                    const resultEvalTraceId = (typeof resultEvaluation.evaluatorSessionId === 'string' && resultEvaluation.evaluatorSessionId.trim())
                        ? resultEvaluation.evaluatorSessionId.trim() : '';
                    const evalTrace = trajEvalTraceId || resultEvalTraceId || '';
                    m.set(String(key), {
                        resultId: typeof row.id === 'string' ? row.id : undefined,
                        caseId: typeof row.caseId === 'string' ? row.caseId : undefined,
                        taskId: String(key),
                        evaluationTraceId: evalTrace || undefined,
                        resultEvalTraceId: resultEvalTraceId || undefined,
                        trajEvalTraceId: trajEvalTraceId || undefined,
                        datasetId: typeof row.datasetId === 'string' ? row.datasetId : undefined,
                        status: typeof row.status === 'string' ? row.status : undefined,
                        // trajectoryScore / resultEvaluationScore 后端为 0-1, 这里 ×100 转 0-100 与 trace 模式口径一致。
                        resultScore: typeof row.resultEvaluationScore === 'number' ? Math.round(row.resultEvaluationScore * 100) : null,
                        trajScore: typeof row.trajectoryScore === 'number' ? Math.round(row.trajectoryScore * 100) : null,
                        errorMessage: typeof row.errorMessage === 'string' ? row.errorMessage : undefined,
                    });
                }
                if (!cancelled && currentSequence === requestSequence) setResult({ scopeKey, map: m });
            } catch {/* 拉取失败不阻塞表格主流程 */}
        };
        load();
        if (pollMs > 0) {
            const t = setInterval(load, pollMs);
            return () => { cancelled = true; clearInterval(t); };
        }
        return () => { cancelled = true; };
    }, [user, evaluatorRunId, pollMs, scopeKey, latestByCase]);
    return result.scopeKey === scopeKey ? result.map : EMPTY_RESULT_MAP;
}
