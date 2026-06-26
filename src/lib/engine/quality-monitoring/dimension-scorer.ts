// dimension-scorer — 四维评分 + P0/P1/P2 加权综合分 + 绝对状态（FR-002~007 / BR-001/004/005/010）。
// 纯函数，可单测。覆盖率优先、确定性打底；占比型 N/A 不入分母（BR-005）；
// 安全 0 容忍触发综合分封顶降级（BR-004）；状态纯绝对阈值，无任何百分位/同类（BR-006）。

import type {
    TraceLite, ScoringPolicy, DimScore, CompositeScore, MetricScore, QualityStatus, Priority,
} from './types';
import { METRIC_REGISTRY, type MetricKey } from './config';

export interface ErrorSummaryForScore {
    errorEventCount: number;   // 错误事件总数
    errorTraceCount: number;   // 命中错误的 trace 数
    clusterCount: number;      // 错误簇数
}

export interface ScoreResult {
    composite: CompositeScore;
    dimensions: { result: DimScore; process: DimScore; cost: DimScore; error: DimScore };
    coverage: { judged: number; total: number; perDimension: Record<string, number> };
}

function clamp01(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}
function round1(n: number): number { return Math.round(n * 10) / 10; }
function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }

const SECURITY_PATTERNS = /(inject|injection|越权|未授权|unauthorized|越界|pii|敏感信息|泄露|leak|prompt\s*injection|jailbreak)/i;
/** 安全护栏命中检测（双侧）。MVP 启发式：扫 failures 文本 + 已置 safety 位（FR-003）。 */
function detectSecurityHit(t: TraceLite): boolean {
    if (t.safety === 0) return true;
    for (const f of t.failures ?? []) {
        const blob = `${f.failure_type ?? ''} ${f.description ?? ''} ${f.context ?? ''}`;
        if (SECURITY_PATTERNS.test(blob)) return true;
    }
    return false;
}

function statusOf(score: number, policy: ScoringPolicy): QualityStatus {
    if (score >= policy.status.达标) return '达标';
    if (score >= policy.status.关注) return '关注';
    return '异常';
}

// ── 逐 trace 指标取值（null = N/A，不入分母） ────────────────────────────────
type PerTrace = (t: TraceLite, policy: ScoringPolicy) => number | null;

const EXTRACTORS: Record<MetricKey, PerTrace> = {
    faithfulness: (t) => t.resultMetrics?.faithfulness?.status === 'done' ? t.resultMetrics.faithfulness.score : null,
    instructionAdherence: (t) => t.resultMetrics?.instructionAdherence?.status === 'done' ? t.resultMetrics.instructionAdherence.score : null,
    answerQuality: (t) => t.resultMetrics?.answerQuality?.status === 'done' ? t.resultMetrics.answerQuality.score : null,
    accuracy: (t) => t.resultMetrics?.accuracy?.status === 'done' ? t.resultMetrics.accuracy.score : null,
    safety: (t) => (detectSecurityHit(t) ? 0 : 100),
    toolCorrectness: (t) => {
        const calls = t.toolCallCount ?? 0;
        if (calls <= 0) return null;                                   // 无工具调用 → N/A
        const errs = t.toolCallErrorCount ?? 0;
        return clamp01(1 - errs / calls) * 100;
    },
    cost: (t, policy) => {
        // 成本归一为「未超预算程度」：worstRatio 越接近 1 越烧钱 → 分越低。
        const budget = policy.costBudget;
        const ratios: number[] = [];
        if (t.latency != null) ratios.push(t.latency / budget.latencyMs);
        if (t.tokens != null) ratios.push(t.tokens / budget.tokens);
        if (t.stepCount != null) ratios.push(t.stepCount / budget.steps);
        if (!ratios.length) return null;
        return clamp01(1 - Math.max(...ratios)) * 100;
    },
    planEfficiency: (t) => {
        if (!t.trajectory) return null;                                // 依赖轨迹 join
        const parts: number[] = [clamp01(t.trajectory.dims.redundancy)];
        if (t.trajectory.dims.completeness != null) parts.push(clamp01(t.trajectory.dims.completeness));
        return mean(parts) * 100;
    },
    constraintAdherence: (t) => {
        // MVP：Skill 遵从（条件触发 — 仅在有 invokedSkills 的有效样本上算，BR-005）；
        // System-prompt 全量层与两层细分留待 FR-012 第二阶段。
        const invoked = t.invokedSkills?.length ?? 0;
        if (invoked === 0 || t.skillTriggerRate == null) return null;  // 未触发 skill → N/A，不入分母
        return clamp01(t.skillTriggerRate) * 100;
    },
    toolGrounding: (t) => {
        const a = t.trajectory?.dims.attribution;
        if (a == null) return null;                                    // 多数 MVP 样本 N/A，覆盖率标注
        return clamp01(a) * 100;
    },
};

function scoreMetric(key: MetricKey, traces: TraceLite[], policy: ScoringPolicy): MetricScore {
    const reg = METRIC_REGISTRY[key];
    const vals: number[] = [];
    for (const t of traces) {
        const v = EXTRACTORS[key](t, policy);
        if (v != null) vals.push(v);
    }
    const n = vals.length;
    const total = traces.length || 1;
    const resultRows = traces
        .map((t) => t.resultMetrics?.[key as keyof typeof t.resultMetrics])
        .filter((row): row is NonNullable<typeof row> => Boolean(row?.status === 'done'));
    const methods = new Map<string, number>();
    for (const row of resultRows) methods.set(row.method, (methods.get(row.method) ?? 0) + 1);
    const confidences = resultRows.map((row) => row.confidence).filter(Number.isFinite);
    const evidence = traces.flatMap((t) => {
        const row = t.resultMetrics?.[key as keyof typeof t.resultMetrics];
        if (!row?.evidence) return [];
        const reason = String(row.evidence.reason ?? row.note ?? '').trim();
        return reason ? [{
            executionId: t.executionId,
            reason,
            score: row.score,
            confidence: row.confidence,
            detail: row.evidence,
        }] : [];
    }).slice(0, 3);
    const naReason = n === 0
        ? traces.map((t) => t.resultMetrics?.[key as keyof typeof t.resultMetrics]?.note).find(Boolean)
        : undefined;
    return {
        key,
        label: reg.label,
        priority: reg.priority,
        score: n ? round1(mean(vals)) : null,
        coverage: round1(n / total) ,
        n,
        confidence: confidences.length ? round1(mean(confidences)) : undefined,
        methodBreakdown: Object.fromEntries(methods),
        naReason,
        evidence,
    };
}

function dimFrom(metrics: MetricScore[], policy: ScoringPolicy, signalFn?: (m: MetricScore[]) => string): DimScore {
    const scored = metrics.filter((m) => m.score != null);
    const score = scored.length ? round1(mean(scored.map((m) => m.score as number))) : 0;
    const n = Math.max(0, ...metrics.map((m) => m.n));
    const coverage = metrics.length ? round1(mean(metrics.map((m) => m.coverage))) : 0;
    return {
        score,
        status: statusOf(score, policy),
        coverage,
        n,
        signal: signalFn?.(metrics),
        metrics,
    };
}

function tierScore(metrics: MetricScore[], priority: Priority): number | null {
    const scored = metrics.filter((m) => m.priority === priority && m.score != null);
    return scored.length ? round1(mean(scored.map((m) => m.score as number))) : null;
}

/**
 * scoreDimensions — 在 T 上聚合四维分 + 综合分 + 绝对状态。
 * @param errorSummary 来自 problem-summary（错误维由其反哺，编排序：problem 先于 score）。
 */
export function scoreDimensions(
    traces: TraceLite[],
    policy: ScoringPolicy,
    errorSummary: ErrorSummaryForScore,
): ScoreResult {
    const total = traces.length;

    // 逐指标
    const m = Object.fromEntries(
        (Object.keys(METRIC_REGISTRY) as MetricKey[]).map((k) => [k, scoreMetric(k, traces, policy)]),
    ) as Record<MetricKey, MetricScore>;

    // 给「约束遵循」补条件触发口径注释
    if (m.constraintAdherence.n > 0) {
        m.constraintAdherence.note = `条件触发 · ${m.constraintAdherence.n}/${total}`;
    } else {
        m.constraintAdherence.note = 'N/A · 窗口内无 skill 触发';
    }

    // 四维
    const result = dimFrom([m.faithfulness, m.instructionAdherence, m.answerQuality, m.accuracy], policy, (mm) => {
        const valid = mm.filter((x) => x.score != null).sort((a, b) => (a.score as number) - (b.score as number));
        if (!valid.length) return '尚无结果评测覆盖';
        return valid[0].score! < policy.status.达标
            ? `${valid[0].label} ${round1(valid[0].score!)} 是结果维主要短板`
            : '四项结果指标整体稳健';
    });
    const process = dimFrom([m.toolCorrectness, m.planEfficiency, m.constraintAdherence, m.toolGrounding], policy);
    const cost = dimFrom([m.cost], policy, () => '成本须看 p95 长尾，详见趋势');

    // 错误维：由问题汇总反哺（错误密度），信息性维度，不计入综合分加权（避免与安全/工具重复计权）。
    const errorTraceRatio = total ? clamp01(errorSummary.errorTraceCount / total) : 0;
    const errorScore = round1((1 - errorTraceRatio) * 100);
    const error: DimScore = {
        score: errorScore,
        status: statusOf(errorScore, policy),
        coverage: 1,
        n: total,
        signal: errorSummary.errorEventCount
            ? `报错 ${errorSummary.errorEventCount} 次 · 聚为 ${errorSummary.clusterCount} 类`
            : '窗口内无报错事件',
    };

    // ── 综合分：P0/P1/P2 加权 + 安全 0 容忍封顶降级（BR-004/010） ─────────────
    const p0 = tierScore(Object.values(m), 'P0');
    const p1 = tierScore(Object.values(m), 'P1');
    const p2 = tierScore(Object.values(m), 'P2'); // MVP 恒 null

    const tiers: { w: number; v: number }[] = [];
    if (p0 != null) tiers.push({ w: policy.weights.P0, v: p0 });
    if (p1 != null) tiers.push({ w: policy.weights.P1, v: p1 });
    if (p2 != null) tiers.push({ w: policy.weights.P2, v: p2 });
    const wSum = tiers.reduce((s, x) => s + x.w, 0) || 1;
    let composite = round1(tiers.reduce((s, x) => s + x.w * x.v, 0) / wSum);

    // P0 硬阈值命中（安全护栏）→ 封顶降级标红
    const safetyHit = traces.some((t) => detectSecurityHit(t));
    let capped = false;
    let cappedReason: string | undefined;
    if (safetyHit) {
        capped = true;
        cappedReason = '安全护栏命中（注入/越权/PII），综合分硬降级';
        composite = Math.min(composite, policy.status.关注 - 1); // 强制落入「异常」区间
    }

    const status: QualityStatus = capped ? '异常' : statusOf(composite, policy);

    // 覆盖率：judged = 至少有一项有效结果评测的 trace 数。
    const judged = traces.filter((t) => Object.values(t.resultMetrics ?? {}).some((r) => r?.status === 'done' && r.score != null)).length;

    return {
        composite: { score: composite, status, p0, p1, p2, capped, cappedReason },
        dimensions: { result, process, cost, error },
        coverage: {
            judged,
            total,
            perDimension: {
                result: result.coverage,
                process: process.coverage,
                cost: cost.coverage,
                error: error.coverage,
            },
        },
    };
}
