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

const runtime = require('../scripts/jiuwen-experiment-runtime.cjs') as {
  endpoint: () => URL;
  run: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

test('JiuwenSwarm submits one Case through a fresh session and waits for chat.final', async () => {
  const original = globalThis.WebSocket;
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  class FakeSocket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    constructor(url: string | URL) {
      super();
      assert.equal(String(url), 'ws://127.0.0.1:19000/ws');
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(raw: string) {
      const request = JSON.parse(raw);
      sent.push(request);
      if (request.method === 'models.list') {
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
          type: 'res', id: request.id, ok: true, payload: { models: [{ model_name: 'deepseek-flash' }] },
        }) })));
      } else if (request.method === 'session.create') {
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
          type: 'res', id: request.id, ok: true, payload: { session_id: 'web_test_12345678' },
        }) })));
      } else if (request.method === 'chat.send') {
        queueMicrotask(() => {
          this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'res', id: request.id, ok: true }) }));
          this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
            type: 'event', event: 'chat.final', payload: { session_id: 'web_test_12345678', content: 'done' },
          }) }));
        });
      }
    }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  try {
    const result = await runtime.run({ agent: 'main_agent', input: 'Case input', timeoutSeconds: 5 });
    assert.equal(result.sessionId, 'web_test_12345678');
    assert.deepEqual(sent.map(item => item.method), ['session.create', 'chat.send']);
    assert.equal(sent[0].params.mode, 'agent');
    assert.equal(sent[1].params.content, 'Case input');
    assert.equal(sent[1].params.session_id, 'web_test_12345678');
    sent.length = 0;
    await runtime.run({ agent: 'main_agent', model: 'deepseek-flash', input: 'Selected model', timeoutSeconds: 5 });
    assert.deepEqual(sent.map(item => item.method), ['models.list', 'session.create', 'chat.send']);
    assert.equal(sent[2].params.model_name, 'deepseek-flash');
    sent.length = 0;
    await assert.rejects(runtime.run({ agent: 'main_agent', model: 'unavailable', input: 'Case input', timeoutSeconds: 5 }), /模型已不可用/);
    assert.deepEqual(sent.map(item => item.method), ['models.list']);
  } finally {
    globalThis.WebSocket = original;
  }
});

test('JiuwenSwarm rejects unsupported agent before dispatch', async () => {
  await assert.rejects(runtime.run({ agent: 'other_agent' }), /仅支持 main_agent/);
});

test('JiuwenSwarm endpoint requires an unauthenticated /ws address', () => {
  const previous = process.env.AGENT_INSIGHT_JIUWEN_WS_URL;
  try {
    process.env.AGENT_INSIGHT_JIUWEN_WS_URL = 'ws://example.test/other';
    assert.throws(() => runtime.endpoint(), /\/ws 端点/);
    process.env.AGENT_INSIGHT_JIUWEN_WS_URL = 'ws://user:password@example.test/ws';
    assert.throws(() => runtime.endpoint(), /\/ws 端点/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_INSIGHT_JIUWEN_WS_URL;
    else process.env.AGENT_INSIGHT_JIUWEN_WS_URL = previous;
  }
});
