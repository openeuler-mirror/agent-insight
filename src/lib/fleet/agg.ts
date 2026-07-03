// 舰队大盘 · 共享聚合口径（单一来源，保证 AC-G7 各端点口径一致）。
// 时间窗分桶、分位、成功判定、token/成本口径统一放这里，trends / breakdowns 端点共用。
import { getModelPricing, calculateCost } from '@/lib/shared/model-config';

export type WindowKind = '1d' | '1w' | '1m';
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export interface Plan { gran: 'hour' | 'day'; count: number; step: number }

/** 1d→24 小时桶 / 1w→7 天桶 / 1m→30 天桶（对齐 trend-bucketer.bucketPlan）。 */
export function planOf(w: WindowKind): Plan {
    if (w === '1d') return { gran: 'hour', count: 24, step: HOUR_MS };
    if (w === '1m') return { gran: 'day', count: 30, step: DAY_MS };
    return { gran: 'day', count: 7, step: DAY_MS };
}

export function normalizeWindow(w: string | null): WindowKind {
    return (['1d', '1w', '1m'] as const).includes(w as WindowKind) ? (w as WindowKind) : '1w';
}

/** 桶起点（epoch ms）：锚定「当前小时/当天」向前回溯 count 个桶。 */
export function bucketStarts(now: Date, plan: Plan): number[] {
    const anchor = new Date(now);
    if (plan.gran === 'hour') anchor.setMinutes(0, 0, 0); else anchor.setHours(0, 0, 0, 0);
    const starts: number[] = [];
    for (let i = plan.count - 1; i >= 0; i--) starts.push(anchor.getTime() - i * plan.step);
    return starts;
}

export function bucketLabel(startMs: number, gran: 'hour' | 'day'): string {
    const d = new Date(startMs);
    return gran === 'hour'
        ? `${String(d.getHours()).padStart(2, '0')}:00`
        : `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 最近秩分位（对齐 dashboard/stats 与 trend-bucketer）。 */
export function pct(values: number[], p: number): number {
    if (!values.length) return 0;
    const s = [...values].sort((a, b) => a - b);
    const idx = Math.ceil(s.length * p) - 1;
    return s[Math.max(0, Math.min(s.length - 1, idx))];
}

/** 舰队大盘查询用的 Execution 行（字段按需可选）。 */
export interface FleetRow {
    id?: string;
    taskId?: string | null;
    timestamp: Date;
    latency?: number | null; // 秒（wall-time）
    isAnswerCorrect?: boolean | null;
    toolCallCount?: number | null;
    toolCallErrorCount?: number | null;
    llmCallCount?: number | null;
    failures?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    tokens?: number | null;
    cacheReadInputTokens?: number | null;
    cacheCreationInputTokens?: number | null;
    model?: string | null;
    agentName?: string | null;
    observedAgents?: string | null;
    rootExecutionId?: string | null;
    isSubagent?: boolean | null;
    query?: string | null;
    user?: string | null;
}

/**
 * 硬错误口径成功判定：只看工具错误 + failures。
 * 【刻意不用 isAnswerCorrect】——该字段 schema 默认 false，无法区分「judge 真判错」与「未 judge」，
 * 用它会把成功率系统性打成 ~0。软错误需另接 TraceEvaluation（judge），本层不叠加。
 */
export function isSuccess(e: FleetRow): boolean {
    if (e.toolCallErrorCount != null && e.toolCallErrorCount > 0) return false;
    if (e.failures) {
        try { const f = JSON.parse(e.failures); if (Array.isArray(f) && f.length > 0) return false; } catch { /* ignore */ }
    }
    return true;
}

export function rowTokens(e: FleetRow): { input: number; output: number; total: number } {
    const input = e.inputTokens ?? 0;
    const output = e.outputTokens ?? 0;
    let total = input + output;
    if (total === 0 && e.tokens) total = e.tokens;
    return { input, output, total };
}

/** per-call 单价加权成本（USD）。单价缺失→计入 missing 并按 0 计（口径 0.5 / AC-08-2）。 */
export function rowCost(e: FleetRow, missing: Set<string>): number {
    const model = e.model || '';
    const pr = getModelPricing(model);
    if (!pr) { if (model) missing.add(model); return 0; }
    return calculateCost(
        e.inputTokens ?? 0,
        e.outputTokens ?? 0,
        pr.pricing,
        e.cacheReadInputTokens ?? 0,
        e.cacheCreationInputTokens ?? 0,
    );
}

/** 一条 root trace 参与的 distinct agent 数（编排复杂度用）。 */
export function agentCountOf(e: FleetRow): number {
    if (e.observedAgents) {
        try { const a = JSON.parse(e.observedAgents); if (Array.isArray(a)) return Math.max(1, a.length); } catch { /* ignore */ }
    }
    return 1;
}

/** 分桶：把 rows 落进 starts 定义的桶，返回每桶行数组。 */
export function assignBuckets<T extends FleetRow>(rows: T[], starts: number[], step: number): T[][] {
    return starts.map((start) => {
        const end = start + step;
        return rows.filter((r) => {
            const t = r.timestamp.getTime();
            return t >= start && t < end;
        });
    });
}
