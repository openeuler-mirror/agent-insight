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

import { pct, rowCost, rowTokens, type FleetRow } from '@/lib/fleet/agg';
import { classifyTask } from './classify';
import {
    DEFAULT_THRESHOLDS,
    TASK_CATEGORY_DEFINITIONS,
    TASK_CATEGORY_LABELS,
    type DeferralSummary,
    type LongReasonSummary,
    type TaskBucketSummary,
    type TaskCategoryKey,
    type TaskCategorySummary,
    type TaskHourSummary,
    type TaskInsightResponse,
    type TaskInsightRow,
    type TaskInsightSourceRow,
    type TaskInsightThresholds,
    type TaskUserSummary,
} from './types';

const TOP_TASKS = 20;
const TOP_USERS = 10;
const CST_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAYTIME_START_HOUR = 9;
const DAYTIME_END_HOUR = 18;

const LONG_REASON_LABELS = {
    latency: '耗时超阈值',
    tokens: 'Token 超阈值',
    tool_calls: '工具调用超阈值',
    llm_calls: 'LLM 调用超阈值',
} as const;

export interface BuildTaskInsightOptions {
    range: TaskInsightResponse['range'];
    from: string | null;
    to: string;
    truncated: boolean;
    maxTraces: number;
    thresholds?: TaskInsightThresholds;
}

function round(value: number, digits = 6): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function sharePercent(part: number, total: number): number {
    return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

function toIso(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function cstHour(value: Date | string): number {
    const ms = value instanceof Date ? value.getTime() : Date.parse(value);
    if (!Number.isFinite(ms)) return 0;
    return new Date(ms + CST_OFFSET_MS).getUTCHours();
}

function rowOf(source: TaskInsightSourceRow, thresholds: TaskInsightThresholds, missing: Set<string>): TaskInsightRow {
    const fleetRow = source as unknown as FleetRow;
    const tokenInfo = rowTokens(fleetRow);
    const pricedCost = rowCost(fleetRow, missing);
    const cost = pricedCost > 0 ? pricedCost : (source.cost ?? 0);
    const latencyMs = source.latency != null && source.latency > 0 ? source.latency : null;

    const classification = classifyTask({
        query: source.query,
        latencyMs,
        tokens: tokenInfo.total,
        toolCallCount: source.toolCallCount,
        llmCallCount: source.llmCallCount,
    }, thresholds);

    return {
        id: source.id,
        taskId: source.taskId ?? null,
        query: (source.query || '').trim(),
        user: source.user || '未归属用户',
        agentName: source.agentName || '—',
        framework: source.framework || '—',
        model: source.model || '—',
        timestamp: toIso(source.timestamp),
        latencyMs,
        tokens: tokenInfo.total,
        inputTokens: tokenInfo.input,
        outputTokens: tokenInfo.output,
        cost: round(cost),
        toolCallCount: source.toolCallCount ?? 0,
        llmCallCount: source.llmCallCount ?? 0,
        category: classification.category,
        categoryLabel: TASK_CATEGORY_LABELS[classification.category],
        length: classification.length,
        longReasons: classification.longReasons,
        deferrable: classification.deferrable,
        deferralReason: classification.deferralReason,
        matchedSignals: classification.matchedSignals,
    };
}

interface BucketAccumulator {
    traces: number;
    tokens: number;
    cost: number;
    latencySum: number;
    latencyCount: number;
}

function emptyBucket(): BucketAccumulator {
    return { traces: 0, tokens: 0, cost: 0, latencySum: 0, latencyCount: 0 };
}

function addToBucket(bucket: BucketAccumulator, row: TaskInsightRow): void {
    bucket.traces += 1;
    bucket.tokens += row.tokens;
    bucket.cost += row.cost;
    if (row.latencyMs != null) {
        bucket.latencySum += row.latencyMs;
        bucket.latencyCount += 1;
    }
}

function bucketSummary(
    key: string,
    label: string,
    bucket: BucketAccumulator,
    totals: { traces: number; tokens: number; cost: number },
): TaskBucketSummary {
    return {
        key,
        label,
        traces: bucket.traces,
        tokens: bucket.tokens,
        cost: round(bucket.cost),
        avgLatencyMs: bucket.latencyCount > 0 ? Math.round(bucket.latencySum / bucket.latencyCount) : 0,
        traceShare: sharePercent(bucket.traces, totals.traces),
        tokenShare: sharePercent(bucket.tokens, totals.tokens),
        costShare: sharePercent(bucket.cost, totals.cost),
    };
}

export function buildTaskInsight(
    sources: TaskInsightSourceRow[],
    options: BuildTaskInsightOptions,
): TaskInsightResponse {
    const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
    const missing = new Set<string>();
    const rows = sources.map(source => rowOf(source, thresholds, missing));

    const totalTokens = rows.reduce((sum, row) => sum + row.tokens, 0);
    const totalInput = rows.reduce((sum, row) => sum + row.inputTokens, 0);
    const totalOutput = rows.reduce((sum, row) => sum + row.outputTokens, 0);
    const totalCost = rows.reduce((sum, row) => sum + row.cost, 0);
    const latencies = rows.map(row => row.latencyMs).filter((value): value is number => value != null);
    const longRows = rows.filter(row => row.length === 'long');
    const deferrableRows = rows.filter(row => row.deferrable);
    const totalUsers = new Set(rows.map(row => row.user)).size;
    const totalsRef = { traces: rows.length, tokens: totalTokens, cost: totalCost };

    const categoryBuckets = new Map<TaskCategoryKey, BucketAccumulator>();
    for (const definition of TASK_CATEGORY_DEFINITIONS) {
        categoryBuckets.set(definition.key, emptyBucket());
    }
    const categoryLong = new Map<TaskCategoryKey, number>();
    const categoryDeferrable = new Map<TaskCategoryKey, number>();
    const lengthBuckets = new Map<'long' | 'short', BucketAccumulator>([
        ['long', emptyBucket()],
        ['short', emptyBucket()],
    ]);
    const userBuckets = new Map<string, { traces: number; tokens: number; cost: number; longTraces: number }>();
    const hourBuckets: TaskHourSummary[] = Array.from({ length: 24 }, (_, hour) => ({
        hour,
        traces: 0,
        tokens: 0,
        longTraces: 0,
    }));
    const reasonCounts = new Map<keyof typeof LONG_REASON_LABELS, number>([
        ['latency', 0],
        ['tokens', 0],
        ['tool_calls', 0],
        ['llm_calls', 0],
    ]);

    for (const row of rows) {
        const categoryBucket = categoryBuckets.get(row.category);
        if (categoryBucket) addToBucket(categoryBucket, row);
        if (row.length === 'long') {
            categoryLong.set(row.category, (categoryLong.get(row.category) ?? 0) + 1);
        }
        if (row.deferrable) {
            categoryDeferrable.set(row.category, (categoryDeferrable.get(row.category) ?? 0) + 1);
        }

        addToBucket(lengthBuckets.get(row.length)!, row);

        const userBucket = userBuckets.get(row.user) ?? { traces: 0, tokens: 0, cost: 0, longTraces: 0 };
        userBucket.traces += 1;
        userBucket.tokens += row.tokens;
        userBucket.cost += row.cost;
        if (row.length === 'long') userBucket.longTraces += 1;
        userBuckets.set(row.user, userBucket);

        const hour = cstHour(row.timestamp);
        const hourBucket = hourBuckets[hour];
        hourBucket.traces += 1;
        hourBucket.tokens += row.tokens;
        if (row.length === 'long') hourBucket.longTraces += 1;

        for (const reason of row.longReasons) {
            reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
        }
    }

    const categories: TaskCategorySummary[] = TASK_CATEGORY_DEFINITIONS.map(definition => {
        const bucket = categoryBuckets.get(definition.key)!;
        return {
            ...bucketSummary(definition.key, definition.label, bucket, totalsRef),
            key: definition.key,
            longTraces: categoryLong.get(definition.key) ?? 0,
            deferrableTraces: categoryDeferrable.get(definition.key) ?? 0,
        };
    });

    const lengthSplit: TaskBucketSummary[] = [
        bucketSummary('long', '长时任务', lengthBuckets.get('long')!, totalsRef),
        bucketSummary('short', '短时任务', lengthBuckets.get('short')!, totalsRef),
    ];

    const longReasonCounts: LongReasonSummary[] = (Object.keys(LONG_REASON_LABELS) as Array<keyof typeof LONG_REASON_LABELS>)
        .map(key => ({ key, label: LONG_REASON_LABELS[key], count: reasonCounts.get(key) ?? 0 }));

    const users: TaskUserSummary[] = [...userBuckets.entries()]
        .map(([user, bucket]) => ({
            user,
            traces: bucket.traces,
            tokens: bucket.tokens,
            cost: round(bucket.cost),
            longTraces: bucket.longTraces,
        }))
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, TOP_USERS);

    const daytimeDeferrable = deferrableRows.filter(row => {
        const hour = cstHour(row.timestamp);
        return hour >= DAYTIME_START_HOUR && hour < DAYTIME_END_HOUR;
    });
    const deferralCategoryBuckets = new Map<TaskCategoryKey, { traces: number; tokens: number }>();
    for (const row of deferrableRows) {
        const bucket = deferralCategoryBuckets.get(row.category) ?? { traces: 0, tokens: 0 };
        bucket.traces += 1;
        bucket.tokens += row.tokens;
        deferralCategoryBuckets.set(row.category, bucket);
    }
    const deferral: DeferralSummary = {
        candidateTraces: deferrableRows.length,
        candidateTokens: deferrableRows.reduce((sum, row) => sum + row.tokens, 0),
        candidateCost: round(deferrableRows.reduce((sum, row) => sum + row.cost, 0)),
        candidateLatencyMs: deferrableRows.reduce((sum, row) => sum + (row.latencyMs ?? 0), 0),
        daytimeTraces: daytimeDeferrable.length,
        daytimeTokens: daytimeDeferrable.reduce((sum, row) => sum + row.tokens, 0),
        daytimeLatencyMs: daytimeDeferrable.reduce((sum, row) => sum + (row.latencyMs ?? 0), 0),
        recommendedWindow: '22:00–06:00',
        byCategory: [...deferralCategoryBuckets.entries()]
            .map(([key, bucket]) => ({
                key,
                label: TASK_CATEGORY_LABELS[key],
                traces: bucket.traces,
                tokens: bucket.tokens,
            }))
            .sort((a, b) => b.tokens - a.tokens),
    };

    const topTasks = [...rows].sort((a, b) => b.tokens - a.tokens).slice(0, TOP_TASKS);
    const slowestTasks = [...rows]
        .sort((a, b) => (b.latencyMs ?? 0) - (a.latencyMs ?? 0))
        .slice(0, TOP_TASKS);
    const deferrableTasks = [...deferrableRows]
        .sort((a, b) => (b.latencyMs ?? 0) - (a.latencyMs ?? 0))
        .slice(0, TOP_TASKS);

    return {
        range: options.range,
        from: options.from,
        to: options.to,
        truncated: options.truncated,
        analyzedTraces: rows.length,
        maxTraces: options.maxTraces,
        thresholds,
        pricingMissingModels: [...missing].sort(),
        totals: {
            traces: rows.length,
            tokens: totalTokens,
            inputTokens: totalInput,
            outputTokens: totalOutput,
            cost: round(totalCost),
            avgLatencyMs: latencies.length > 0
                ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
                : 0,
            p95LatencyMs: Math.round(pct(latencies, 0.95)),
            toolCalls: rows.reduce((sum, row) => sum + row.toolCallCount, 0),
            llmCalls: rows.reduce((sum, row) => sum + row.llmCallCount, 0),
            users: totalUsers,
            longTraces: longRows.length,
            deferrableLongTraces: deferrableRows.length,
        },
        categories,
        lengthSplit,
        longReasonCounts,
        users,
        hours: hourBuckets,
        deferral,
        topTasks,
        slowestTasks,
        deferrableTasks,
    };
}
