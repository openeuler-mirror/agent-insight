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
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const runtime = require('../scripts/jiuwen-experiment-runtime.cjs') as {
  endpoint: () => URL;
  probe: () => { ready: boolean; models: string[] };
  run: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

test('personal Jiuwen probes and executes without a global WebSocket (Node 20)', { timeout: 15_000 }, async () => {
  const original = globalThis.WebSocket;
  const previous = process.env.AGENT_INSIGHT_JIUWEN_WS_URL;
  const server = spawn(process.execPath, ['-e', `
    const { WebSocketServer } = require('ws');
    const server = new WebSocketServer({port: 0, host: '127.0.0.1'});
    server.on('listening', () => console.log(server.address().port));
    server.on('connection', ws => ws.on('message', data => {
      const r = JSON.parse(data);
      let payload = {};
      if (r.method === 'models.list') payload = {models: [{model_name: 'fixture-model'}]};
      if (r.method === 'session.create') payload = {session_id: 'web_node20_fixture'};
      ws.send(JSON.stringify({type: 'res', id: r.id, ok: true, payload}));
      if (r.method === 'chat.send') ws.send(JSON.stringify({type: 'event', event: 'chat.final', payload: {session_id: 'web_node20_fixture'}}));
    }));
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const [chunk] = await once(server.stdout!, 'data');
    process.env.AGENT_INSIGHT_JIUWEN_WS_URL = `ws://127.0.0.1:${Number(String(chunk).trim())}/ws`;
    Reflect.deleteProperty(globalThis, 'WebSocket');
    const capability = runtime.probe();
    assert.equal(capability.ready, true);
    assert.deepEqual(capability.models, ['fixture-model']);
    const result = await runtime.run({ agent: 'main_agent', input: 'Node 20 compatibility', timeoutSeconds: 5 });
    assert.equal(result.sessionId, 'web_node20_fixture');
  } finally {
    globalThis.WebSocket = original;
    if (previous === undefined) delete process.env.AGENT_INSIGHT_JIUWEN_WS_URL;
    else process.env.AGENT_INSIGHT_JIUWEN_WS_URL = previous;
    server.kill();
  }
});

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
