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

export type TaskInsightRange = '7' | '30' | '90' | 'all';

export type TaskCategoryKey =
    | 'qa'
    | 'text'
    | 'document'
    | 'code'
    | 'batch'
    | 'multi_step_tool'
    | 'other';

export type TaskLength = 'long' | 'short';

export type LongTaskReason = 'latency' | 'tokens' | 'tool_calls' | 'llm_calls';

export type DeferralReason = 'short' | 'urgency' | 'explicit_defer' | 'long_default';

export interface TaskCategoryDefinition {
    key: TaskCategoryKey;
    label: string;
    description: string;
}

/** 分类口径集中定义，前端按同一顺序展示，避免两端各写一套。 */
export const TASK_CATEGORY_DEFINITIONS: TaskCategoryDefinition[] = [
    { key: 'qa', label: '问答', description: '知识问答、解释、建议等单轮或轻量交互。' },
    { key: 'text', label: '文本处理', description: '翻译、改写、润色、校对、文案等文本变换。' },
    { key: 'document', label: '文档分析', description: '文档、报告、表格、附件的内容提取、总结与分析。' },
    { key: 'code', label: '代码任务', description: '编码、调试、修复、测试、构建、部署等工程任务。' },
    { key: 'batch', label: '批处理', description: '批量、遍历、逐个处理多个对象或文件。' },
    { key: 'multi_step_tool', label: '多步工具任务', description: '需要多轮工具调用才能完成的任务。' },
    { key: 'other', label: '其他', description: '未命中明确类型信号的任务。' },
];

export const TASK_CATEGORY_LABELS: Record<TaskCategoryKey, string> = Object.fromEntries(
    TASK_CATEGORY_DEFINITIONS.map(item => [item.key, item.label]),
) as Record<TaskCategoryKey, string>;

export interface TaskInsightThresholds {
    /** 墙钟耗时达到该值即视为长时任务。单位毫秒。 */
    longLatencyMs: number;
    /** 总 token 达到该值即视为长时任务。 */
    longTokens: number;
    /** 工具调用次数达到该值即视为长时任务。 */
    longToolCalls: number;
    /** LLM 调用次数达到该值即视为长时任务。 */
    longLlmCalls: number;
}

export const DEFAULT_THRESHOLDS: TaskInsightThresholds = {
    longLatencyMs: 120_000,
    longTokens: 100_000,
    longToolCalls: 10,
    longLlmCalls: 8,
};

export interface TaskClassificationInput {
    query?: string | null;
    latencyMs?: number | null;
    tokens?: number | null;
    toolCallCount?: number | null;
    llmCallCount?: number | null;
}

export interface TaskClassification {
    category: TaskCategoryKey;
    length: TaskLength;
    /** 触发长时判定的维度；短时任务为空数组。 */
    longReasons: LongTaskReason[];
    deferrable: boolean;
    deferralReason: DeferralReason;
    /** 命中的分类关键词，用于解释分类结果（最多保留 5 个）。 */
    matchedSignals: string[];
}

export interface TaskInsightSourceRow {
    id: string;
    taskId?: string | null;
    query?: string | null;
    user?: string | null;
    agentName?: string | null;
    framework?: string | null;
    model?: string | null;
    timestamp: Date | string;
    latency?: number | null;
    tokens?: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cost?: number | null;
    toolCallCount?: number | null;
    llmCallCount?: number | null;
    toolCallErrorCount?: number | null;
}

export interface TaskInsightRow {
    id: string;
    taskId: string | null;
    query: string;
    user: string;
    agentName: string;
    framework: string;
    model: string;
    timestamp: string;
    latencyMs: number | null;
    tokens: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    toolCallCount: number;
    llmCallCount: number;
    category: TaskCategoryKey;
    categoryLabel: string;
    length: TaskLength;
    longReasons: LongTaskReason[];
    deferrable: boolean;
    deferralReason: DeferralReason;
    matchedSignals: string[];
}

export interface TaskBucketSummary {
    key: string;
    label: string;
    traces: number;
    tokens: number;
    cost: number;
    avgLatencyMs: number;
    traceShare: number;
    tokenShare: number;
    costShare: number;
}

export interface TaskCategorySummary extends TaskBucketSummary {
    key: TaskCategoryKey;
    longTraces: number;
    deferrableTraces: number;
}

export interface TaskUserSummary {
    user: string;
    traces: number;
    tokens: number;
    cost: number;
    longTraces: number;
}

export interface TaskHourSummary {
    hour: number;
    traces: number;
    tokens: number;
    longTraces: number;
}

export interface LongReasonSummary {
    key: LongTaskReason;
    label: string;
    count: number;
}

export interface DeferralSummary {
    /** 可延后长任务数量。 */
    candidateTraces: number;
    candidateTokens: number;
    candidateCost: number;
    candidateLatencyMs: number;
    /** 其中当前在 09:00–18:00 执行的数量与规模。 */
    daytimeTraces: number;
    daytimeTokens: number;
    daytimeLatencyMs: number;
    /** 建议执行窗口（Asia/Shanghai）。 */
    recommendedWindow: string;
    byCategory: Array<{ key: TaskCategoryKey; label: string; traces: number; tokens: number }>;
}

export interface TaskInsightTotals {
    traces: number;
    tokens: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    toolCalls: number;
    llmCalls: number;
    users: number;
    longTraces: number;
    deferrableLongTraces: number;
}

export interface TaskInsightResponse {
    range: TaskInsightRange;
    from: string | null;
    to: string;
    truncated: boolean;
    analyzedTraces: number;
    maxTraces: number;
    thresholds: TaskInsightThresholds;
    pricingMissingModels: string[];
    totals: TaskInsightTotals;
    categories: TaskCategorySummary[];
    lengthSplit: TaskBucketSummary[];
    longReasonCounts: LongReasonSummary[];
    users: TaskUserSummary[];
    hours: TaskHourSummary[];
    deferral: DeferralSummary;
    topTasks: TaskInsightRow[];
    slowestTasks: TaskInsightRow[];
    deferrableTasks: TaskInsightRow[];
}
