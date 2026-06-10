// sampling — 采样异步回填（NFR-001）。与请求路径完全解耦：选未评测子集 → 限流后台评测 → 写回 DB。
// 评测器可注入（便于单测 mock）；默认评测器对 judge/轨迹做最小可用回填，失败隔离、不抛到调用方。

import { prisma } from '@/lib/storage/prisma';
import { withBackgroundOpencodeSlot } from '@/lib/engine/general-agent/concurrency-limiter';
import type { ScoringPolicy, WindowKind } from './types';
import { DEFAULT_POLICY } from './config';
import { collectTraces } from './trace-collector';
import { resolveWindowRange } from './index';

export interface BackfillResult {
    accepted: boolean;
    selected: number;
    evaluated: number;
    failed: number;
    coverageDelta: number; // 评测覆盖率提升估计（0–1）
}

/** 单条 trace 的回填评测结果；返回 null 表示本条跳过（不写回）。 */
export interface TraceEvalResult {
    answerScore?: number | null; // 0–1
}

export type TraceEvaluator = (trace: { executionId: string; taskId?: string; query?: string; user: string | null }) => Promise<TraceEvalResult | null>;

export interface BackfillInput {
    user: string | null;
    agent: string;
    window: WindowKind;
    from?: string | null;
    to?: string | null;
    budget?: number;
    /** 注入评测器（单测用 mock）；缺省走 defaultEvaluator。 */
    evaluator?: TraceEvaluator;
    signal?: AbortSignal;
    /** 当前时间（注入以便测试；默认 new Date()）。 */
    now?: Date;
}

/**
 * 默认评测器：MVP 占位的安全实现 —— 不在缺少 ground-truth criteria 时臆造 judge 调用，
 * 返回 null（跳过写回）。真实接入 judgeAnswer/轨迹评测在后续阶段按 Config 命中情况补全。
 * 保留此 hook 是为了让回填编排（选样/限流/写回/失败隔离）现在即可端到端跑通与单测。
 */
const defaultEvaluator: TraceEvaluator = async () => null;

export async function sampleAndBackfill(input: BackfillInput): Promise<BackfillResult> {
    const policy: ScoringPolicy = DEFAULT_POLICY;
    const now = input.now ?? new Date();
    const { from, to } = resolveWindowRange(input.window, now, input.from, input.to);
    const evaluator = input.evaluator ?? defaultEvaluator;
    const budget = input.budget ?? policy.sample.budget;

    const { traces } = await collectTraces({ user: input.user, agent: input.agent, from, to });

    // 选未评测子集：无 answerScore 且无轨迹分；按预算 + 采样率封顶。
    const unevaluated = traces.filter((t) => t.answerScore == null && t.trajectory == null);
    const byRate = Math.ceil(traces.length * policy.sample.rate);
    const limit = Math.min(budget, byRate || budget, unevaluated.length);
    const sample = unevaluated.slice(0, limit);

    let evaluated = 0;
    let failed = 0;

    await Promise.all(sample.map((t) =>
        withBackgroundOpencodeSlot(
            async () => {
                try {
                    const res = await evaluator({ executionId: t.executionId, taskId: t.taskId, query: t.query, user: input.user });
                    if (res && res.answerScore != null) {
                        await prisma.execution.update({
                            where: { id: t.executionId },
                            data: { answerScore: res.answerScore },
                        });
                        evaluated++;
                    }
                } catch (e) {
                    failed++;
                    console.warn(`[quality/backfill] eval failed for ${t.executionId}:`, e);
                }
            },
            { label: `quality-backfill:${input.agent}`, taskType: 'evaluation', user: input.user ?? undefined, signal: input.signal },
        ).catch((e) => {
            failed++;
            console.warn('[quality/backfill] slot error:', e);
        }),
    ));

    return {
        accepted: true,
        selected: sample.length,
        evaluated,
        failed,
        coverageDelta: traces.length ? Math.round((evaluated / traces.length) * 1000) / 1000 : 0,
    };
}
