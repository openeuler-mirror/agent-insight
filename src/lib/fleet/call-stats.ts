// 大盘 B 档 · Execution.callStats 预解析摘要。
// 写入路径（saveExecutionRecord）对内存中的 interactions 做一次 O(n) 遍历，产出
// 固定体积、可跨 trace 合并的统计摘要——per-call 原始数组刻意不存（体积随 trace
// 线性膨胀，会把大 JSON 问题从 Session 搬到 Execution）。
// 设计决策与风险边界见 docs/design/fleet-dashboard-tier-b-preparse-risk.md。

export const CALL_STATS_VERSION = 1;

/** interactions 条数护栏：超过只统计前 MAX_ITEMS 条并置 truncated（防超大 trace 拖垮写入路径）。 */
export const MAX_ITEMS = 10_000;
/** 键基数护栏：超出并入 __other（防异常模型/工具名打爆摘要体积）。 */
export const MAX_MODELS = 30;
export const MAX_TOOLS = 50;
export const OTHER_KEY = '__other';
/** 无法归属模型名时的键（框架未带 model 字段且无 Execution.model 兜底）。 */
export const UNKNOWN_KEY = '__unknown';

/** 单次调用耗时合法区间：≤0 或超 24h 视为脏时间戳，计入 unkN 不进直方图。 */
const MAX_SANE_DUR_MS = 24 * 3600 * 1000;

function logEdges(baseMs: number, count: number): number[] {
    const edges: number[] = [];
    for (let i = 0; i < count; i++) edges.push(baseMs * 2 ** i);
    return edges;
}

/** 对数桶上边界（ms）。hist 长度 = edges.length + 1，最后一桶为 +∞。 */
export const LLM_BUCKET_EDGES = logEdges(100, 19);  // 100ms ~ 7.3h，20 桶
export const TOOL_BUCKET_EDGES = logEdges(50, 11);  // 50ms ~ 51.2s，12 桶

export interface CallBucketStat {
    n: number;      // 有效计次（含 unkN；直方图只含 n - unkN 次）
    errN: number;   // state=error/failed 的次数
    unkN: number;   // 该框架无耗时字段/时间戳脏 → 不进直方图的次数
    sumMs: number;  // 有效耗时总和（均值 = sumMs ÷ (n - unkN)，精确）
    hist: number[]; // 对数桶计数，可跨 trace 逐位相加合并
}

export interface CallStats {
    v: number;
    steps: number;              // interactions 轮次（含 user/assistant/tool 各类条目）
    truncated?: boolean;
    llm: Record<string, CallBucketStat>;   // 键=模型名
    tool: Record<string, CallBucketStat>;  // 键=真实工具名
    errTypes: Record<string, number>;      // 失败原因：工具错误走规则归类；judge failures 以 judge: 前缀原样计数
}

// ── 失败原因规则表（顺序即优先级；集中一处便于单测钉住与迭代）────────────────
const ERROR_RULES: [string, RegExp][] = [
    ['限流', /\b429\b|rate.?limit|too many requests/i],
    ['超时', /timeout|timed out|etimedout|deadline exceeded|超时/i],
    ['上下文超限', /context.{0,24}(length|window|limit)|maximum.{0,12}tokens|prompt is too long|上下文超/i],
    ['权限拒绝', /permission denied|eacces|eperm|unauthorized|forbidden|\b401\b|\b403\b|权限/i],
    ['网络/连接', /econnrefused|econnreset|enotfound|ehostunreach|epipe|socket hang|network|connection (refused|reset|closed)|fetch failed/i],
    ['参数校验', /invalid (argument|param|input)|validation (error|failed)|missing required|schema mismatch|参数(错误|校验)/i],
    ['命令非零退出', /exit(ed)? (with )?code [1-9]|non-zero exit|command failed|退出码/i],
];

export function classifyToolError(text: string): string {
    for (const [label, re] of ERROR_RULES) if (re.test(text)) return label;
    return '其他';
}

// ── 时间解析（兼容 epoch ms 与 ISO 字符串两种格式）──────────────────────────
function msOf(v: unknown): number | null {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
        const t = Date.parse(v);
        return Number.isFinite(t) ? t : null;
    }
    return null;
}

function spanMs(start: unknown, end: unknown): number | null {
    const s = msOf(start), e = msOf(end);
    if (s == null || e == null) return null;
    const d = e - s;
    return d > 0 && d <= MAX_SANE_DUR_MS ? d : null;
}

function bucketOf(edges: number[], ms: number): number {
    for (let i = 0; i < edges.length; i++) if (ms < edges[i]) return i;
    return edges.length;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

function getStat(map: Record<string, CallBucketStat>, key: string, cap: number, edges: number[]): CallBucketStat {
    let k = key;
    if (!map[k] && Object.keys(map).length >= cap) k = OTHER_KEY;
    if (!map[k]) map[k] = { n: 0, errN: 0, unkN: 0, sumMs: 0, hist: new Array(edges.length + 1).fill(0) };
    return map[k];
}

function record(stat: CallBucketStat, durMs: number | null, isErr: boolean, edges: number[]): void {
    stat.n++;
    if (isErr) stat.errN++;
    if (durMs == null) { stat.unkN++; return; }
    stat.sumMs += durMs;
    stat.hist[bucketOf(edges, durMs)]++;
}

const ERR_STATES = new Set(['error', 'failed', 'failure']);

/**
 * 对已在内存中的 interactions 对象数组做单遍遍历，产出 callStats 摘要。
 * 纯函数、全量重算幂等；不做排序/递归/深拷贝。抛错由调用方兜（写入路径降级 null）。
 *
 * 字段兼容性（按真实库多框架样本考证）：
 *  - 模型调用 = role==='assistant' 条目；耗时 timeInfo.{created,completed}（opencode/jiuwen 为
 *    epoch ms、langfuse 为 ISO）或数值 latency 兜底；模型名 modelID/model，缺失回退 fallbackModel。
 *  - 工具调用 = 条目上的 tool_calls/toolCalls 数组；耗时 duration_ms（claude-otel）或
 *    timing.{started_at,completed_at}；名字 function.name/name；state error/failed 记失败。
 *  - 无耗时字段的框架计 unkN（端点据此输出覆盖率，不静默偏差）。
 */
export function computeCallStats(
    interactions: unknown[],
    opts?: { fallbackModel?: string | null; failures?: string | null },
): CallStats {
    const stats: CallStats = { v: CALL_STATS_VERSION, steps: 0, llm: {}, tool: {}, errTypes: {} };
    if (!Array.isArray(interactions)) return stats;

    stats.steps = interactions.length;
    let items = interactions;
    if (items.length > MAX_ITEMS) { items = items.slice(0, MAX_ITEMS); stats.truncated = true; }

    for (const raw of items) {
        if (!raw || typeof raw !== 'object') continue;
        const item = raw as any;

        // 模型调用
        if (item.role === 'assistant') {
            const model = (typeof item.modelID === 'string' && item.modelID)
                || (typeof item.model === 'string' && item.model)
                || opts?.fallbackModel || UNKNOWN_KEY;
            const ti = item.timeInfo;
            let dur = ti ? spanMs(ti.created, ti.completed) : null;
            if (dur == null && typeof item.latency === 'number' && item.latency > 0 && item.latency <= MAX_SANE_DUR_MS) {
                dur = item.latency;
            }
            record(getStat(stats.llm, String(model), MAX_MODELS, LLM_BUCKET_EDGES), dur, false, LLM_BUCKET_EDGES);
        }

        // 工具调用（挂在条目上的数组；键风格分框架）
        const toolCalls = Array.isArray(item.tool_calls) ? item.tool_calls
            : Array.isArray(item.toolCalls) ? item.toolCalls : null;
        if (toolCalls) {
            for (const tRaw of toolCalls) {
                if (!tRaw || typeof tRaw !== 'object') continue;
                const t = tRaw as any;
                const name = (t.function && typeof t.function.name === 'string' && t.function.name)
                    || (typeof t.name === 'string' && t.name) || UNKNOWN_KEY;
                const isErr = ERR_STATES.has(String(t.state ?? '').toLowerCase());
                let dur: number | null = null;
                if (typeof t.duration_ms === 'number' && t.duration_ms > 0 && t.duration_ms <= MAX_SANE_DUR_MS) {
                    dur = t.duration_ms;
                } else if (t.timing) {
                    dur = spanMs(t.timing.started_at, t.timing.completed_at);
                }
                record(getStat(stats.tool, String(name), MAX_TOOLS, TOOL_BUCKET_EDGES), dur, isErr, TOOL_BUCKET_EDGES);
                if (isErr) {
                    const text = [t.error_type, t.error].filter((x: unknown) => typeof x === 'string').join(' ');
                    const label = classifyToolError(text);
                    stats.errTypes[label] = (stats.errTypes[label] ?? 0) + 1;
                }
            }
        }
    }

    // judge 慢路径的 trace 级失败：failure_type 已是分类枚举，加 judge: 前缀原样计数
    // （与工具硬错误来源不同、口径不同，前端分组展示，不混同）。
    if (opts?.failures) {
        try {
            const fs = JSON.parse(opts.failures);
            if (Array.isArray(fs)) {
                for (const f of fs) {
                    const ft = f && typeof f === 'object' && typeof (f as any).failure_type === 'string'
                        ? (f as any).failure_type : '未分类';
                    const key = `judge:${ft}`;
                    stats.errTypes[key] = (stats.errTypes[key] ?? 0) + 1;
                }
            }
        } catch { /* failures 非法 JSON：忽略，不影响其余统计 */ }
    }

    return stats;
}

// ── 查询侧 helper（端点合并多行摘要用）────────────────────────────────────────

/** 直方图逐位相加（就地累加到 acc）。 */
export function mergeHist(acc: number[], add: number[]): void {
    for (let i = 0; i < acc.length && i < add.length; i++) acc[i] += add[i];
}

/**
 * 从合并后的对数桶直方图估算分位数（桶内线性插值，返回 ms）。
 * 误差 ≤ 所在桶宽；空直方图返回 null。前端展示需注明「直方图估算」。
 */
export function histPercentile(hist: number[], edges: number[], p: number): number | null {
    const total = hist.reduce((s, x) => s + x, 0);
    if (total <= 0) return null;
    const target = total * p;
    let cum = 0;
    for (let i = 0; i < hist.length; i++) {
        if (hist[i] === 0) continue;
        const lo = i === 0 ? 0 : edges[i - 1];
        // 最后一桶（+∞）没有上界：取下界（保守估计，不虚构尾部）
        const hi = i < edges.length ? edges[i] : lo;
        if (cum + hist[i] >= target) {
            const frac = hist[i] ? (target - cum) / hist[i] : 0;
            return Math.round(lo + (hi - lo) * Math.max(0, Math.min(1, frac)));
        }
        cum += hist[i];
    }
    return null;
}

/** 解析 callStats 列：null/非法/版本不符/哨兵失败标记 → null。 */
export function parseCallStats(raw: string | null | undefined): CallStats | null {
    if (!raw) return null;
    try {
        const d = JSON.parse(raw);
        if (!d || typeof d !== 'object' || d.v !== CALL_STATS_VERSION || (d as any).err) return null;
        if (typeof d.steps !== 'number' || !d.llm || !d.tool) return null;
        return d as CallStats;
    } catch { return null; }
}
