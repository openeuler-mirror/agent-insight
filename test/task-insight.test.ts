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

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTaskInsight } from '@/lib/task-insight/aggregate';
import { classifyTask } from '@/lib/task-insight/classify';
import { DEFAULT_THRESHOLDS, type TaskInsightSourceRow } from '@/lib/task-insight/types';

test('task insight classifies the six task families', () => {
    assert.equal(classifyTask({ query: '介绍一下 agent-insight 的定位' }).category, 'qa');
    assert.equal(classifyTask({ query: '把这段中文翻译成英文' }).category, 'text');
    assert.equal(classifyTask({ query: '总结这份 PDF 报告的关键结论' }).category, 'document');
    assert.equal(classifyTask({ query: '修复这个 TypeScript 编译报错' }).category, 'code');
    assert.equal(classifyTask({ query: '批量处理这个目录下的所有文件' }).category, 'batch');
    assert.equal(classifyTask({ query: '搜索并抓取网页内容' }).category, 'multi_step_tool');
    assert.equal(classifyTask({ query: '你好' }).category, 'other');
});

test('content type outranks tool-call volume', () => {
    const result = classifyTask({
        query: '修复这个 TypeScript 编译报错',
        toolCallCount: 20,
        llmCallCount: 20,
    });
    assert.equal(result.category, 'code');
    assert.deepEqual(result.matchedSignals.includes('缺陷/调试'), true);
    assert.deepEqual(result.matchedSignals.includes('工程动作'), true);
});

test('long task reasons accumulate across all thresholds', () => {
    const long = classifyTask({
        query: '执行任务',
        latencyMs: DEFAULT_THRESHOLDS.longLatencyMs,
        tokens: DEFAULT_THRESHOLDS.longTokens,
        toolCallCount: DEFAULT_THRESHOLDS.longToolCalls,
        llmCallCount: DEFAULT_THRESHOLDS.longLlmCalls,
    });
    assert.equal(long.length, 'long');
    assert.deepEqual(long.longReasons, ['latency', 'tokens', 'tool_calls', 'llm_calls']);

    const short = classifyTask({
        query: '执行任务',
        latencyMs: DEFAULT_THRESHOLDS.longLatencyMs - 1,
        tokens: DEFAULT_THRESHOLDS.longTokens - 1,
        toolCallCount: DEFAULT_THRESHOLDS.longToolCalls - 1,
        llmCallCount: DEFAULT_THRESHOLDS.longLlmCalls - 1,
    });
    assert.equal(short.length, 'short');
    assert.deepEqual(short.longReasons, []);
});

test('deferral honors urgency markers and explicit night hints', () => {
    const urgency = classifyTask({ query: '立即执行这个长任务', latencyMs: 300_000 });
    assert.equal(urgency.deferrable, false);
    assert.equal(urgency.deferralReason, 'urgency');

    const explicit = classifyTask({ query: '这个任务晚上跑就行', latencyMs: 300_000 });
    assert.equal(explicit.deferrable, true);
    assert.equal(explicit.deferralReason, 'explicit_defer');

    const defaultLong = classifyTask({ query: '整理日志', latencyMs: 300_000 });
    assert.equal(defaultLong.deferrable, true);
    assert.equal(defaultLong.deferralReason, 'long_default');

    const short = classifyTask({ query: '晚上跑一下', latencyMs: 1_000 });
    assert.equal(short.deferrable, false);
    assert.equal(short.deferralReason, 'short');
});

function source(overrides: Partial<TaskInsightSourceRow> & { id: string }): TaskInsightSourceRow {
    return {
        id: overrides.id,
        taskId: overrides.taskId ?? overrides.id,
        query: overrides.query ?? '任务',
        user: overrides.user ?? 'alice',
        agentName: overrides.agentName ?? 'agent-a',
        framework: overrides.framework ?? 'opencode',
        model: overrides.model ?? '',
        timestamp: overrides.timestamp ?? new Date('2026-11-01T02:00:00.000Z'),
        latency: overrides.latency ?? 0,
        tokens: overrides.tokens ?? 0,
        inputTokens: overrides.inputTokens ?? 0,
        outputTokens: overrides.outputTokens ?? 0,
        cost: overrides.cost ?? null,
        toolCallCount: overrides.toolCallCount ?? 0,
        llmCallCount: overrides.llmCallCount ?? 0,
        toolCallErrorCount: overrides.toolCallErrorCount ?? 0,
    };
}

test('task insight aggregates totals, categories, hours and deferral advice', () => {
    const rows: TaskInsightSourceRow[] = [
        source({
            id: 'batch-day',
            query: '批量处理这个目录下的所有文件',
            latency: 200_000,
            inputTokens: 60_000,
            outputTokens: 60_000,
            toolCallCount: 12,
            llmCallCount: 3,
            timestamp: new Date('2026-11-01T02:00:00.000Z'),
        }),
        source({
            id: 'text-night',
            query: '把这段中文翻译成英文',
            latency: 5_000,
            tokens: 1_000,
            toolCallCount: 0,
            llmCallCount: 1,
            timestamp: new Date('2026-11-01T15:00:00.000Z'),
        }),
        source({
            id: 'multi-day',
            user: 'bob',
            query: '搜索并抓取网页内容',
            latency: 300_000,
            tokens: 20_000,
            toolCallCount: 6,
            llmCallCount: 4,
            timestamp: new Date('2026-11-02T01:00:00.000Z'),
        }),
    ];

    const summary = buildTaskInsight(rows, {
        range: '7',
        from: '2026-10-26T00:00:00.000Z',
        to: '2026-11-03T00:00:00.000Z',
        truncated: false,
        maxTraces: 10_000,
    });

    assert.equal(summary.analyzedTraces, 3);
    assert.equal(summary.maxTraces, 10_000);
    assert.equal(summary.totals.traces, 3);
    assert.equal(summary.totals.tokens, 141_000);
    assert.equal(summary.totals.inputTokens, 60_000);
    assert.equal(summary.totals.outputTokens, 60_000);
    assert.equal(summary.totals.users, 2);
    assert.equal(summary.totals.longTraces, 2);
    assert.equal(summary.totals.deferrableLongTraces, 2);
    assert.equal(summary.totals.p95LatencyMs, 300_000);

    const categoryTraces = Object.fromEntries(summary.categories.map(item => [item.key, item.traces]));
    assert.equal(categoryTraces.batch, 1);
    assert.equal(categoryTraces.text, 1);
    assert.equal(categoryTraces.multi_step_tool, 1);
    assert.equal(categoryTraces.code, 0);

    const longSplit = summary.lengthSplit.find(item => item.key === 'long');
    assert.equal(longSplit?.traces, 2);
    assert.equal(longSplit?.traceShare, 66.7);
    assert.equal(longSplit?.tokenShare, 99.3);

    assert.deepEqual(summary.longReasonCounts, [
        { key: 'latency', label: '耗时超阈值', count: 2 },
        { key: 'tokens', label: 'Token 超阈值', count: 1 },
        { key: 'tool_calls', label: '工具调用超阈值', count: 1 },
        { key: 'llm_calls', label: 'LLM 调用超阈值', count: 0 },
    ]);

    assert.equal(summary.hours[10].traces, 1);
    assert.equal(summary.hours[23].traces, 1);
    assert.equal(summary.hours[9].traces, 1);
    assert.equal(summary.hours[10].tokens, 120_000);

    assert.equal(summary.deferral.candidateTraces, 2);
    assert.equal(summary.deferral.candidateTokens, 140_000);
    assert.equal(summary.deferral.candidateLatencyMs, 500_000);
    assert.equal(summary.deferral.daytimeTraces, 2);
    assert.equal(summary.deferral.recommendedWindow, '22:00–06:00');
    assert.deepEqual(summary.deferral.byCategory.map(item => item.key), ['batch', 'multi_step_tool']);

    assert.equal(summary.topTasks[0].id, 'batch-day');
    assert.equal(summary.slowestTasks[0].id, 'multi-day');
    assert.equal(summary.deferrableTasks[0].id, 'multi-day');
    assert.deepEqual(summary.users.map(item => item.user), ['alice', 'bob']);
});

test('task insight reports truncation and empty windows honestly', () => {
    const truncated = buildTaskInsight([source({ id: 'only' })], {
        range: '7',
        from: null,
        to: '2026-11-03T00:00:00.000Z',
        truncated: true,
        maxTraces: 1,
    });
    assert.equal(truncated.truncated, true);
    assert.equal(truncated.maxTraces, 1);

    const empty = buildTaskInsight([], {
        range: 'all',
        from: null,
        to: '2026-11-03T00:00:00.000Z',
        truncated: false,
        maxTraces: 10_000,
    });
    assert.equal(empty.analyzedTraces, 0);
    assert.equal(empty.totals.tokens, 0);
    assert.equal(empty.deferral.candidateTraces, 0);
    assert.deepEqual(empty.topTasks, []);
});
