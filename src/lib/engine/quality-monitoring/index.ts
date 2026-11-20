/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// buildQualityReport — 报告编排入口。
// 调用序（设计 §6.2）：collectTraces → buildProblemSummary（先于错误维）
//   → scoreDimensions（消费问题汇总产出错误维）→ bucketTrends → 组装 QualityReport。
// 请求路径只读，不触发任何评测。

import type { QualityReport, QualityReportInput, WindowKind, ScoringPolicy, DimScore } from './types';
import { DEFAULT_POLICY, MAX_ERROR_PARSE_TRACES, MAX_PROBLEM_ITEMS } from './config';
import { type CollectResult } from './trace-collector';
import { scoreDimensions } from './dimension-scorer';
import { bucketTrends } from './trend-bucketer';
import {
    buildProblemSummary, lowScoreProblems, rankProblems, buildSkillDrag, summarizeDiagnoses,
    type SkillIssueRowLite, type StructuredTraceErrors,
} from './problem-summary';
import type { DiagnosisLite } from './types';

const EMPTY_DIM: DimScore = { score: 0, status: '异常', coverage: 0, n: 0 };

function emptyReport(input: QualityReportInput): QualityReport {
    return {
        composite: { score: 0, status: '异常', p0: 0, p1: 0, p2: null, capped: false },
        dimensions: { process: EMPTY_DIM, cost: EMPTY_DIM, error: EMPTY_DIM },
        trend: { granularity: input.window === '1d' ? 'hour' : 'day', buckets: [] },
        problems: [],
        errorNodeDistribution: [],
        skillDrag: [],
        problemCounts: { error: 0, eval: 0, total: 0, errorEvents: 0 },
        moduleFingerprint: [],
        diagnosisCoverage: { diagnosed: 0, errorish: 0 },
        meta: {
            n: 0, empty: true, lowSample: true, window: input.window,
            from: input.from.toISOString(), to: input.to.toISOString(),
            agent: input.agent, filters: input.filters,
        },
    };
}

export interface QualityReportSource {
    collection: CollectResult;
    structuredErrors: StructuredTraceErrors[];
    skillIssueRows: SkillIssueRowLite[];
    diagnosesByTrace: Map<string, DiagnosisLite>;
}

export async function buildQualityReport(
    input: QualityReportInput,
    policy: ScoringPolicy = DEFAULT_POLICY,
    source: QualityReportSource,
): Promise<QualityReport> {
    // 1. 圈定 T
    if (!source) throw Object.assign(new Error('Core quality source required'), { status: 503 });
    const { traces, truncated } = source.collection;
    if (!traces.length) return emptyReport(input);

    // 2. 按需加载交互（仅含错误信号的 trace，且封顶）+ SkillIssue 表行（并行）
    const errorish = traces
        .filter((t) => (t.toolCallErrorCount ?? 0) > 0 || (t.failures?.length ?? 0) > 0)
        .slice(0, MAX_ERROR_PARSE_TRACES);
    const interactionsByTrace = new Map<string, unknown[]>();
    const { skillIssueRows, diagnosesByTrace } = source;

    // 3. 统一问题汇总（先于错误维）+ 诊断增强 + Skill 拖累榜
    const summary = buildProblemSummary({ traces, interactionsByTrace, skillIssueRows, diagnosesByTrace, structuredErrors: source.structuredErrors.filter(row => errorish.some(trace => trace.executionId === row.executionId)) });
    const skillDrag = buildSkillDrag(skillIssueRows, traces);
    const { moduleFingerprint, diagnosisCoverage } = summarizeDiagnoses(traces, diagnosesByTrace);

    // 4. 过程 / 成本 / 错误三维 + 综合（错误维由问题汇总反哺）
    const scored = scoreDimensions(traces, policy, summary.errorSummary);

    // 5. 追加低分维度问题 → 统一排序 + 帕累托；按影响度封顶返回，全量计数单独带回
    const lowDim = lowScoreProblems(scored.dimensions, policy.status.关注);
    const ranked = rankProblems([...summary.problems, ...lowDim]);
    const problemCounts = {
        error: ranked.filter((p) => p.source === '错误').length,
        eval: ranked.filter((p) => p.source === '评测').length,
        total: ranked.length,
        errorEvents: summary.errorSummary.errorEventCount,
    };
    const problems = ranked.slice(0, MAX_PROBLEM_ITEMS);

    // 6. 趋势分桶
    const trend = bucketTrends({ traces, window: input.window, from: input.from, to: input.to, policy });

    const n = traces.length;
    return {
        composite: scored.composite,
        dimensions: scored.dimensions,
        trend,
        problems,
        errorNodeDistribution: summary.errorNodeDistribution,
        skillDrag,
        problemCounts,
        moduleFingerprint,
        diagnosisCoverage,
        meta: {
            n,
            empty: false,
            lowSample: n < policy.thetaSample,
            window: input.window,
            from: input.from.toISOString(),
            to: input.to.toISOString(),
            agent: input.agent,
            filters: input.filters,
            truncated,
        },
    };
}

/** 由 window + now 解析 [from,to]；custom 用显式 from/to。 */
export function resolveWindowRange(
    window: WindowKind, now: Date, fromISO?: string | null, toISO?: string | null,
): { from: Date; to: Date } {
    const to = new Date(now);
    if (window === 'custom') {
        const from = fromISO ? new Date(fromISO) : new Date(now.getTime() - 7 * 86_400_000);
        const t = toISO ? new Date(toISO) : to;
        return { from, to: t };
    }
    const days = window === '1d' ? 1 : window === '1w' ? 7 : 30;
    const from = new Date(now.getTime() - days * 86_400_000);
    return { from, to };
}

export { DEFAULT_POLICY } from './config';
export type { QualityReport, QualityReportInput, WindowKind } from './types';
