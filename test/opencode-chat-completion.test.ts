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
import Module from 'node:module';
let AgentInsight: typeof import('@/lib/engine/skill-generation/opencode-agent-cli/opencode-client')['AgentInsight'];
test.before(async () => {
  const loader = Module as unknown as { _load: (...args: any[]) => any }, original = loader._load;
  loader._load = function (id, ...args) { return id === '@opencode-ai/sdk' ? { createOpencodeClient: () => ({}) } : original.call(this, id, ...args); };
  try { ({ AgentInsight } = await import('@/lib/engine/skill-generation/opencode-agent-cli/opencode-client')); }
  finally { loader._load = original; }
});
const session = 'root', user = 'current-user', assistant = 'current-assistant';
const payload = { text: 'real task', model: { providerID: 'test', modelID: 'model' } };
const message = (role: string, id: string, extra = {}) => ({ type: 'message.updated', properties: { info: { sessionID: session, role, id, ...extra } } });
const snapshot = (extra = {}): any[] => [
  { info: { sessionID: session, role: 'user', id: user }, parts: [] },
  { info: { sessionID: session, role: 'assistant', id: assistant, parentID: user, time: { completed: 1 }, ...extra }, parts: [{ type: 'text', text: 'complete authoritative reply' }] },
];
const idle = { type: 'session.idle', properties: { sessionID: session } };
const fullEvents = (finish?: string) => [message('user', user), message('assistant', assistant, { time: { completed: 1 }, ...(finish ? { finish } : {}), parts: [{ type: 'text', text: 'partial stream' }] }), idle];
function fixture(events: any[], messages: any[], read?: (signal: AbortSignal, push: (e: any) => void) => Promise<any[]>) {
  const client = new AgentInsight({ baseURL: 'http://localhost:4096', logLevel: 'off' });
  const queue: any[] = [];let waiting: ((r: IteratorResult<any>) => void) | null = null, closed = false, reads = 0;
  const push = (e: any) => { if (closed) return;if (waiting) { const resolve = waiting;waiting = null;resolve({ done: false, value: e }); } else queue.push(e); };
  const close = () => { closed = true;waiting?.({ done: true, value: undefined });waiting = null; };
  Object.defineProperty(client, 'client', { configurable: true, value: {
    session: { children: async () => ({ data: [] }), messages: async (opts: any) => { reads++;return { data: read ? await read(opts.signal, push) : messages }; } },
    event: { subscribe: async (opts: any) => {
      opts.signal.addEventListener('abort', close, { once: true });
      return { stream: { [Symbol.asyncIterator]() { return this; }, next: () => queue.length ? Promise.resolve({ done: false, value: queue.shift() }) : closed ? Promise.resolve({ done: true }) : new Promise(resolve => { waiting = resolve; }), return: async () => { close();return { done: true }; } } };
    } },
  } });
  client.sendPrompt = async (_id, _payload, opts) => new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    opts?.signal?.addEventListener('abort', abort, { once: true });
    for (const event of events) push(event);
    if (opts?.signal?.aborted) abort();
  });
  return { client, push, reads: () => reads, close };
}
for (const finish of ['stop', undefined]) test(`authoritative ${finish || 'idle without finish'} completion closes pending transport without cancellation`, async () => {
  const f = fixture(fullEvents(finish), snapshot(finish ? { finish } : {}));
  const controller = new AbortController();
  const result = await f.client.chat(session, payload, {}, { signal: controller.signal, streamTimeoutMs: 2000 });
  assert.equal(result.text, 'complete authoritative reply');assert.equal(controller.signal.aborted, false);assert.ok(f.reads() > 0);
});
test('idle with a partial snapshot is a timeout, not success', async () => {
  const partial = snapshot({ time: {} });const f = fixture(fullEvents(), partial);
  await assert.rejects(f.client.chat(session, payload, {}, { streamTimeoutMs: 300 }), { code: 'AGENT_TIMEOUT' });
});
test('a completed tool-call round is not final completion', async () => {
  const f = fixture(fullEvents('tool-calls'), snapshot({ finish: 'tool-calls' }));
  await assert.rejects(f.client.chat(session, payload, {}, { streamTimeoutMs: 300 }), { code: 'AGENT_TIMEOUT' });
});
test('an old round with the same prompt cannot complete the current user message', async () => {
  const old = snapshot();old[1].info.parentID = 'old-user';const f = fixture(fullEvents(), old);
  await assert.rejects(f.client.chat(session, payload, {}, { streamTimeoutMs: 300 }), { code: 'AGENT_TIMEOUT' });
});
test('heartbeat-only traffic without business output remains bounded by the global deadline', async () => {
  const f = fixture([], snapshot());const timer = setInterval(() => f.push({ type: 'server.heartbeat', properties: {} }), 5);
  try { await assert.rejects(f.client.chat(session, payload, {}, { idleTimeoutMs: 10, streamTimeoutMs: 300 }), { code: 'AGENT_TIMEOUT' }); }
  finally { clearInterval(timer); }
  assert.equal(f.reads(), 0);
});
test('new pending tool progress invalidates a snapshot read in flight', async () => {
  const f = fixture(fullEvents(), snapshot(), async (_signal, push) => {
    push({ type: 'message.part.updated', properties: { part: { sessionID: session, messageID: assistant, id: 'tool', type: 'tool', tool: 'read', state: { status: 'running', input: {} } } } });
    await new Promise(resolve => setTimeout(resolve, 5));return snapshot();
  });
  await assert.rejects(f.client.chat(session, payload, {}, { streamTimeoutMs: 300 }), { code: 'AGENT_TIMEOUT' });
});
test('a newer root message invalidates an old completed snapshot', async () => {
  const f = fixture(fullEvents(), snapshot(), async (_signal, push) => {
    push(message('assistant', 'new-assistant'));await new Promise(resolve => setTimeout(resolve, 5));return snapshot();
  });
  await assert.rejects(f.client.chat(session, payload, {}, { streamTimeoutMs: 300 }), { code: 'AGENT_TIMEOUT' });
});
test('external cancellation wins over a completed snapshot', async () => {
  const controller = new AbortController();const f = fixture(fullEvents(), snapshot(), async () => { controller.abort();return snapshot(); });
  await assert.rejects(f.client.chat(session, payload, {}, { signal: controller.signal, streamTimeoutMs: 300 }), { code: 'EXECUTION_CANCELLED' });
});
test('a model error observed during completion verification cannot become success', async () => {
  const f = fixture(fullEvents(), snapshot(), async (_signal, push) => {
    push({ type: 'session.error', properties: { sessionID: session, error: { message: 'model unavailable' } } });await new Promise(resolve => setTimeout(resolve, 5));return snapshot();
  });
  await assert.rejects(f.client.chat(session, payload, {}, { streamTimeoutMs: 300 }), { code: 'MODEL_ERROR' });
});

test('a truncated terminal response is a model failure, not a completed reply', async () => {
  const f = fixture(fullEvents('length'), snapshot({ finish: 'length' }));
  await assert.rejects(f.client.chat(session, payload, {}, { streamTimeoutMs: 300 }), { code: 'MODEL_ERROR' });
});
test('a pending tool in the authoritative snapshot cannot be treated as completed', async () => {
  const rows = snapshot({ finish: 'stop' }) as any[];
  rows[1].parts.push({ type: 'tool', tool: 'read', state: { status: 'running' } });
  const f = fixture(fullEvents('stop'), rows);
  await assert.rejects(f.client.chat(session, payload, {}, { streamTimeoutMs: 300 }), { code: 'AGENT_TIMEOUT' });
});

test('completion retries a temporarily incomplete snapshot without a new SSE event', async () => {
  let reads = 0;const f = fixture(fullEvents(), snapshot(), async () => ++reads === 1 ? snapshot({ time: {} }) : snapshot());
  const result = await f.client.chat(session, payload, {}, { streamTimeoutMs: 2000 });
  assert.equal(result.text, 'complete authoritative reply');assert.ok(reads >= 2);
});
test('a new root user turn cannot replace the user anchor of the current prompt', async () => {
  let reads = 0;
  const f = fixture(fullEvents(), snapshot(), async (_signal, push) => {
    if (++reads === 1) {
      push(message('user', 'other-user'));push(message('assistant', 'other-assistant', { time: { completed: 2 }, finish: 'stop' }));push(idle);
      await new Promise(resolve => setTimeout(resolve, 5));return snapshot();
    }
    return [{ info: { sessionID: session, role: 'user', id: 'other-user' }, parts: [] }, { info: { sessionID: session, role: 'assistant', id: 'other-assistant', parentID: 'other-user', finish: 'stop', time: { completed: 2 } }, parts: [{ type: 'text', text: 'wrong turn' }] }];
  });
  await assert.rejects(f.client.chat(session, payload, {}, { streamTimeoutMs: 300 }), { code: 'AGENT_TIMEOUT' });
});
for (const finish of ['length', 'content-filter', 'tool-calls']) test(`a synchronous ${finish} response cannot bypass the completion guard`, async () => {
  const f = fixture([], []);f.push({ type: 'server.heartbeat', properties: {} });
  f.client.sendPrompt = async () => ({ info: { id: assistant, finish }, parts: [{ type: 'text', text: 'partial answer' }] });
  await assert.rejects(f.client.chat(session, payload, {}, { streamTimeoutMs: 300 }), { code: 'MODEL_ERROR' });
});

test('an SDK-wrapped transport close after confirmed completion is not a model failure', async () => {
  const f = fixture([], snapshot({ finish: 'stop' }));
  f.client.sendPrompt = async (_id, _payload, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new Error('wrapped transport close')), { once: true });
    for (const event of fullEvents('stop')) f.push(event);
  });
  const result = await f.client.chat(session, payload, {}, { streamTimeoutMs: 2000 });
  assert.equal(result.text, 'complete authoritative reply');
});
test('an unrequested AbortError cannot turn a partial response into success', async () => {
  const f = fixture([], snapshot({ time: {} }));
  f.client.sendPrompt = async () => {
    for (const event of fullEvents()) f.push(event);
    await new Promise(resolve => setTimeout(resolve, 5));
    throw new DOMException('unexpected transport abort', 'AbortError');
  };
  await assert.rejects(f.client.chat(session, payload, {}, { streamTimeoutMs: 300 }), { code: 'MODEL_ERROR' });
});

test('an unrequested event-channel AbortError cannot be hidden by a nonempty HTTP response', async () => {
  const f = fixture([], []);
  (f.client as any).client.event.subscribe = async () => ({ stream: { [Symbol.asyncIterator]() { return this; }, next: async () => { throw new DOMException('unexpected SSE abort', 'AbortError'); }, return: async () => ({ done: true }) } });
  f.client.sendPrompt = async () => ({ info: { id: assistant }, parts: [{ type: 'text', text: 'partial response' }] });
  await assert.rejects(f.client.chat(session, payload, {}, { streamTimeoutMs: 300 }), { code: 'MODEL_ERROR' });
});

test('authoritative completed tools reconcile a missing SSE end notification', async () => {
  const tool = { id: 'persisted-tool', sessionID: session, messageID: assistant, type: 'tool', tool: 'bash', callID: 'call', state: { status: 'completed', input: { command: 'readonly' }, output: 'verified result' } };
  const rows = snapshot({ finish: 'stop' });rows[1].parts.unshift(tool);
  const running = { type: 'message.part.updated', properties: { part: { ...tool, state: { status: 'running', input: tool.state.input } } } };
  const f = fixture([message('user', user), running, ...fullEvents('stop').slice(1)], rows);
  const calls: any[] = [];
  const result = await f.client.chat(session, payload, { onTool: e => calls.push(e) }, { streamTimeoutMs: 2000 });
  assert.equal(result.text, 'complete authoritative reply');assert.ok(f.reads() > 0);
  assert.equal(calls.filter(e => e.phase === 'end').length, 1);assert.equal(calls.at(-1).output, 'verified result');
});
test('a pending tool from an earlier assistant in the current round still blocks completion', async () => {
  const rows = snapshot({ finish: 'stop' });rows.splice(1, 0, { info: { sessionID: session, role: 'assistant', id: 'earlier', parentID: user, time: { completed: 1 }, finish: 'tool-calls' }, parts: [{ type: 'tool', id: 'pending', state: { status: 'running' } }] });
  const f = fixture(fullEvents('stop'), rows);
  await assert.rejects(f.client.chat(session, payload, {}, { streamTimeoutMs: 300 }), { code: 'AGENT_TIMEOUT' });
});
test('explicit stop can finish a tool task without a final prose message', async () => {
  const rows = snapshot({ finish: 'stop' });rows[1].parts = [{ type: 'tool', id: 'tool', sessionID: session, messageID: assistant, tool: 'bash', state: { status: 'completed', input: {}, output: 'complete report' } }];
  const f = fixture(fullEvents('stop'), rows);const calls: any[] = [];
  const result = await f.client.chat(session, payload, { onTool: e => calls.push(e) }, { streamTimeoutMs: 2000 });
  assert.equal(result.text, '');assert.equal(calls.at(-1).output, 'complete report');
});
test('an unknown pending SSE tool cannot be discarded by an unrelated completed snapshot', async () => {
  const running = { type: 'message.part.updated', properties: { part: { id: 'unknown', sessionID: session, messageID: assistant, type: 'tool', tool: 'bash', state: { status: 'running' } } } };
  const f = fixture([message('user', user), running, ...fullEvents('stop').slice(1)], snapshot({ finish: 'stop' }));
  await assert.rejects(f.client.chat(session, payload, {}, { streamTimeoutMs: 300 }), { code: 'AGENT_TIMEOUT' });
});

test('a completed current HTTP reply confirms storage despite a late busy event on the open SSE channel', async () => {
  const rows = snapshot({ finish: 'stop' }), f = fixture([], rows);
  f.client.sendPrompt = async () => {
    for (const event of [...fullEvents('stop'), { type: 'session.status', properties: { sessionID: session, status: { type: 'busy' } } }]) f.push(event);
    await new Promise(resolve => setTimeout(resolve, 10));return rows.at(-1);
  };
  const result = await f.client.chat(session, payload, {}, { streamTimeoutMs: 700 });
  assert.equal(result.text, 'complete authoritative reply');assert.ok(f.reads() > 0);
});

test('HTTP completion triggers verification when the SSE channel becomes silent', async () => {
  const rows = snapshot({ finish: 'stop' }), f = fixture([], rows);
  f.client.sendPrompt = async () => {
    f.push(message('user', user));f.push(message('assistant', assistant));
    await new Promise(resolve => setTimeout(resolve, 10));return rows.at(-1);
  };
  assert.equal((await f.client.chat(session, payload, {}, { streamTimeoutMs: 2000 })).text, 'complete authoritative reply');
});
test('an old completed HTTP response cannot replace a newer assistant anchor', async () => {
  const rows = snapshot({ finish: 'stop' }), f = fixture([], rows);
  f.client.sendPrompt = async () => {
    f.push(message('user', user));f.push(message('assistant', 'newer-assistant'));
    await new Promise(resolve => setTimeout(resolve, 10));return rows.at(-1);
  };
  await assert.rejects(f.client.chat(session, payload, {}, { streamTimeoutMs: 300 }), { code: 'AGENT_TIMEOUT' });
});
test('external cancellation arriving with completed HTTP still wins', async () => {
  const rows = snapshot({ finish: 'stop' }), f = fixture([], rows), controller = new AbortController();
  f.client.sendPrompt = async () => {
    f.push(message('user', user));f.push(message('assistant', assistant));
    await new Promise(resolve => setTimeout(resolve, 10));controller.abort();return rows.at(-1);
  };
  await assert.rejects(f.client.chat(session, payload, {}, { signal: controller.signal, streamTimeoutMs: 300 }), { code: 'EXECUTION_CANCELLED' });
});

test('normal SSE EOF cannot promote partial HTTP text to success', async () => {
  const f = fixture([], []);
  f.client.sendPrompt = async () => { f.close();return { info: { id: assistant }, parts: [{ type: 'text', text: 'partial output' }] }; };
  await assert.rejects(f.client.chat(session, payload, {}, { streamTimeoutMs: 300 }), { code: 'MODEL_ERROR' });
});
test('heartbeat-only fallback cannot promote partial HTTP text to success', async () => {
  const f = fixture([], []);f.push({ type: 'server.heartbeat', properties: {} });
  f.client.sendPrompt = async () => ({ info: { id: assistant }, parts: [{ type: 'text', text: 'partial output' }] });
  await assert.rejects(f.client.chat(session, payload, {}, { streamTimeoutMs: 3500 }), { code: 'AGENT_TIMEOUT' });
});
test('SSE EOF waits for the authoritative HTTP completion snapshot instead of aborting it', async () => {
  let readCompleted = false;const rows = snapshot({ finish: 'stop' });
  const f = fixture([], rows, async signal => { await new Promise(resolve => setTimeout(resolve, 80));assert.equal(signal.aborted, false);readCompleted = true;return rows; });
  f.client.sendPrompt = async () => { f.push(message('user', user));f.push(message('assistant', assistant));await new Promise(resolve => setTimeout(resolve, 10));f.close();return rows.at(-1); };
  const result = await f.client.chat(session, payload, {}, { streamTimeoutMs: 2000 });
  assert.equal(readCompleted, true);assert.equal(result.text, 'complete authoritative reply');
});
