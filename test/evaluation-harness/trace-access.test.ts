import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEvaluationTraceAccess } from '../../src/lib/evaluation-harness/trace-access';

test('Trace access sends the current identity and returns only a matching owned Trace context', async () => {
  const controller = new AbortController();
  const context = await loadEvaluationTraceAccess('trace/one', 'test-key', controller.signal, async (url, options) => {
    assert.equal(url, '/api/evaluation-harness?traceId=trace%2Fone');
    assert.equal(new Headers(options?.headers).get('x-witty-api-key'), 'test-key');
    assert.equal(options?.signal, controller.signal);
    return Response.json({ traceId: 'trace/one', experimentId: 'experiment-one', caseId: 'case-one', turns: ['private evidence'] });
  });
  assert.deepEqual(context, { traceId: 'trace/one', experimentId: 'experiment-one', caseId: 'case-one' });
});

test('missing identity prevents a Trace access request', async () => {
  let called = false;
  await assert.rejects(() => loadEvaluationTraceAccess('trace-one', '', undefined, async () => {
    called = true;
    return Response.json({});
  }), /登录/);
  assert.equal(called, false);
});

test('rejected ownership and authentication cannot authorize Trace loading', async () => {
  for (const status of [401, 403, 404, 500]) {
    await assert.rejects(() => loadEvaluationTraceAccess('other-trace', 'test-key', undefined, async () =>
      Response.json({ error: 'Trace 不存在或无权访问' }, { status })), /不存在或无权访问/);
  }
});

test('unrelated or incomplete access responses cannot authorize the requested Trace', async () => {
  for (const payload of [
    { traceId: 'another-trace', experimentId: 'exp', caseId: 'case' },
    { traceId: 'requested', experimentId: 'exp' },
    { traceId: 'requested', experimentId: '', caseId: 'case' },
  ]) {
    await assert.rejects(() => loadEvaluationTraceAccess('requested', 'test-key', undefined, async () =>
      Response.json(payload)), /访问校验/);
  }
});
