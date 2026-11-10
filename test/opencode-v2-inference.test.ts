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

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as plugin from '../scripts/opencode_plugin_otel'

const model = { providerID: 'local', id: 'mock' }
const step = (sessionID: string, assistantMessageID: string) => ({ type: 'session.step.started', created: 100, data: { sessionID, assistantMessageID, agent: 'build', model, started: 100 } })
async function fixture() {
  const factory = (plugin as any).createOpenCodeV2Adapter
  assert.equal(typeof factory, 'function')
  const records: any[] = [], events: any[] = []
  const context = { session: { context: async () => [] } }
  const adapter = factory(context, (r: any) => records.push(r), async (e: any) => events.push(e), { identityTimeoutMs: 20 })
  const request = (sessionID: string, kind = 'primary') => ({ sessionID, agent: 'build', model, kind, request: new Request('http://localhost/v1/chat/completions', { method: 'POST', body: '{}' }) })
  return { adapter, context, records, events, request }
}

test('V2 binds delayed step events to request identities, including concurrent sessions and retries', async () => {
  const f = await fixture()
  const requests = [f.request('ses_A'), f.request('ses_B')]
  for (const r of requests) {
    const modelRequest = { ...r, headers: {} }
    await f.adapter.modelRequest(modelRequest)
    r.request = new Request(r.request, { headers: modelRequest.headers })
  }
  await Promise.all(requests.map(r => f.adapter.request(r)))
  assert.ok(requests.every(r => !r.request.headers.has('x-agent-insight-message-id')))
  assert.equal(new Set(requests.map(r => r.request.headers.get('x-agent-insight-attempt-id'))).size, 2)
  for (const [i, r] of requests.entries()) await f.adapter.response({ ...r, response: new Response('{}', { status: i ? 200 : 503, headers: { 'x-request-id': `00000000-0000-4000-8000-00000000000${i}`, 'x-agent-insight-call-id': 'ffffffff-ffff-4fff-8fff-ffffffffffff' } }) })
  await f.adapter.event(step('ses_B', 'msg_B'))
  await f.adapter.event(step('ses_A', 'msg_A'))
  const retry = f.request('ses_A'), metadata = { ...retry, headers: {} }
  await f.adapter.modelRequest(metadata)
  retry.request = new Request(retry.request, { headers: metadata.headers })
  await f.adapter.request(retry)
  await f.adapter.response({ ...retry, response: new Response('{}', { headers: { 'x-request-id': '00000000-0000-4000-8000-000000000002' } }) })
  await f.adapter.event(step('ses_A', 'msg_A'))
  const bound = f.records.filter(r => r.kind === 'llm.attempt' && r.payload.call_id)
  assert.equal(bound.length, 3)
  assert.equal(bound.find(r => r.payload.status_code === 503).payload.messageID, 'msg_A')
  assert.equal(new Set(bound.filter(r => r.sessionID === 'ses_A').map(r => r.payload.request_id)).size, 1)
  assert.equal(new Set(bound.map(r => r.payload.transport_request_id)).size, 3)
})

test('V2 requires model-request identity and does not bind auxiliary requests to primary steps', async () => {
  const f = await fixture()
  await assert.rejects(f.adapter.request(f.request('ses_A')), /identity/i)
  const title = f.request('ses_A', 'title'), metadata = { ...title, headers: {} }
  await f.adapter.modelRequest(metadata)
  title.request = new Request(title.request, { headers: metadata.headers })
  await f.adapter.request(title)
  await f.adapter.event(step('ses_A', 'msg_A'))
  assert.equal(title.request.headers.get('x-agent-insight-session-id'), 'ses_A')
  assert.equal(title.request.headers.get('x-agent-insight-message-id'), null)
  assert.ok(!f.records.some(r => r.kind === 'llm.attempt'))
})

 test('V2 leaves ambiguous native steps unassigned after missing lifecycle events', async () => {
  const f = await fixture()
  for (let i = 0; i < 2; i++) {
    const r = f.request('ses_A'), metadata = { ...r, headers: {} }
    await f.adapter.modelRequest(metadata)
    r.request = new Request(r.request, { headers: metadata.headers })
    await f.adapter.request(r)
  }
  await f.adapter.event(step('ses_A', 'msg_A'))
  assert.ok(!f.records.some(r => r.kind === 'llm.attempt'))
  assert.ok(f.records.some(r => r.kind === 'llm.correlation.unbound'))
})


test('V2 recognizes config-defined providers added after transform and isolates lost streams to managed requests', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-inference-hooks-'));
  const before = { ...process.env };
  const registry: Record<string, any> = {};
  const managed = 'http://127.0.0.1:18080/managed/opencode/local';
  const runtime = path.join(root, 'inference-runtime');
  fs.mkdirSync(runtime, { recursive: true });
  fs.mkdirSync(path.join(root, 'inference-proxy'));
  fs.writeFileSync(path.join(root, 'inference-proxy/installation.json'), JSON.stringify({ explicitEnabled: true, enabled: false, agents: ['opencode'] }));
  fs.writeFileSync(path.join(root, 'inference-proxy/config-state.json'), JSON.stringify({ files: { config: { agent: 'opencode', fields: { local: { managed } } } } }));
  for (const name of ['inference_proxy.mjs', 'inference_config.mjs', 'inference_gateway.mjs']) fs.copyFileSync(path.resolve('scripts', name), path.join(runtime, name));
  Object.assign(process.env, { AGENT_INSIGHT_HOME: root, AGENT_INSIGHT_OPENCODE_SPOOL_DIR: path.join(root, 'spool'), AGENT_INSIGHT_OPENCODE_UPLOADER: path.join(root, 'missing'), AGENT_INSIGHT_OPENCODE_HEARTBEAT_MS: '0', AGENT_INSIGHT_OPENCODE_OTEL_ENABLE: 'true', AGENT_INSIGHT_API_KEY: '', AGENT_INSIGHT_HOST: '' });
  delete process.env.AGENT_INSIGHT_DATA_DIR;
  let cleanup: any;
  let endStream!: () => void;
  try {
    cleanup = await plugin.setupOpenCodeV2({ location: { directory: root }, session: { context: async () => [], hook: async (name: string, fn: any) => { registry[name] = fn; } },
      provider: { transform: async (fn: any) => fn({ list: () => [], update: () => { throw new Error('no configured providers yet'); } }) },
      event: { subscribe: async function* ({ signal }: any) { await new Promise<void>(resolve => { endStream = resolve; signal.addEventListener('abort', resolve, { once: true }); }); } } });
    const native: any = { sessionID: 'ses_A', agent: 'build', model, kind: 'primary', baseURL: managed, headers: {} };
    await registry['model.request'](native);
    assert.ok(native.headers['x-agent-insight-request-id']);
    const unrelated: any = { ...native, baseURL: 'https://direct.example/v1', headers: {} };
    await registry['model.request'](unrelated);
    assert.deepEqual(unrelated.headers, {});
    endStream(); await new Promise(resolve => setImmediate(resolve));
    native.request = new Request(managed + '/chat/completions', { method: 'POST', headers: native.headers, body: '{}' });
    await assert.rejects(registry['http.request'](native), /event stream unavailable/);
    unrelated.request = new Request('https://direct.example/v1/chat/completions', { method: 'POST' });
    await registry['http.request'](unrelated);
    assert.equal(unrelated.request.headers.has('x-agent-insight-session-id'), false);
  } finally {
    await cleanup?.();
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
