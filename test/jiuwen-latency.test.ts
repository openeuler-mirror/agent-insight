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
import { aggregateJiuwenOtlpFromSpans, type JiuwenSpan } from '@/lib/ingest/otel/jiuwen/aggregate';
import { jiuwenLegacyLatencyCorrection } from '@/lib/engine/observability/jiuwen-latency';

const span = (startNs: number, endNs: number): JiuwenSpan => ({
    name: 'llm.call', traceId: 'latency-trace', spanId: 'llm-1', startNs, endNs,
    attrs: { 'gen_ai.completion.0.content': 'done', 'gen_ai.usage.total_tokens': 10 },
});

test('Jiuwen single-agent aggregation stores milliseconds including sub-second work', () => {
    const record = aggregateJiuwenOtlpFromSpans([span(1_000_000_000, 1_018_000_000)]);
    assert.equal(record?.latency, 18);
});

test('Jiuwen team aggregation keeps the complete multi-hour span in milliseconds', () => {
    const first = 1_000_000_000;
    const elapsedMs = 61_187_865;
    const record = aggregateJiuwenOtlpFromSpans([
        { name: 'team.demo', traceId: 'latency-trace', spanId: 'team', startNs: first,
            endNs: first + elapsedMs * 1_000_000, attrs: { 'agentteam.session.id': 'latency-team' } },
        span(first + 1_000_000, first + 100_000_000),
    ]);
    assert.equal(record?.latency, elapsedMs);
});

test('fresh sub-millisecond Jiuwen durations survive timestamp quantization without reconversion', () => {
    const record = aggregateJiuwenOtlpFromSpans([span(1_999_000, 2_001_000)])!;
    assert.equal(record.latency, 0.002);
    assert.equal(jiuwenLegacyLatencyCorrection(record.latency, record.interactions), undefined);
});

test('legacy seconds tolerate a small root span wrapper without accepting unrelated durations', () => {
    const interactions = [{ role: 'assistant', timeInfo: { created: 1000, completed: 14698 } }];
    assert.equal(jiuwenLegacyLatencyCorrection(13.84, interactions)?.latencyMs, 13840);
    assert.equal(jiuwenLegacyLatencyCorrection(20, interactions), undefined);
});
