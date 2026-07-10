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
