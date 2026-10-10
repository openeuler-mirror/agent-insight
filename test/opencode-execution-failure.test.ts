import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
let AgentInsight: typeof import('@/lib/engine/skill-generation/opencode-agent-cli/opencode-client')['AgentInsight'];
test.before(async () => {
  const loader = Module as unknown as { _load: (...args: any[]) => any };
  const original = loader._load;
  loader._load = function (id, ...args) {
    if (id === '@opencode-ai/sdk') return { createOpencodeClient: () => ({}) };
    return original.call(this, id, ...args);
  };
  try { ({ AgentInsight } = await import('@/lib/engine/skill-generation/opencode-agent-cli/opencode-client')); }
  finally { loader._load = original; }
});
import { buildOpencodeExecutionRecord } from '@/lib/engine/evaluation/evaluator-execution-recorder';
import { deriveOpencodeExecutionFields } from '@/lib/engine/observability/opencode-derived-metrics';
import { getTraceLifecycle } from '@/lib/observe/trace-lifecycle';
import { describeExperimentOutcome } from '@/lib/skill-workbench/experiment-outcome';
import { summarizeWorkbenchItemProgress, workbenchCompletionStatus } from '@/lib/skill-workbench/item-progress';

const sessionId = 'session-failed';
const payload = { text: '分析日志', model: { providerID: 'test', modelID: 'model' } };
function mockClient(events: any[], response: unknown, pendingPrompt = false) {
  const client = new AgentInsight({ baseURL: 'http://localhost:4096', logLevel: 'error' });
  Object.defineProperty(client, 'client', { configurable: true, value: {
    session: { children: async () => ({ data: [] }) },
    event: { subscribe: async () => ({ stream: (async function* () { yield* events; })() }) },
  } });
  client.sendPrompt = async (_id, _payload, options) => {
    if (pendingPrompt) await new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (options?.signal?.aborted) abort();
      else options?.signal?.addEventListener('abort', abort, { once: true });
    });
    return response as Record<string, unknown>;
  };
  return client;
}

for (const type of ['session.error', 'message.updated', 'response']) {
  test(`OpenCode ${type} 的连接错误拒绝执行，携带 trace 和时间`, async () => {
    const error = { name: 'APIError', data: { message: 'Connection error. api_key=secret-value' } };
    const event = type === 'session.error'
      ? { type, properties: { sessionID: sessionId, error } }
      : { type, properties: { info: { sessionID: sessionId, id: 'msg', role: 'assistant', error } } };
    const client = mockClient(type === 'response' ? [] : [event], { info: { id: 'msg', error } }, type !== 'response');
    await assert.rejects(client.chat(sessionId, payload, {}, { streamTimeoutMs: 500 }), (err: any) => {
      assert.equal(err.code, 'MODEL_ERROR');
      assert.match(err.message, /Connection error/);
      assert.doesNotMatch(err.message, /secret-value/);
      assert.equal(err.runFacts.traceId, sessionId);
      assert.ok(Date.parse(err.runFacts.finishedAt) >= Date.parse(err.runFacts.startedAt));
      return true;
    });
  });
}

test('OpenCode 鉴权错误沿用 Benchmark MODEL_UNAVAILABLE 分类', async () => {
  const client = mockClient([], { info: { error: { name: 'ProviderAuthError', data: { message: 'Invalid API key 401' } } } });
  await assert.rejects(client.chat(sessionId, payload), { code: 'MODEL_UNAVAILABLE' });
});

test('正常文本包含 Connection error 不按字符串误判；空会话单独失败', async () => {
  const client = mockClient([], { info: { id: 'msg' }, parts: [{ type: 'text', text: '日志中的 Connection error 是网络问题。' }] });
  assert.match((await client.chat(sessionId, payload)).text, /Connection error/);
  await assert.rejects(mockClient([], {}).chat(sessionId, payload), { code: 'MODEL_NO_RESPONSE' });
  assert.equal((await mockClient([], {}).chat(sessionId, { ...payload, noReply: true })).text, '');
});

test('同步报错可结束仍打开的 SSE；执行超时会中止 prompt', async () => {
  const client = mockClient([], { info: { error: { message: 'Connection error.' } } });
  Object.defineProperty(client, 'client', { configurable: true, value: {
    session: { children: async () => ({ data: [] }) },
    event: { subscribe: async () => ({ stream: {
      [Symbol.asyncIterator]() { return this; },
      next: () => new Promise(() => {}),
      return: async () => ({ done: true }),
    } }) },
  } });
  await assert.rejects(client.chat(sessionId, payload, {}, { streamTimeoutMs: 500 }), { code: 'MODEL_ERROR' });
  await assert.rejects(mockClient([], {}, true).chat(sessionId, payload, {}, { streamTimeoutMs: 20 }), { code: 'AGENT_TIMEOUT' });
});

test('失败 Trace 保留原因和真实耗时，不伪造答案或 LLM 调用', () => {
  const record = buildOpencodeExecutionRecord([], {
    taskId: sessionId, agentName: 'build', query: payload.text, fallbackOutput: 'Connection error.',
    startedAt: '2026-09-25T06:41:14.000Z', completedAt: '2026-09-25T06:42:50.130Z',
    failure: { code: 'MODEL_ERROR', message: 'Connection error. token=secret-value' },
  });
  assert.equal(record.final_result, undefined);
  assert.equal(getTraceLifecycle(record.trace_completed_at, record).traceStatus, 'failed');
  assert.doesNotMatch(JSON.stringify(record), /secret-value/);
  const metrics = deriveOpencodeExecutionFields(record.interactions as any[]);
  assert.equal(metrics.llm_call_count, 0);
  assert.equal(metrics.latency, 96130);
});

test('运行失败跳过评测；评估正常但无分数显示未计分', () => {
  const progress = summarizeWorkbenchItemProgress({
    caseIds: ['error', 'unscored'], executionSides: ['b'], repeatRounds: 1, evaluatorIds: ['answer'], settled: true,
    caseStates: {
      error: { b: { status: 'fail', failureType: 'agent_error' } },
      unscored: { b: { status: 'pass', evaluations: [{ evaluatorId: 'answer', status: 'done', score: null }] } },
    },
  });
  assert.deepEqual(progress.evaluationProgress, { total: 2, succeeded: 0, failed: 0, pending: 0, skipped: 1, unscored: 1 });
  assert.equal(workbenchCompletionStatus('done', progress.executionProgress, progress.evaluationProgress), 'partial');
  assert.equal(describeExperimentOutcome({ status: 'partial', complete: true, execution: progress.executionProgress, evaluation: progress.evaluationProgress }).successful, false);
  assert.equal(describeExperimentOutcome({ status: 'done', complete: true, score: null }).conclusion, '暂无评分结论');
  assert.equal(describeExperimentOutcome({ status: 'failed', complete: false }).label, '实验失败');
});


test('结构化诊断中的密钥字段会脱敏，响应中的工具活动不误判为空会话', async () => {
  const client = mockClient([], { info: { error: { message: 'Connection error', apiKey: 'sensitive-provider-value' } } });
  await assert.rejects(client.chat(sessionId, payload), (error: any) => {
    assert.equal(error.code, 'MODEL_ERROR');
    assert.doesNotMatch(error.message, /sensitive-provider-value/);
    return true;
  });
  const toolClient = mockClient([], { parts: [{ type: 'tool', tool: 'read', state: { status: 'completed' } }] });
  assert.equal((await toolClient.chat(sessionId, payload)).text, '');
});
