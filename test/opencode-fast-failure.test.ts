import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { OpencodeFailureEvent } from '../scripts/agent-run-diagnostics.cjs';
import { createOpencodeFailureMonitor } from '../scripts/agent-run-diagnostics.cjs';

const require = createRequire(import.meta.url);
const { inspectOpencodeRunEvent } = require('../scripts/reliability-client.cjs');
function setup() {
  const failures: Array<{ code: string; message: string }> = [];
  const timers = new Map<number, () => void>();
  let id = 0;
  const monitor = createOpencodeFailureMonitor({
    inspectEvent: inspectOpencodeRunEvent,
    onFailure: (code, message) => failures.push({ code, message }),
    schedule: (callback, ms) => { assert.equal(ms, 10_000); timers.set(++id, callback); return id; },
    cancel: (key) => { timers.delete(key as number); },
  });
  return { monitor, failures, timers, expire: () => { for (const callback of [...timers.values()]) callback(); } };
}
function retry(attempt = 1, message = 'Cannot connect to API: The socket connection was closed unexpectedly'): OpencodeFailureEvent {
  return inspectOpencodeRunEvent(JSON.stringify({ type: 'session.status', properties: { status: { type: 'retry', attempt, message } } }));
}

test('重试事件保留原因与次数，重复报告不累计次数，再次失败提前终止', () => {
  const { monitor, failures, timers } = setup();
  assert.equal(retry().retry?.attempt, 1);
  monitor.onEvent(retry());
  monitor.onEvent(retry());
  assert.equal(failures.length, 0);
  assert.equal(timers.size, 1);
  monitor.onEvent(retry(2));
  assert.equal(failures[0].code, 'MODEL_ERROR');
  assert.match(failures[0].message, /socket connection/);
  monitor.onEvent(retry(3));
  assert.equal(failures.length, 1);
  assert.equal(timers.size, 0);
});

test('首次错误后 10 秒未恢复失败；正常慢响应不受错误计时器影响', () => {
  const { monitor, failures, expire, timers } = setup();
  assert.equal(timers.size, 0);
  expire();
  assert.equal(failures.length, 0);
  monitor.onEvent(retry());
  monitor.onEvent(inspectOpencodeRunEvent(JSON.stringify({ type: 'step_finish' })));
  assert.equal(timers.size, 1);
  expire();
  assert.match(failures[0].message, /10 秒内未恢复/);
  assert.equal(monitor.finish()?.code, 'MODEL_ERROR');
});

test('恢复输出清除错误窗口，已有首响应后的断连仍会触发快速失败', () => {
  const { monitor, failures, expire, timers } = setup();
  monitor.onStderr('Cannot connect to API: connection closed [retrying in 1s attempt #1]');
  monitor.onEvent(inspectOpencodeRunEvent(JSON.stringify({ type: 'text', part: { text: 'recovered' } })));
  assert.equal(timers.size, 0);
  assert.equal(monitor.finish(), null);
  monitor.onEvent(retry());
  expire();
  assert.equal(failures.length, 1);
});

test('stderr 分段和 ANSI 错误实时识别，JSON 错误及鉴权错误立即失败且脱敏', () => {
  const a = setup();
  a.monitor.onStderr('\u001b[31mCannot con');
  assert.equal(a.timers.size, 0);
  a.monitor.onStderr('nect to API: socket closed [retrying in 1s attempt #1]\u001b[0m\r');
  assert.equal(a.timers.size, 1);
  a.monitor.onStderr('Cannot connect to API: socket closed [retrying in 1s attempt #2]');
  assert.equal(a.failures[0].code, 'MODEL_ERROR');
  const b = setup();
  b.monitor.onStderr('Error: ProviderAuthError: invalid api key api_key=secret-value');
  assert.equal(b.failures[0].code, 'MODEL_UNAVAILABLE');
  assert.doesNotMatch(b.failures[0].message, /secret-value/);
  const c = setup();
  c.monitor.onStderr(JSON.stringify({ type: 'session.error', properties: { error: { message: 'connection closed' } } }));
  assert.equal(c.failures[0].code, 'MODEL_ERROR');
  const d = setup();
  d.monitor.onEvent(retry(1, 'provider unauthorized 401'));
  assert.equal(d.failures[0].code, 'MODEL_UNAVAILABLE');
});

test('模型回答和工具输出的错误文字不误判，进程结束/取消清除错误计时器', () => {
  const { monitor, failures, timers } = setup();
  for (const type of ['text', 'tool_result']) {
    const line = JSON.stringify({ type, part: { text: 'Cannot connect to API: example' } });
    monitor.onEvent(inspectOpencodeRunEvent(line));
    monitor.onStderr(line + '\n');
  }
  monitor.onStderr('ordinary tool warning: error reading file\n');
  assert.equal(failures.length, 0);
  monitor.onEvent(retry());
  monitor.dispose();
  assert.equal(timers.size, 0);
  monitor.onEvent(retry(2));
  assert.equal(failures.length, 0);
  const pending = setup();
  pending.monitor.onEvent(retry());
  assert.equal(pending.monitor.finish()?.code, 'MODEL_ERROR');
  assert.equal(pending.timers.size, 0);
});
