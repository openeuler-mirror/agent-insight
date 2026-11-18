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

import test, { type TestContext, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { collectQoderHook, buildQoderOtlpPayload } from '../scripts/qoder_trace_collector.mjs';
import { normalizeOtlpTraces } from '@/lib/ingest/otel/normalize';
import { aggregateOtelTraceEvents } from '@/lib/ingest/otel/aggregate';
import { buildAgentCallTree, type AgentEvent, type AgentNode, type RawInteraction } from '@/lib/engine/observability/agent-trace';
import { inferenceAnalysisTarget } from '@/lib/trace/inference-analysis';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as plugin from '../scripts/opencode_plugin_otel';
import { temporaryDirectory, listen, closeServer, copyProxyRuntime, runProcess as run } from './helpers/inference-fixtures';

describe("Gateway HTTP transport and call ownership", () => {
  const gatewayModule = '../scripts/inference_gateway.mjs';
  async function fixture(t: any, handler: http.RequestListener, options: any = {}) {
      const gateway = await import(gatewayModule).catch(() => ({}));
      assert.equal(typeof gateway.createInferenceGateway, 'function', 'unified gateway must be implemented');
      const dir = temporaryDirectory('inference-gateway-');
      const upstream = http.createServer(handler);
      await listen(upstream);
      const proxy = gateway.createInferenceGateway({ routes: [{ basePath: '/qoder/v1', upstreamBaseUrl: `http://127.0.0.1:${(upstream.address() as any).port}/v1`, agent: options.agent || 'qoder', protocol: 'openai' }], ...options }, { insightDir: dir, apiKey: '' });
      await listen(proxy);
      t.after(async () => { for (const server of [proxy, upstream]) { await closeServer(server); } fs.rmSync(dir, { recursive: true, force: true }); });
      return { dir, url: `http://127.0.0.1:${(proxy.address() as any).port}/qoder/v1`, gateway, proxy, upstream };
  }
  const body = JSON.stringify({ model: 'probe', messages: [{ role: 'user', content: 'private prompt' }], stream: true });
  const post = (url: string, extra: any = {}) => fetch(url + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', 'session-id': 'session', authorization: 'Bearer private-key', 'x-request-id': 'forged', 'x-agent-insight-call-id': 'legacy-forged' }, body, ...extra });
  function records(dir: string): any[] {
      const walk = (at: string): string[] => fs.existsSync(at) ? fs.readdirSync(at, { withFileTypes: true }).flatMap(f => f.isDirectory() ? walk(path.join(at, f.name)) : f.name.endsWith('.json') ? [path.join(at, f.name)] : []) : [];
      return walk(path.join(dir, 'inference-gateway')).map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
  }

  test('gateway preserves SSE bytes and auth, injects unique call IDs, persists no prompt or credential', async t => {
      const seen: any[] = [];
      const wire = 'data: {"id":"response-one","choices":[]}\r\n\r\ndata: [DONE]\n\n';
      const f = await fixture(t, async (req, res) => {
          let data = ''; for await (const chunk of req) data += chunk;
          seen.push({ headers: req.headers, data, path: req.url });
          res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'upstream-id', 'x-agent-insight-call-id': 'upstream-legacy' });
          res.write(wire.slice(0, 17)); setTimeout(() => res.end(wire.slice(17)), 15);
      });
      const responses = await Promise.all([post(f.url), post(f.url)]);
      assert.deepEqual(await Promise.all(responses.map(r => r.text())), [wire, wire]);
      const ids = responses.map(r => r.headers.get('x-request-id'));
      assert.equal(new Set(ids).size, 2); assert.ok(ids.every(id => /^[a-f0-9-]{36}$/.test(id!)));
      assert.deepEqual(seen.map(r => r.headers['x-request-id']).sort(), [...ids].sort());
      assert.ok(seen.every(r => r.data === body && r.path === '/v1/chat/completions' && r.headers.authorization === 'Bearer private-key'));
      assert.ok(seen.every(r => !r.headers['session-id'] && !r.headers['x-agent-insight-call-id']));
      assert.deepEqual(responses.map(r => r.headers.get('x-agent-insight-call-id')), ids, 'old collectors receive a local response alias');
      const journal = records(f.dir); assert.equal(journal.length, 2);
      assert.ok(journal.every(r => r.response_id === 'response-one' && r.state === 'completed' && r.session_id === 'session'));
      assert.doesNotMatch(JSON.stringify(journal), /private prompt|private-key/);
  });

  test('gateway records each failed retry without retrying upstream itself', async t => {
      let count = 0;
      const f = await fixture(t, (_req, res) => { count++; res.writeHead(count === 1 ? 503 : 200, { 'content-type': 'application/json', 'retry-after': '0' }); res.end(count === 1 ? '{"error":{"id":"not-response","message":"failed"}}' : '{"id":"success"}'); });
      for (const status of [503, 200]) { const r = await post(f.url); assert.equal(r.status, status); assert.equal(r.headers.get('retry-after'), '0'); await r.text(); }
      const journal = records(f.dir).sort((a, b) => a.started_at.localeCompare(b.started_at));
      assert.equal(count, 2); assert.equal(journal.length, 2);
      assert.equal(journal[0].response_id, undefined); assert.equal(journal[1].response_id, 'success');
      assert.equal(new Set(journal.map(r => r.call_id)).size, 2);
  });

  test('gateway rejects unconfigured paths and does not follow upstream redirects', async t => {
      let count = 0;
      const f = await fixture(t, (_req, res) => { count++; res.writeHead(307, { location: 'http://127.0.0.1:1/leak' }); res.end(); });
      assert.equal((await fetch(f.url + '/not-a-model', { method: 'POST' })).status, 404);
      assert.equal((await fetch(f.url + '/chat/completions', { method: 'POST', redirect: 'manual' })).status, 307);
      assert.equal(count, 1);
  });

  test('gateway propagates client cancellation and persists interrupted inference', async t => {
      let closed!: () => void;
      const upstreamClosed = new Promise<void>(resolve => closed = resolve);
      const f = await fixture(t, (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"id":"cancelled-response"}\n\n'); res.on('close', closed); });
      const controller = new AbortController();
      const response = await post(f.url, { signal: controller.signal });
      await response.body!.getReader().read(); controller.abort();
      await Promise.race([upstreamClosed, new Promise((_, reject) => setTimeout(() => reject(new Error('upstream was not cancelled')), 1000).unref())]);
      assert.equal(records(f.dir)[0].state, 'cancelled');
  });

  test('Qoder gateway IDs survive hook, OTLP aggregation, JSON and final child nodes; failures remain trace-only', async t => {
      let count = 0;
      const f = await fixture(t, (_req, res) => { count++; res.writeHead(count === 1 ? 503 : 200, { 'content-type': 'application/json' }); res.end(count === 1 ? '{"error":{}}' : `{"id":"response-${count}"}`); });
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) { const r = await post(f.url); ids.push(r.headers.get('x-request-id')!); await r.text(); }
      const now = new Date().toISOString(); const transcript = path.join(f.dir, 'session.jsonl');
      fs.writeFileSync(transcript, [
          { type: 'user', sessionId: 'session', timestamp: new Date(Date.now() - 5000).toISOString(), message: { content: 'start' } },
          ...[2, 3].map(i => ({ type: 'assistant', sessionId: 'session', agentId: i === 3 ? 'child' : undefined, timestamp: now, message: { id: `response-${i}`, model: 'probe', content: [{ type: 'text', text: 'ok' }] } })),
          { type: 'assistant', sessionId: 'session', timestamp: now, isApiErrorMessage: true, message: { id: 'local-error', model: '<synthetic>', content: [{ type: 'text', text: 'error' }] } },
      ].map(r => JSON.stringify(r)).join('\n'));
      const result = await collectQoderHook({ hook_event_name: 'Stop', session_id: 'session', transcript_path: transcript }, { insightDir: f.dir, disableUploadKick: true, env: { AGENT_INSIGHT_API_KEY: '' } });
      const payload = JSON.parse(fs.readFileSync(result.pendingFile!, 'utf8'));
      const record = aggregateOtelTraceEvents('session', normalizeOtlpTraces(payload))!;
      const interactions: any[] = JSON.parse(JSON.stringify(record.interactions));
      const flatten = (n: any): any[] => [...n.events.filter((e: any) => e.kind === 'llm'), ...n.children.flatMap(flatten)];
      const llms = flatten(buildAgentCallTree(interactions));
      for (const i of [2, 3]) {
          const node = llms.find(n => n.interaction.messageID === `response-${i}`); assert.ok(node);
          assert.deepEqual(node.interaction.inference_call_ids, [ids[i - 1]]);
          assert.deepEqual(inferenceAnalysisTarget({ framework: 'qoder', scope: 'llm', interaction: node.interaction }).callIds, [ids[i - 1]]);
      }
      const target = inferenceAnalysisTarget({ framework: 'qoder', scope: 'trace', rootSessionId: 'session', interactions });
      assert.deepEqual([...target.callIds!].sort(), [...ids].sort());
      assert.deepEqual(target.unassignedCallIds, [ids[0]]);
      assert.ok(llms.filter(n => n.interaction.model === '<synthetic>').every(n => !n.interaction.inference_call_ids?.length));
  });

  test('gateway captures Responses and Anthropic identities without mistaking tool IDs for response IDs', async t => {
      const f = await fixture(t, (req, res) => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(req.url?.endsWith('/responses')
              ? 'event: response.created\ndata: {"response":{"id":"resp-1"}}\n\nevent: response.output_item.added\ndata: {"item":{"id":"tool-1"}}\n\n'
              : 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-1"}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","content_block":{"id":"tool-2"}}\n\n');
      });
      await (await fetch(f.url + '/responses', { method: 'POST', body: '{}' })).text();
      const direct = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('event: message_start\ndata: {"type":"message_start","message":{"id":"msg-1"}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","content_block":{"id":"tool-2"}}\n\n'); });
      await listen(direct);
      const gateway = f.gateway.createInferenceGateway({ routes: [{ basePath: '/v1', agent: 'qoder', protocol: 'anthropic', upstreamBaseUrl: `http://127.0.0.1:${(direct.address() as any).port}` }] }, { insightDir: f.dir, apiKey: '' });
      await listen(gateway);
      t.after(() => { gateway.closeAllConnections(); gateway.close(); direct.closeAllConnections(); direct.close(); });
      await (await fetch(`http://127.0.0.1:${(gateway.address() as any).port}/v1/messages`, { method: 'POST', body: '{}' })).text();
      assert.deepEqual(records(f.dir).map(r => r.response_id).sort(), ['msg-1', 'resp-1']);
  });

  test('OpenCode recovers pre-header cancellation from gateway journal with exact message ownership', async t => {
      let received!: () => void;
      const started = new Promise<void>(resolve => received = resolve);
      const f = await fixture(t, () => received(), { agent: 'opencode' });
      process.env.AGENT_INSIGHT_UPLOADER_NO_MAIN = '1';
      const uploader = await import('../scripts/opencode_uploader_client.js');
      assert.equal(typeof uploader.applyInferenceGatewayRecords, 'function');
      const records: any[] = [{ kind: 'event', payload: { type: 'message.updated', event: { properties: { info: { id: 'msg-a', sessionID: 'session', parentID: 'user', role: 'assistant', agent: 'build', modelID: 'probe', providerID: 'gateway' } } } } }];
      const state = uploader.buildState(records);
      const requestId = 'oc_' + crypto.createHash('sha256').update(JSON.stringify(['session', 'msg-a'])).digest('hex').slice(0, 32);
      const controller = new AbortController();
      const pending = post(f.url, { signal: controller.signal, headers: { 'x-agent-insight-session-id': 'session', 'x-agent-insight-message-id': 'msg-a', 'x-agent-insight-request-id': requestId, 'x-agent-insight-attempt-id': 'attempt-a' } }).catch(e => e);
      await started; controller.abort(); await pending;
      const call = recordsFromDisk(f.dir)[0];
      uploader.applyInferenceGatewayRecords(state, f.dir, '');
      const messages: any[] = uploader.mergeGraph(state, 'session');
      assert.deepEqual(messages.find((m: any) => m.messageID === 'msg-a')?.inference_call_ids, [call.call_id]);
      const oldSig = uploader.buildSignature({ interactionCount: 1, finalResultLength: 0, lastTs: 1, completed: true, traceCompletedAt: '', cliCompleted: true, toolCallCount: 0, tokens: 0, recordCount: 0 });
      assert.equal(uploader.isSignatureUnchanged(oldSig, oldSig + '|inference=changed'), false);
  });
  const recordsFromDisk = records;

  test('OpenCode retries late gateway correlation after upload 503 without any new Agent events', async t => {
      const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"ok"}'); }, { agent: 'opencode' });
      const uploads: any[] = [];
      const receiver = http.createServer(async (req, res) => { let body = ''; for await (const c of req) body += c; uploads.push(JSON.parse(body)); res.writeHead(uploads.length === 2 ? 503 : 200); res.end('{}'); });
      await listen(receiver);
      t.after(() => { receiver.closeAllConnections(); receiver.close(); });
      const spool = path.join(f.dir, 'spool', 'today'); fs.mkdirSync(spool, { recursive: true });
      let selectedFile = path.join(spool, 'events.jsonl');
      fs.writeFileSync(path.join(spool, 'other.jsonl'), '{}\n');
      const info = { id: 'msg-late', sessionID: 'ses_late', role: 'assistant', agent: 'build', modelID: 'probe', providerID: 'gateway', time: { created: Date.now(), completed: Date.now() } };
      fs.writeFileSync(path.join(spool, 'events.jsonl'), [
          { kind: 'event', payload: { type: 'message.updated', event: { properties: { info } } } },
          { kind: 'event', payload: { type: 'message.part.updated', event: { properties: { part: { id: 'text', sessionID: 'ses_late', messageID: 'msg-late', type: 'text', text: 'done' } } } } },
          { kind: 'plugin.shutdown', sessionID: 'ses_late' },
      ].map(r => JSON.stringify(r)).join('\n'));
      const run = async () => {
          const env = { ...process.env };
          for (const key of Object.keys(env)) if (key.startsWith('AGENT_INSIGHT_')) delete env[key];
          Object.assign(env, { AGENT_INSIGHT_HOME: f.dir, AGENT_INSIGHT_API_KEY: '', AGENT_INSIGHT_HOST: `http://127.0.0.1:${(receiver.address() as any).port}`, AGENT_INSIGHT_OPENCODE_SPOOL_DIR: path.dirname(spool), AGENT_INSIGHT_UPLOADER_SPOOL_FILE: selectedFile });
          const child = spawn(process.execPath, [path.resolve('scripts/opencode_uploader_client.js')], { env, stdio: 'ignore' });
          assert.equal(await new Promise(resolve => child.on('exit', resolve)), 0);
      };
      await run(); assert.equal(uploads.length, 1);
      const requestId = 'oc_' + crypto.createHash('sha256').update(JSON.stringify(['ses_late', 'msg-late'])).digest('hex').slice(0, 32);
      const response = await post(f.url, { headers: { 'x-agent-insight-session-id': 'ses_late', 'x-agent-insight-message-id': 'msg-late', 'x-agent-insight-request-id': requestId, 'x-agent-insight-attempt-id': 'attempt-late' } });
      await response.text(); const id = response.headers.get('x-request-id');
      selectedFile = path.join(spool, 'other.jsonl');
      await run(); assert.equal(uploads.length, 2);
      await run(); assert.equal(uploads.length, 3, 'failed correlation upload must retry even when spool and journal are unchanged');
      assert.ok(uploads[2].interactions.some((m: any) => m.inference_call_ids?.includes(id)));
  });

  test('gateway timeout has a call ID and never invents an upstream response ID', async t => {
      const f = await fixture(t, (_req, _res) => {}, { timeoutMs: 20 });
      const response = await post(f.url); await response.text();
      assert.equal(response.status, 504);
      assert.equal(response.headers.get('x-agent-insight-call-id'), response.headers.get('x-request-id'));
      const [record] = records(f.dir); assert.equal(record.call_id, response.headers.get('x-request-id'));
      assert.equal(record.state, 'timeout'); assert.equal(record.response_id, undefined);
  });

  test('Qoder duplicate service response IDs stay unassigned instead of binding two attempts to one LLM', async t => {
      const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"duplicate"}'); });
      for (let i = 0; i < 2; i++) await (await post(f.url)).text();
      const transcript = path.join(f.dir, 'session.jsonl');
      fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', sessionId: 'session', timestamp: new Date().toISOString(), message: { id: 'duplicate', model: 'probe', content: [{ type: 'text', text: 'ok' }] } }));
      const result = await collectQoderHook({ hook_event_name: 'Stop', session_id: 'session', transcript_path: transcript }, { insightDir: f.dir, disableUploadKick: true, env: { AGENT_INSIGHT_API_KEY: '' } });
      const record = aggregateOtelTraceEvents('session', normalizeOtlpTraces(JSON.parse(fs.readFileSync(result.pendingFile!, 'utf8'))))!;
      const interactions = record.interactions as any[];
      assert.ok(interactions.every(i => !i.inference_call_ids?.length));
      assert.equal(interactions.flatMap(i => i.inference_unassigned_calls ?? []).length, 2);
  });

  test('Qoder CLI gateway data fixture correlates repeated and concurrent child calls while failed retries stay trace-only', async t => {
      const received: Array<{ label: string; id: string }> = [];
      let active = 0, peak = 0;
      const f = await fixture(t, async (req, res) => {
          let body = ''; for await (const chunk of req) body += chunk;
          const { label, fail } = JSON.parse(body);
          received.push({ label, id: String(req.headers['x-request-id']) });
          active++; peak = Math.max(peak, active);
          await new Promise(resolve => setTimeout(resolve, label.startsWith('child-a') ? 30 : 10));
          active--;
          res.writeHead(fail ? 503 : 200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(fail ? { error: { id: 'local-error-id' } } : { id: `response-${label}` }));
      });
      const session = 'parallel-fixture', started = new Date().toISOString();
      const transcript = path.join(f.dir, 'parallel.jsonl');
      const options = { insightDir: f.dir, disableUploadKick: true, env: { AGENT_INSIGHT_API_KEY: '' } };
      const calls: Array<{ label: string; id: string; child?: string; fail: boolean; completed: string }> = [];
      const invoke = async (label: string, child?: string, fail = false, sessionId = session) => {
          const response = await post(f.url, { headers: { 'session-id': sessionId }, body: JSON.stringify({ label, fail }) });
          await response.text(); assert.equal(response.status, fail ? 503 : 200);
          const id = response.headers.get('x-request-id')!;
          if (sessionId === session) calls.push({ label, id, child, fail, completed: new Date().toISOString() });
          return id;
      };
      await invoke('root-first');
      for (const child of ['child-a', 'child-b']) await collectQoderHook({ hook_event_name: 'SubagentStart', session_id: session, agent_id: child, agent_type: child }, options);
      await Promise.all([
          (async () => { await invoke('child-a-first', 'child-a'); await invoke('child-a-second', 'child-a'); })(),
          (async () => { await invoke('child-b-failed', 'child-b', true); await invoke('child-b-retry', 'child-b'); })(),
      ]);
      await invoke('root-last');
      const foreignId = await invoke('root-first', undefined, false, 'other-session');
      assert.ok(peak >= 2, 'the inference service must receive overlapping calls');
      assert.equal(new Set(received.map(item => item.id)).size, received.length);
      for (const call of calls) assert.ok(received.some(item => item.id === call.id && item.label === call.label));
      fs.writeFileSync(transcript, [
          { type: 'user', sessionId: session, timestamp: started, message: { content: 'parallel probe' } },
          ...calls.map(call => ({ type: 'assistant', sessionId: session, agentId: call.child, timestamp: call.completed, isApiErrorMessage: call.fail,
              message: { id: call.fail ? 'local-error-id' : `response-${call.label}`, model: call.fail ? '<synthetic>' : 'probe', content: [
                  { type: 'text', text: call.label },
                  ...(call.label === 'root-first' ? ['child-a', 'child-b'].map(child => ({ type: 'tool_use', id: `spawn-${child}`, name: 'Agent', input: { subagent_type: child, prompt: child } })) : []),
              ] } })),
          ...['child-a', 'child-b'].map(child => ({ type: 'user', sessionId: session, timestamp: new Date().toISOString(),
              message: { content: [{ type: 'tool_result', tool_use_id: `spawn-${child}`, content: child }] }, toolUseResult: { agentId: child, agentType: child } })),
      ].map(row => JSON.stringify(row)).join('\n'));
      for (const child of ['child-a', 'child-b']) await collectQoderHook({ hook_event_name: 'SubagentStop', session_id: session, agent_id: child, agent_type: child }, options);
      const collected = await collectQoderHook({ hook_event_name: 'Stop', qoder_product: 'cli', session_id: session, transcript_path: transcript }, options);
      const record = aggregateOtelTraceEvents(session, normalizeOtlpTraces(JSON.parse(fs.readFileSync(collected.pendingFile!, 'utf8'))))!;
      const interactions = JSON.parse(JSON.stringify(record.interactions));
      const tree = buildAgentCallTree(interactions);
      assert.ok(tree);
      for (const call of calls.filter(item => !item.fail)) {
          const owner: AgentNode | undefined = call.child ? tree.children.find(node => node.sessionId === call.child) : tree;
          assert.ok(owner, `missing owner ${call.child}`);
          const node: AgentEvent | undefined = owner.events.find(event => event.kind === 'llm' && event.interaction.messageID === `response-${call.label}`);
          assert.ok(node, `missing LLM ${call.label}`);
          assert.deepEqual(node.interaction.inference_call_ids, [call.id]);
          assert.deepEqual(inferenceAnalysisTarget({ framework: 'qoder', scope: 'llm', interaction: node.interaction }).callIds, [call.id]);
      }
      const target = inferenceAnalysisTarget({ framework: 'qoder', scope: 'trace', rootSessionId: session, interactions });
      assert.deepEqual([...target.callIds!].sort(), calls.map(call => call.id).sort());
      assert.deepEqual(target.unassignedCallIds, calls.filter(call => call.fail).map(call => call.id));
      assert.ok(!target.callIds?.includes(foreignId));
      assert.ok(interactions.filter((item: any) => item.model === '<synthetic>').every((item: any) => !item.inference_call_ids?.length));
  });

  test('gateway uses installed account configuration when the shell has no API key', async t => {
      const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"account-response"}'); });
      fs.writeFileSync(path.join(f.dir, 'config'), 'AGENT_INSIGHT_API_KEY=local-account\n');
      const proxy = f.gateway.createInferenceGateway({ routes: [{ basePath: '/v1', agent: 'qoder', protocol: 'openai', upstreamBaseUrl: `http://127.0.0.1:${(f.upstream.address() as any).port}/v1` }] }, { insightDir: f.dir, env: {} });
      await listen(proxy);
      t.after(() => { proxy.closeAllConnections(); proxy.close(); });
      await (await post(`http://127.0.0.1:${(proxy.address() as any).port}/v1`)).text();
      const account = crypto.createHash('sha256').update('local-account').digest('hex').slice(0, 16);
      assert.ok(fs.existsSync(path.join(f.dir, 'inference-gateway', account, 'qoder')));
  });

  test('OpenCode preserves distinct gateway calls even if transport replays the same native attempt ID', async t => {
      const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"ok"}'); }, { agent: 'opencode' });
      process.env.AGENT_INSIGHT_UPLOADER_NO_MAIN = '1';
      const uploader = await import('../scripts/opencode_uploader_client.js');
      const info = { id: 'msg-replay', sessionID: 'ses_replay', role: 'assistant' };
      const state = uploader.buildState([{ kind: 'event', payload: { type: 'message.updated', event: { properties: { info } } } }]);
      const requestId = 'oc_' + crypto.createHash('sha256').update(JSON.stringify(['ses_replay', 'msg-replay'])).digest('hex').slice(0, 32);
      const ids = [];
      for (let i = 0; i < 2; i++) {
          const r = await post(f.url, { headers: { 'x-agent-insight-session-id': 'ses_replay', 'x-agent-insight-message-id': 'msg-replay', 'x-agent-insight-request-id': requestId, 'x-agent-insight-attempt-id': 'replayed-attempt' } });
          await r.text(); ids.push(r.headers.get('x-request-id'));
      }
      uploader.applyInferenceGatewayRecords(state, f.dir, '');
      const messages: any[] = uploader.mergeGraph(state, 'ses_replay');
      assert.deepEqual(messages[0].inference_call_ids.sort(), ids.sort());
  });


  test('OpenCode V2 joins exact transport proof to native LLM and leaves missing or conflicting proof unassigned', async t => {
      const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"ok"}'); }, { agent: 'opencode' });
      process.env.AGENT_INSIGHT_UPLOADER_NO_MAIN = '1';
      const uploader = await import('../scripts/opencode_uploader_client.js');
      const native = (mid: string) => ({ kind: 'event', payload: { type: 'message.updated', event: { properties: { info: { id: mid, sessionID: 'session', role: 'assistant' } } } } });
      const proof = (mid: string, request: string, attempt: string) => ({ kind: 'llm.attempt', sessionID: 'session', payload: { messageID: mid, request_id: 'oc_' + crypto.createHash('sha256').update(JSON.stringify(['session', mid])).digest('hex').slice(0, 32), transport_request_id: request, attempt_id: attempt } });
      const ids = [];
      for (const [request, attempt, message] of [['oc_v2_good', 'a', ''], ['oc_v2_missing', 'b', ''], ['oc_v2_ambiguous', 'c', ''], ['oc_v2_wrong', 'd', 'wrong']]) {
          const response = await post(f.url, { headers: { 'x-agent-insight-session-id': 'session', 'x-agent-insight-request-id': request, 'x-agent-insight-attempt-id': attempt, 'x-agent-insight-message-id': message } });
          await response.text(); ids.push(response.headers.get('x-request-id'));
      }
      const state = uploader.buildState([native('msg-a'), native('msg-b'), proof('msg-a', 'oc_v2_good', 'a'), proof('msg-a', 'oc_v2_ambiguous', 'c'), proof('msg-b', 'oc_v2_ambiguous', 'c'), proof('msg-a', 'oc_v2_wrong', 'd')]);
      uploader.applyInferenceGatewayRecords(state, f.dir, '');
      const messages: any[] = uploader.mergeGraph(state, 'session');
      assert.deepEqual(messages.find((m: any) => m.messageID === 'msg-a').inference_call_ids, [ids[0]]);
      assert.deepEqual(messages.flatMap((m: any) => m.inference_unassigned_calls || []).map((c: any) => c.call_id).sort(), ids.slice(1).sort());
  });
});

describe("OpenCode 1.x request correlation", () => {
  process.env.AGENT_INSIGHT_UPLOADER_NO_MAIN = "1"
  const uploaderPromise = import("../scripts/opencode_uploader_client.js")

  function proxyHookFixture(t: TestContext, installed = true) {
    const home = temporaryDirectory("opencode proxy #")
    const insightDir = path.join(home, ".agent-insight")
    const directory = path.join(home, "project")
    fs.mkdirSync(path.join(directory, ".git"), { recursive: true })
    if (installed) copyProxyRuntime(insightDir)
    t.after(() => fs.rmSync(home, { recursive: true, force: true }))
    return { home, insightDir, directory }
  }

  async function runProxyConfigHook(fixture: ReturnType<typeof proxyHookFixture>, requestAfterConfigFailure?: string, configuredEndpoint = "https://upstream.invalid/v1") {
    const pluginUrl = pathToFileURL(path.resolve("scripts/opencode_plugin_otel.ts")).href
    const script = `
      const imported = await import(${JSON.stringify(pluginUrl)})
      const initialize = imported.default?.default ?? imported.default
      const fetchBeforeConfig = globalThis.fetch
      const hooks = await initialize({ directory: ${JSON.stringify(fixture.directory)} })
      const originalFetch = async () => new Response('original')
      const cfg = { provider: { gateway: { npm: '@ai-sdk/openai-compatible', options: {
        baseURL: ${JSON.stringify(configuredEndpoint)}, apiKey: 'fixture-secret', fetch: originalFetch,
      } } } }
      if (${JSON.stringify(requestAfterConfigFailure)} !== undefined) {
        let configError = '', requestError = ''
        try { await hooks.config(cfg) } catch (error) { configError = error.message }
        try { await fetch(${JSON.stringify(requestAfterConfigFailure)}, { method: 'POST', body: '{}' }) }
        catch (error) { requestError = error.message }
        process.stdout.write(JSON.stringify({ configError, requestError }))
        process.exit(0)
      }
      await hooks.config(cfg)
      if (globalThis.fetch !== fetchBeforeConfig) throw new Error('Unmanaged model traffic must retain the original global fetch')
      const output = { headers: { existing: 'kept' } }
      await hooks['chat.headers']({ sessionID: 'unmanaged-session', agent: 'build', message: { id: 'user' }, model: { id: 'probe', providerID: 'gateway' } }, output)
      if (JSON.stringify(output.headers) !== JSON.stringify({ existing: 'kept' })) throw new Error('Unmanaged model headers must remain unchanged')
      process.stdout.write(JSON.stringify({
        baseURL: cfg.provider.gateway.options.baseURL,
        apiKey: cfg.provider.gateway.options.apiKey,
        fetchPreserved: cfg.provider.gateway.options.fetch === originalFetch,
        correlationAvailable: typeof hooks['chat.headers'] === 'function',
      }))
    `
    const env: NodeJS.ProcessEnv = {
      ...process.env, HOME: fixture.home, AGENT_INSIGHT_HOME: fixture.insightDir,
      XDG_CONFIG_HOME: path.join(fixture.home, ".config"), OPENCODE_CONFIG: "", OPENCODE_CONFIG_DIR: "",
      OPENCODE_DISABLE_PROJECT_CONFIG: "false", AGENT_INSIGHT_API_KEY: "", AGENT_INSIGHT_HOST: "",
      AGENT_INSIGHT_OPENCODE_OTEL_ENABLE: "true", AGENT_INSIGHT_OPENCODE_HEARTBEAT_MS: "0",
      AGENT_INSIGHT_OPENCODE_SPOOL_DIR: path.join(fixture.home, "spool"),
      AGENT_INSIGHT_OPENCODE_UPLOADER: path.join(fixture.home, "absent-uploader.js"),
    }
    delete env.AGENT_INSIGHT_DATA_DIR
    return run(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], env)
  }

  test("OpenCode config hook keeps collection and provider options when proxy runtime is absent or disabled", async t => {
    for (const installed of [false, true]) {
      const fixture = proxyHookFixture(t, installed)
      const result = await runProxyConfigHook(fixture)
      assert.equal(result.code, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout), {
        baseURL: "https://upstream.invalid/v1", apiKey: "fixture-secret", fetchPreserved: true, correlationAvailable: true,
      })
      assert.equal(fs.existsSync(path.join(fixture.insightDir, "inference-proxy")), false)
    }
  })

  test("OpenCode config hook leaves new project and merged endpoints unchanged even when proxy is enabled", async t => {
    const fixture = proxyHookFixture(t)
    const root = path.join(fixture.insightDir, "inference-proxy")
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, "installation.json"), JSON.stringify({ enabled: true, agents: ["opencode"], files: [], launchers: [] }))
    const projectConfig = path.join(fixture.directory, "opencode.json")
    const content = JSON.stringify({ provider: { project: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://project.invalid/v1" } } } })
    fs.writeFileSync(projectConfig, content)
    const result = await runProxyConfigHook(fixture)
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { baseURL: 'https://upstream.invalid/v1', apiKey: 'fixture-secret', fetchPreserved: true, correlationAvailable: true })
    assert.equal(fs.readFileSync(projectConfig, 'utf8'), content)
    assert.equal(fs.existsSync(path.join(root, 'runtime.json')), false)
  })

  test("OpenCode config hook rejects installed proxy failures instead of allowing direct inference", async t => {
    const fixture = proxyHookFixture(t)
    const root = path.join(fixture.insightDir, "inference-proxy")
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, "installation.json"), "invalid-installation-json")
    const result = await runProxyConfigHook(fixture)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /Agent Insight OpenCode inference proxy configuration failed/)
    assert.equal(result.stdout, "")
  })

  test("OpenCode blocks only managed routes when the host swallows a proxy config failure", async t => {
    let requests = 0
    const server = http.createServer((_req, res) => { requests++; res.end('{}') })
    await listen(server)
    t.after(async () => { await closeServer(server) })
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat/completions`
    for (const runtimePresent of [true, false]) {
      const fixture = proxyHookFixture(t, runtimePresent)
      const root = path.join(fixture.insightDir, 'inference-proxy')
      fs.mkdirSync(root, { recursive: true })
      fs.writeFileSync(path.join(root, 'installation.json'), JSON.stringify({ enabled: true, agents: ['opencode'] }))
      if (runtimePresent) {
        fs.writeFileSync(path.join(fixture.insightDir, 'inference-runtime/inference_proxy.mjs'),
          "export function prepareOpenCodeConfig() { throw new Error('fixture-secret must never escape') }")
      }
      const managed = endpoint.replace('/v1/chat/completions', '/managed/opencode/test')
      const result = await runProxyConfigHook(fixture, managed + '/chat/completions', managed)
      assert.equal(result.code, 0, result.stderr)
      const output = JSON.parse(result.stdout)
      assert.match(output.configError, /Agent Insight OpenCode inference proxy configuration failed/)
      assert.match(output.requestError, /inference proxy.*blocked/i)
      assert.doesNotMatch(JSON.stringify(output), /fixture-secret/)
      assert.equal(requests, 0, 'a swallowed config error must not permit direct model inference')
      const unrelated = await runProxyConfigHook(fixture, endpoint)
      assert.equal(JSON.parse(unrelated.stdout).requestError, '')
      assert.equal(requests, 1, 'unmanaged providers are unaffected by a broken optional gateway')
      requests = 0
    }
  })

  test("OpenCode skips a broken runtime when proxy management is disabled", async t => {
    const fixture = proxyHookFixture(t)
    const root = path.join(fixture.insightDir, 'inference-proxy')
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'installation.json'), JSON.stringify({ enabled: false, agents: ['opencode'] }))
    fs.writeFileSync(path.join(fixture.insightDir, 'inference-runtime/inference_proxy.mjs'), "throw new Error('disabled runtime must not load')")
    const result = await runProxyConfigHook(fixture)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).baseURL, 'https://upstream.invalid/v1')
  })

  const assistant = (sessionID: string, id: string, parentID = "msg_user") => ({
    id, sessionID, parentID, role: "assistant", agent: "build",
    modelID: "probe", providerID: "gateway", time: { created: 1000 },
  })
  const input = (sessionID: string) => ({
    sessionID, agent: "build", message: { id: "msg_user" },
    model: { id: "probe", providerID: "gateway" },
  })
  function create(messages: (id: string) => any[], records: any[], transport: any = { fetch: globalThis.fetch }) {
    assert.equal(typeof (plugin as any).createInferenceCorrelation, "function")
    return (plugin as any).createInferenceCorrelation({
      client: { session: { messages: async ({ path }: any) => ({ data: messages(path.id) }) } },
    }, (record: any) => records.push(record), transport)
  }

  test("OpenCode observer blocks model POST requests without bindings and can recover after successful configuration", async () => {
    const sent: unknown[][] = []
    const transport = { fetch: (...args: unknown[]) => { sent.push(args); return Promise.resolve(new Response('{}')) } }
    const capture = create(() => [], [], transport)
    capture.configure()
    capture.setBlocked(true)
    for (const endpoint of ['chat/completions', 'responses', 'messages']) {
      const url = `https://inference.invalid/v1/${endpoint}?feature=1`
      await assert.rejects(transport.fetch(url, { method: 'POST' }), /inference proxy.*blocked/i)
      await assert.rejects(transport.fetch(new Request(url, { method: 'POST' })), /inference proxy.*blocked/i)
    }
    assert.equal(sent.length, 0)
    await transport.fetch('https://inference.invalid/v1/models', { method: 'GET' })
    await transport.fetch('https://inference.invalid/v1/messages', { method: 'GET' })
    capture.setBlocked(false)
    await transport.fetch('https://inference.invalid/v1/messages', { method: 'POST' })
    assert.equal(sent.length, 3)
  })

  test("OpenCode correlation separates calls sharing a user message and concurrent child sessions", async () => {
    const records: any[] = []
    const current = new Map([['ses_root', 'msg_a'], ['ses_child_a', 'msg_b'], ['ses_child_b', 'msg_c']])
    const capture = create((sid) => [{ info: assistant(sid, current.get(sid)!) }], records)
    const results = await Promise.all([...current.keys()].map(async (sid) => {
      const output = { headers: { "existing-header": "retained" } } as any
      await capture.headers(input(sid), output)
      assert.equal(output.headers['x-agent-insight-session-id'], sid)
      assert.equal(output.headers['x-agent-insight-message-id'], current.get(sid))
      assert.equal(output.headers['existing-header'], 'retained')
      assert.ok(output.headers['x-agent-insight-request-id'])
      return output.headers['x-agent-insight-request-id']
    }))
    current.set('ses_root', 'msg_next')
    const next = { headers: {} } as any
    await capture.headers(input('ses_root'), next)
    results.push(next.headers['x-agent-insight-request-id'])
    assert.equal(new Set(results).size, 4)
    assert.ok(records.every(r => r.kind === 'llm.request' && r.payload.messageID !== 'msg_user'))
  })

  test("OpenCode correlation records distinct HTTP attempts across hook and transport retries", async () => {
    const records: any[] = []
    const seen: Headers[] = []
    const originalFetch = async (_url: any, init: any) => {
      seen.push(new Headers(init.headers))
      assert.equal(init.body, 'unchanged body')
      return new Response('{}', { status: seen.length === 1 ? 503 : 200 })
    }
    const transport = { fetch: originalFetch }
    const capture = create(sid => [{ info: assistant(sid, 'msg_assistant') }], records, transport)
    capture.configure()
    const wrapped = transport.fetch
    capture.configure()
    assert.equal(transport.fetch, wrapped)
    const first = { headers: {} } as any
    await capture.headers(input('ses_root'), first)
    await wrapped('http://localhost/v1/chat/completions', { headers: first.headers, body: 'unchanged body' })
    const retry = { headers: {} } as any
    await capture.headers(input('ses_root'), retry)
    assert.equal(retry.headers['x-agent-insight-request-id'], first.headers['x-agent-insight-request-id'])
    await wrapped('http://localhost/v1/chat/completions', { headers: retry.headers, body: 'unchanged body' })
    await wrapped('http://localhost/v1/chat/completions', { headers: retry.headers, body: 'unchanged body' })
    assert.equal(new Set(seen.map(h => h.get('x-agent-insight-attempt-id'))).size, 3)
    assert.ok(seen.every(h => h.get('x-agent-insight-request-id') === first.headers['x-agent-insight-request-id']))
    const completed = records.filter(r => r.kind === 'llm.attempt' && r.payload.status_code)
    assert.deepEqual(completed.map(r => r.payload.status_code), [503, 200, 200])
  })

  test("OpenCode correlation preserves fetch installed by provider auth loaders after config", async () => {
    const records: any[] = []
    const response = new Response('{}')
    const controller = new AbortController()
    const originalFetch = Object.assign((_url: any, init: any) => {
      const headers = new Headers(init.headers)
      assert.equal(headers.get('authorization'), 'local-dummy')
      assert.ok(headers.get('x-agent-insight-attempt-id'))
      assert.equal(init.body, 'converted body')
      assert.equal(init.signal, controller.signal)
      return Promise.resolve(response)
    }, { preconnect: () => {} })
    const transport = { fetch: originalFetch }
    const capture = create(sid => [{ info: assistant(sid, 'msg_assistant') }], records, transport)
    const cfg: any = { provider: { gateway: { options: { baseURL: 'http://localhost/v1' } } } }
    capture.configure(cfg)
    let authCalls = 0
    const authFetch = async (url: any, init: any) => {
      authCalls++
      return transport.fetch(url, { ...init, body: 'converted body', headers: { ...init.headers, authorization: 'local-dummy' } })
    }
    const resolvedOptions = { fetch: authFetch, ...cfg.provider.gateway.options }
    assert.equal(resolvedOptions.fetch, authFetch)
    assert.deepEqual(cfg.provider.gateway.options, { baseURL: 'http://localhost/v1' })
    const output = { headers: {} }
    await capture.headers(input('ses_root'), output)
    assert.equal(await resolvedOptions.fetch('http://localhost/v1', { headers: output.headers, signal: controller.signal }), response)
    assert.equal(authCalls, 1)
    assert.equal(transport.fetch.preconnect, originalFetch.preconnect)
    assert.equal(records.filter(r => r.kind === 'llm.attempt' && r.payload.status_code).length, 1)
  })

  test("OpenCode correlation shares one observer across plugin instances and passes unrelated fetches through", async () => {
    const records: any[] = []
    const observed: any[] = []
    const promise = Promise.resolve(new Response('{}'))
    const originalFetch = function (this: any, ...args: any[]) { observed.push({ receiver: this, args }); return promise }
    const transport = { fetch: originalFetch }
    const captures = [create(sid => [{ info: assistant(sid, 'msg_a') }], records, transport),
      create(sid => [{ info: assistant(sid, 'msg_a') }], records, transport)]
    const output = { headers: {} }
    for (const capture of captures) { capture.configure(); await capture.headers(input('ses_root'), output) }
    await transport.fetch('http://localhost/v1', { headers: output.headers })
    const attempts = records.filter(r => r.kind === 'llm.attempt')
    assert.equal(attempts.length, 2)
    assert.equal(new Set(attempts.map(r => r.payload.attempt_id)).size, 1)
    assert.equal(new Headers(observed[0].args[1].headers).get('x-agent-insight-attempt-id'), attempts[0].payload.attempt_id)
    const init = { headers: { 'x-agent-insight-request-id': 'unknown' } }
    assert.equal(transport.fetch('http://localhost/unrelated', init), promise)
    assert.equal(observed[1].args[1], init)
    assert.equal(observed[1].receiver, transport)
    assert.equal(records.filter(r => r.kind === 'llm.attempt').length, 2)
  })

  test("OpenCode correlation retains only session identity for unbound or ambiguous requests and preserves transport errors", async () => {
    const records: any[] = []
    for (const candidates of [[], [assistant('ses_root', 'a'), assistant('ses_root', 'b')],
      [{ ...assistant('ses_root', 'done'), time: { created: 1, completed: 2 } }],
      [assistant('ses_other', 'foreign')], [assistant('ses_root', 'wrong-parent', 'other-user')]]) {
      const capture = create(() => candidates.map(info => ({ info })), records)
      const output = { headers: { retained: 'yes' } }
      await capture.headers(input('ses_root'), output)
      assert.deepEqual(output.headers, { retained: 'yes', 'x-agent-insight-session-id': 'ses_root' })
    }
    const originalError = new Error('private transport detail')
    const transport = { fetch: async (..._args: any[]) => { throw originalError } }
    const capture = create(sid => [{ info: assistant(sid, 'msg_a') }], records, transport)
    const output = { headers: {} }
    await capture.headers(input('ses_root'), output)
    await assert.rejects(() => transport.fetch('http://localhost', { headers: output.headers }), error => error === originalError)
    assert.ok(records.some(r => r.kind === 'llm.attempt' && r.payload.error_type === 'Error'))
    assert.ok(!JSON.stringify(records).includes('private transport detail'))
  })

  test("OpenCode correlation survives upload aggregation, duplicate snapshots, JSON and final child LLM nodes", async () => {
    const uploader = await uploaderPromise
    const records: any[] = []
    for (const [sid, parentID, mid] of [['ses_root', '', 'msg_root'], ['ses_child', 'ses_root', 'msg_child']]) {
      records.push({ kind: 'event', payload: { type: 'session.created', event: { properties: { info: { id: sid, parentID } } } } })
      records.push({ kind: 'event', payload: { type: 'message.updated', event: { properties: { info: assistant(sid, mid) } } } })
      records.push({ kind: 'event', payload: { type: 'message.part.updated', event: { properties: { part: { id: `part-${mid}`, sessionID: sid, messageID: mid, type: 'text', text: 'model response' } } } } })
      records.push({ kind: 'llm.request', sessionID: sid, payload: { messageID: mid, request_id: `request-${mid}` } })
      for (const [attempt_id, status_code] of [['failed', 503], ['success', 200]]) {
        const attempt = { kind: 'llm.attempt', sessionID: sid, payload: { messageID: mid, request_id: `request-${mid}`, attempt_id: `${mid}-${attempt_id}`, started_at: '2026-10-14T00:00:00Z', status_code } }
        records.push(attempt, attempt)
      }
    }
    const interactions = uploader.mergeGraph(uploader.buildState(records), 'ses_root')
    const tree = buildAgentCallTree(JSON.parse(JSON.stringify(interactions)))!
    const nodes = [tree, ...tree.children].flatMap(n => n.events.filter(e => e.kind === 'llm'))
    assert.equal(nodes.length, 2)
    for (const node of nodes) {
      const message = node.interaction as any
      assert.equal(message.inference_request_id, `request-${message.messageID}`)
      assert.equal(message.inference_attempts.length, 2)
      assert.deepEqual(message.inference_attempts.map((a: any) => a.status_code), [503, 200])
    }
  })

  for (const responseHeader of ["x-request-id", "x-agent-insight-call-id"]) test(`OpenCode ${responseHeader} IDs survive failed retries and final LLM projection`, async () => {
    const uploader = await uploaderPromise
    const ids = ['271c5a62-6e08-43ac-b8eb-761ad374a241', '0ffb3a6a-9f8a-464e-b973-049a45019858']
    const records: any[] = [{ kind: 'event', payload: { type: 'message.updated', event: { properties: { info: assistant('ses_root', 'msg_a') } } } }]
    let count = 0
    const transport = { fetch: async () => new Response('{}', { status: count === 0 ? 503 : 200, headers: { [responseHeader]: ids[count++] } }) }
    const capture = create(sid => [{ info: assistant(sid, 'msg_a') }], records, transport)
    const output = { headers: {} }
    await capture.headers(input('ses_root'), output)
    for (let i = 0; i < 2; i++) await (transport.fetch as any)('http://localhost/v1', { headers: output.headers })
    assert.deepEqual(records.filter(r => r.payload.call_id).map(r => r.payload.call_id), ids)
    records.push({ kind: 'event', payload: { type: 'message.part.updated', event: { properties: { part: { id: 'part-a', sessionID: 'ses_root', messageID: 'msg_a', type: 'text', text: 'model response' } } } } })
    const tree = buildAgentCallTree(JSON.parse(JSON.stringify(uploader.mergeGraph(uploader.buildState(records), 'ses_root'))))!
    assert.deepEqual(tree.events.find(e => e.kind === 'llm')?.interaction.inference_call_ids, ids)
  })

  test('shared fetch observer respects independently enabled managed routes without touching other providers', async () => {
    const sent: Headers[] = [];
    const transport = { fetch: async (_url: unknown, init?: RequestInit) => { sent.push(new Headers(init?.headers)); return new Response('{}'); } };
    const context = { client: { session: { messages: async () => ({ data: [{ info: assistant('session', 'message') }] }) } } };
    const disabled = plugin.createInferenceCorrelation(context, () => {}, transport, { allowsInput: () => false, allowsRequest: () => false });
    disabled.configure();
    const active = plugin.createInferenceCorrelation(context, () => {}, transport, { allowsRequest: (url: string) => url.startsWith('http://127.0.0.1:18080/managed/') });
    const output = { headers: {} };
    await disabled.headers(input('session'), output);
    assert.deepEqual(output.headers, {});
    await active.headers(input('session'), output);
    await transport.fetch('http://127.0.0.1:18080/managed/opencode/local/chat/completions', { method: 'POST', headers: output.headers });
    assert.ok(sent[0].has('x-agent-insight-attempt-id'));
    await transport.fetch('https://unmanaged.example/chat/completions', { method: 'POST', headers: output.headers });
    assert.equal(sent[1].has('x-agent-insight-attempt-id'), false);
    active.setBlocked(true);
    await assert.rejects(transport.fetch('http://127.0.0.1:18080/managed/opencode/local/chat/completions', { method: 'POST' }), /blocked/);
    await transport.fetch('https://unmanaged.example/chat/completions', { method: 'POST' });
    disabled.setBlocked(false);
    await assert.rejects(transport.fetch('http://127.0.0.1:18080/managed/opencode/local/chat/completions', { method: 'POST' }), /blocked/);
    active.setBlocked(false);
  });

  test('V1 prepares registered gateway requests before fetch, including session-only requests, and leaves other traffic direct', async () => {
    const actions: string[] = [];
    const transport = { fetch: async (url: string, _init?: RequestInit) => { actions.push('fetch:' + url); return new Response('{}'); } };
    const capture = plugin.createInferenceCorrelation({}, () => {}, transport, {
      allowsRequest: (url: string) => url.startsWith('http://127.0.0.1:18080/managed/'),
      prepareRequest: async () => { actions.push('prepare'); },
    });
    capture.configure();
    const output = { headers: {} };
    await capture.headers(input('session-only'), output);
    assert.deepEqual(output.headers, { 'x-agent-insight-session-id': 'session-only' });
    await transport.fetch('http://127.0.0.1:18080/managed/opencode/local/chat/completions', { headers: output.headers } as any);
    await transport.fetch('https://unmanaged.example/v1/chat/completions');
    assert.deepEqual(actions, ['prepare', 'fetch:http://127.0.0.1:18080/managed/opencode/local/chat/completions', 'fetch:https://unmanaged.example/v1/chat/completions']);
  });
});

describe("OpenCode 2.x native request correlation", () => {
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
    const root = temporaryDirectory('v2-inference-hooks-');
    const before = { ...process.env };
    const registry: Record<string, any> = {};
    const managed = 'http://127.0.0.1:18080/managed/opencode/local';
    copyProxyRuntime(root);
    fs.mkdirSync(path.join(root, 'inference-proxy'));
    fs.writeFileSync(path.join(root, 'inference-proxy/installation.json'), JSON.stringify({ explicitEnabled: true, enabled: false, agents: ['opencode'] }));
    fs.writeFileSync(path.join(root, 'inference-proxy/config-state.json'), JSON.stringify({ files: { config: { agent: 'opencode', fields: { local: { managed } } } } }));
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
});

describe("Qoder GUI identity boundary", () => {
  for (const product of ['desktop', 'jetbrains']) test(`Qoder ${product} local message IDs do not imply inference response or gateway identity`, () => {
      const session = 'gui-session', messageId = 'local-llm-message';
      const callId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      const events = normalizeOtlpTraces(buildQoderOtlpPayload({
          product,
          capturedAt: '2026-10-16T01:00:05.000Z',
          hookEvents: [{ capturedAt: '2026-10-16T01:00:05.000Z', event: { hook_event_name: 'Stop', session_id: session } }],
          transcriptRecords: [
              { type: 'user', sessionId: session, timestamp: '2026-10-16T01:00:01.000Z', message: { content: 'probe' } },
              { type: 'assistant', sessionId: session, timestamp: '2026-10-16T01:00:04.000Z', message: { id: messageId, model: 'fixture', content: [{ type: 'text', text: 'result' }] } },
          ],
          inferenceCalls: [{ agent: 'qoder', session_id: session, response_id: messageId, call_id: callId, started_at: '2026-10-16T01:00:03.000Z' }],
      }));
      assert.ok(events.every(e => !e.attributes['agent_insight.inference.call_ids'] && !e.attributes['agent_insight.inference.unassigned_calls']));
      const llm = events.find(e => e.attributes['qoder.llm.message_id'] === messageId)!;
      assert.ok(llm, 'retain the local message ID for observability');
      llm.attributes['agent_insight.inference.call_ids'] = JSON.stringify([callId]);
      const root = events.find(e => e.attributes['qoder.span.type'] === 'agent')!;
      root.attributes['agent_insight.inference.unassigned_calls'] = JSON.stringify([{ call_id: callId }]);
      const record = aggregateOtelTraceEvents(session, events)!;
      const interactions = record.interactions as RawInteraction[];
      const node = interactions.find(item => item.messageID === messageId)!;
      assert.ok(node);
      assert.equal(node.inference_response_id, undefined);
      assert.equal(node.inference_response_unavailable, true);
      assert.ok(interactions.every(item => !item.inference_call_ids?.length && !item.inference_unassigned_calls?.length));
      const target = inferenceAnalysisTarget({ framework: 'qoder', scope: 'llm', interaction: node });
      assert.equal(target.responseId, undefined);
      assert.equal(target.callIds, undefined);
  });
});
