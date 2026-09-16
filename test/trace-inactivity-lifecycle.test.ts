import assert from 'node:assert/strict';
import test from 'node:test';
import { getTraceLifecycle, TRACE_INACTIVITY_TIMEOUT_MS } from '@/lib/observe/trace-lifecycle';

const now = Date.parse('2026-09-15T12:00:00Z');
const received = new Date(now - 600_000);

test('inactivity applies to every framework without an assistant answer at exactly ten minutes', () => {
  assert.equal(TRACE_INACTIVITY_TIMEOUT_MS, 600_000);
  for (const framework of ['actrail', 'opencode', 'claudecode', 'hermes', 'openclaw', 'jiuwenswarm', 'langfuse-langgraph', 'direct_llm', 'new-agent', undefined]) {
    const record = { framework, lastIngestedAt: received, final_result: '' };
    assert.equal(getTraceLifecycle(null, record, now - 1).traceStatus, 'running');
    const result = getTraceLifecycle(null, record, now);
    assert.equal(result.traceStatus, 'timed_out', String(framework));
    assert.equal(result.traceStatusReason, 'inactivity-timeout');
    assert.equal(result.traceCompletedAt, null);
  }
});

test('server receipt time wins over old or future client timestamps; new data resumes a timed out trace', () => {
  for (const timestamp of ['1970-01-01T00:00:01Z', '2099-01-01T00:00:00Z']) {
    const record = { timestamp, lastIngestedAt: new Date(now - 1000) };
    assert.equal(getTraceLifecycle(null, record, now).traceStatus, 'running');
  }
  assert.equal(getTraceLifecycle(null, { lastIngestedAt: received }, now).traceStatus, 'timed_out');
  assert.equal(getTraceLifecycle(null, { lastIngestedAt: new Date(now) }, now).traceStatus, 'running');
});

test('explicit completion outranks inactivity and does not require an answer', () => {
  const ended = new Date(now - 3600_000);
  assert.equal(getTraceLifecycle(ended, { lastIngestedAt: received }, now).traceStatus, 'success');
  assert.equal(getTraceLifecycle(ended, { framework: 'actrail', lastIngestedAt: received, failures: [{ failure_type: 'agent-process-exit' }] }, now).traceStatus, 'failed');
});

test('legacy rows use stored timestamp; absent or malformed timestamps are not fabricated', () => {
  assert.equal(getTraceLifecycle(null, { timestamp: received }, now).traceStatus, 'timed_out');
  assert.equal(getTraceLifecycle(null, { timestamp: 'bad' }, now).traceStatus, 'running');
});
