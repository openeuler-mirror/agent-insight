'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/client/api';

export interface BatchEvalResultMeta {
    /** 评估器自己跑出来的那条 trace (评估 session id) —— 跳链路追踪看评测器怎么判的 */
    evaluationTraceId?: string;
    datasetId?: string;
    status?: string;
    /** 结果分 (任务完成度评估器), 已 ×100 转 0-100 */
    resultScore?: number | null;
    /** 轨迹分 (轨迹质量评估器), 已 ×100 转 0-100 */
    trajScore?: number | null;
}

/**
 * 拉某个评测任务(批次, evaluatorRunId)下所有评测记录, 建 taskId → 元信息 的 map。
 * 用例分析 ② 评测执行表用它给每行补"评估 Trace / datasetId"等 displayedTraces / caseStates 里没有的字段。
 * pollMs > 0 时定时刷新 (评测异步完成后 evaluatorSessionId 才落库)。
 */
export function useBatchEvalResults(
    user: string | null | undefined,
    evaluatorRunId: string | undefined,
    pollMs = 0,
): Map<string, BatchEvalResultMeta> {
    const [map, setMap] = useState<Map<string, BatchEvalResultMeta>>(new Map());
    useEffect(() => {
        if (!user || !evaluatorRunId) { setMap(new Map()); return; }
        let cancelled = false;
        const load = async () => {
            try {
                const res = await apiFetch(`/api/eval/trajectory/results?user=${encodeURIComponent(user)}&runId=${encodeURIComponent(evaluatorRunId)}`);
                const data = await res.json();
                const rows: any[] = data?.results || [];
                const m = new Map<string, BatchEvalResultMeta>();
                for (const r of rows) {
                    const key = r.taskId || r.executionId;
                    if (!key) continue;
                    const raw = (r.rawAnalysis && typeof r.rawAnalysis === 'object') ? r.rawAnalysis : {};
                    const resultEvaluation = (raw.resultEvaluation && typeof raw.resultEvaluation === 'object') ? raw.resultEvaluation : {};
                    const evalTrace = (typeof raw.evaluatorSessionId === 'string' && raw.evaluatorSessionId.trim())
                        ? raw.evaluatorSessionId.trim()
                        : (typeof resultEvaluation.evaluatorSessionId === 'string' && resultEvaluation.evaluatorSessionId.trim())
                            ? resultEvaluation.evaluatorSessionId.trim()
                            : '';
                    m.set(String(key), {
                        evaluationTraceId: evalTrace || undefined,
                        datasetId: r.datasetId || undefined,
                        status: r.status,
                        // trajectoryScore / resultEvaluationScore 后端为 0-1, 这里 ×100 转 0-100 与 trace 模式口径一致。
                        resultScore: typeof r.resultEvaluationScore === 'number' ? Math.round(r.resultEvaluationScore * 100) : null,
                        trajScore: typeof r.trajectoryScore === 'number' ? Math.round(r.trajectoryScore * 100) : null,
                    });
                }
                if (!cancelled) setMap(m);
            } catch {/* 拉取失败不阻塞表格主流程 */}
        };
        load();
        if (pollMs > 0) {
            const t = setInterval(load, pollMs);
            return () => { cancelled = true; clearInterval(t); };
        }
        return () => { cancelled = true; };
    }, [user, evaluatorRunId, pollMs]);
    return map;
}
