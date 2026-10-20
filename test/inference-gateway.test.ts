import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectQoderHook } from '../scripts/qoder_trace_collector.mjs';
import { normalizeOtlpTraces } from '@/lib/ingest/otel/normalize';
import { aggregateOtelTraceEvents } from '@/lib/ingest/otel/aggregate';
import { buildAgentCallTree, type AgentEvent, type AgentNode } from '@/lib/engine/observability/agent-trace';
import { inferenceAnalysisTarget } from '@/lib/trace/inference-analysis';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const gatewayModule = '../scripts/inference_gateway.mjs';
async function fixture(t: any, handler: http.RequestListener, options: any = {}) {
    const gateway = await import(gatewayModule).catch(() => ({}));
    assert.equal(typeof gateway.createInferenceGateway, 'function', 'unified gateway must be implemented');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inference-gateway-'));
    const upstream = http.createServer(handler);
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const proxy = gateway.createInferenceGateway({ routes: [{ basePath: '/qoder/v1', upstreamBaseUrl: `http://127.0.0.1:${(upstream.address() as any).port}/v1`, agent: options.agent || 'qoder', protocol: 'openai' }], ...options }, { insightDir: dir, apiKey: '' });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    t.after(async () => { for (const server of [proxy, upstream]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } fs.rmSync(dir, { recursive: true, force: true }); });
    return { dir, url: `http://127.0.0.1:${(proxy.address() as any).port}/qoder/v1`, gateway, proxy, upstream };
}
const body = JSON.stringify({ model: 'probe', messages: [{ role: 'user', content: 'private prompt' }], stream: true });
const post = (url: string, extra: any = {}) => fetch(url + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', 'session-id': 'session', authorization: 'Bearer private-key', 'x-agent-insight-call-id': 'forged' }, body, ...extra });
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
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(wire.slice(0, 17)); setTimeout(() => res.end(wire.slice(17)), 15);
    });
    const responses = await Promise.all([post(f.url), post(f.url)]);
    assert.deepEqual(await Promise.all(responses.map(r => r.text())), [wire, wire]);
    const ids = responses.map(r => r.headers.get('x-agent-insight-call-id'));
    assert.equal(new Set(ids).size, 2); assert.ok(ids.every(id => /^[a-f0-9-]{36}$/.test(id!)));
    assert.deepEqual(seen.map(r => r.headers['x-agent-insight-call-id']).sort(), [...ids].sort());
    assert.ok(seen.every(r => r.data === body && r.path === '/v1/chat/completions' && r.headers.authorization === 'Bearer private-key'));
    assert.ok(seen.every(r => !r.headers['session-id']));
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
    for (let i = 0; i < 3; i++) { const r = await post(f.url); ids.push(r.headers.get('x-agent-insight-call-id')!); await r.text(); }
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
    await new Promise<void>(resolve => direct.listen(0, '127.0.0.1', resolve));
    const gateway = f.gateway.createInferenceGateway({ routes: [{ basePath: '/v1', agent: 'qoder', protocol: 'anthropic', upstreamBaseUrl: `http://127.0.0.1:${(direct.address() as any).port}` }] }, { insightDir: f.dir, apiKey: '' });
    await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
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
    await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
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
    await response.text(); const id = response.headers.get('x-agent-insight-call-id');
    selectedFile = path.join(spool, 'other.jsonl');
    await run(); assert.equal(uploads.length, 2);
    await run(); assert.equal(uploads.length, 3, 'failed correlation upload must retry even when spool and journal are unchanged');
    assert.ok(uploads[2].interactions.some((m: any) => m.inference_call_ids?.includes(id)));
});

test('gateway timeout has a call ID and never invents an upstream response ID', async t => {
    const f = await fixture(t, (_req, _res) => {}, { timeoutMs: 20 });
    const response = await post(f.url); await response.text();
    assert.equal(response.status, 504);
    const [record] = records(f.dir); assert.equal(record.call_id, response.headers.get('x-agent-insight-call-id'));
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
        received.push({ label, id: String(req.headers['x-agent-insight-call-id']) });
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
        const id = response.headers.get('x-agent-insight-call-id')!;
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
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
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
        await r.text(); ids.push(r.headers.get('x-agent-insight-call-id'));
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
        await response.text(); ids.push(response.headers.get('x-agent-insight-call-id'));
    }
    const state = uploader.buildState([native('msg-a'), native('msg-b'), proof('msg-a', 'oc_v2_good', 'a'), proof('msg-a', 'oc_v2_ambiguous', 'c'), proof('msg-b', 'oc_v2_ambiguous', 'c'), proof('msg-a', 'oc_v2_wrong', 'd')]);
    uploader.applyInferenceGatewayRecords(state, f.dir, '');
    const messages: any[] = uploader.mergeGraph(state, 'session');
    assert.deepEqual(messages.find((m: any) => m.messageID === 'msg-a').inference_call_ids, [ids[0]]);
    assert.deepEqual(messages.flatMap((m: any) => m.inference_unassigned_calls || []).map((c: any) => c.call_id).sort(), ids.slice(1).sort());
});
