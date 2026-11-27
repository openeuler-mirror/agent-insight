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
import { resolveTraceTimeRange, toLocalTraceTime } from '@/lib/client/trace-time-range';
import { buildPrismaWhere } from '@/lib/filters/to-prisma';

test('local time is normalized to UTC with seconds and round trips for editing', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'Asia/Shanghai';
    try {
        const range = resolveTraceTimeRange('2026-11-04T10:00:01', '2026-11-05T11:00:02');
        assert.equal(range.error, null);
        assert.equal(range.from, '2026-11-04T02:00:01.000Z');
        assert.equal(range.to, '2026-11-05T03:00:02.000Z');
        assert.equal(toLocalTraceTime(range.from), '2026-11-04T10:00:01');
    } finally {
        if (previous === undefined) delete process.env.TZ;
        else process.env.TZ = previous;
    }
});

test('custom range becomes inclusive database bounds while preserving unrelated clauses', () => {
    const range = resolveTraceTimeRange('2026-11-04T02:00:01.000Z', '2026-11-05T03:00:02.000Z');
    assert.equal(range.error, null);
    const { where } = buildPrismaWhere([
        { column: 'tokens', operator: '>=', value: 100 }, ...range.clauses,
    ]);
    assert.deepEqual(where, { AND: [
        { tokens: { gte: 100 } },
        { timestamp: { gte: new Date(range.from) } },
        { timestamp: { lte: new Date(range.to) } },
    ] });
});

test('open bounds and equal endpoints are supported', () => {
    const time = '2026-11-05T03:00:02.000Z';
    assert.deepEqual(resolveTraceTimeRange(time, '').clauses, [{ column: 'timestamp', operator: '>=', value: time }]);
    assert.deepEqual(resolveTraceTimeRange('', time).clauses, [{ column: 'timestamp', operator: '<=', value: time }]);
    assert.equal(resolveTraceTimeRange(time, time).error, null);
});

test('empty, invalid, impossible and reversed ranges cannot become query clauses', () => {
    for (const [from, to, error] of [
        ['', '', 'empty'],
        ['invalid', '', 'invalid'],
        ['', '2026-02-30T12:00:00', 'invalid'],
        ['2026-11-05T25:00:00', '', 'invalid'],
        ['2026-11-06T00:00:00Z', '2026-11-05T00:00:00Z', 'order'],
    ]) {
        const range = resolveTraceTimeRange(from, to);
        assert.equal(range.error, error);
        assert.deepEqual(range.clauses, []);
    }
    assert.equal(toLocalTraceTime('bad'), '');
    assert.equal(toLocalTraceTime(''), '');
});
