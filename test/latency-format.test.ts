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

import { formatDurationMs, formatLatencySeconds, latencySecondsToMs } from '@/lib/latency-format';

test('formatDurationMs auto-scales milliseconds through hours', () => {
    assert.equal(formatDurationMs(null), '-');
    assert.equal(formatDurationMs(999), '999ms');
    assert.equal(formatDurationMs(1000), '1s');
    assert.equal(formatDurationMs(2660), '2.66s');
    assert.equal(formatDurationMs(60000), '1m');
    assert.equal(formatDurationMs(2664.794 * 1000), '44.4m');
    assert.equal(formatDurationMs(3600000), '1h');
    assert.equal(formatDurationMs(5400000), '1.5h');
});

test('formatLatencySeconds treats Execution.latency as seconds', () => {
    assert.equal(latencySecondsToMs(2664.794), 2664794);
    assert.equal(formatLatencySeconds(2664.794), '44.4m');
});
