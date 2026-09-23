import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  MctsProxyCore,
  MctsStdoutParser,
  roleFor,
  runtimeKey,
} = require('../scripts/agent-trace-collectors/mcts-xgovernor-proxy/core.cjs');
const { createGateway, inspectableJson } = require('../scripts/agent-trace-collectors/mcts-xgovernor-proxy/gateway.cjs');
const { install } = require('../scripts/agent-trace-collectors/mcts-xgovernor-proxy/install.cjs');
const { preflightUpstream } = require('../scripts/agent-trace-collectors/mcts-xgovernor-proxy/run.cjs');

class MemoryWriter {
  events: Array<Record<string, unknown>> = [];
  async append(event: Record<string, unknown>) {
    this.events.push(event);
    return event;
  }
  async flush() {}
}

class MemoryOutbox {
  sessions: Array<Record<string, unknown>> = [];
  events: Array<Record<string, unknown>> = [];
  async enqueueSession(value: Record<string, unknown>) { this.sessions.push(value); }
  async enqueueEvent(value: Record<string, unknown>) { this.events.push(value); }
}

function requestBody(clientId: string, body: Record<string, unknown>) {
  return { ...body, lease: { client_id: clientId, pid: 1, hostname: 'host' } };
}

test('MCTS proxy core reconstructs only confirmed checkpoint runtime edges', async () => {
  const writer = new MemoryWriter();
  const outbox = new MemoryOutbox();
  let now = 1_700_000_000_000;
  const core = new MctsProxyCore({ writer, collaborationOutbox: outbox, now: () => now++, captureReasoning: true });
  const clientId = 'union-sensitive-run-id';

  await core.observeRequest({
    id: 'open-parent', path: '/api/v1/sessions/open', startedAt: now,
    body: requestBody(clientId, {
      runtime_id: 'runtime-parent',
      ext: { runtime_pi: { max_turns: 160, tools_enabled: true, system_prompt: 'secret prompt' } },
    }),
  });
  await core.observeRequest({
    id: 'turn-parent', path: '/api/v1/sessions/turns', startedAt: now,
    body: requestBody(clientId, { runtime_id: 'runtime-parent', text: 'solve this' }),
  });
  await core.observeResponse({ id: 'turn-parent', status: 200, body: { turn_id: 'turn-parent-id' }, endedAt: now });
  await core.observeRequest({
    id: 'checkpoint', path: '/api/v1/sessions/checkpoint', startedAt: now,
    body: requestBody(clientId, { runtime_id: 'runtime-parent' }),
  });
  await core.observeResponse({ id: 'checkpoint', status: 200, body: { checkpoint_id: 'raw-secret-checkpoint' }, endedAt: now });

  await core.observeRequest({
    id: 'load-temp', path: '/api/v1/sessions/load', startedAt: now,
    body: requestBody(clientId, { runtime_id: 'runtime-temp', checkpoint_id: 'raw-secret-checkpoint' }),
  });
  assert.equal(outbox.events.length, 1, 'the coordinator-to-parent edge already exists');
  assert.equal(outbox.sessions.some(session => session.sessionId === runtimeKey('runtime-temp')), false);

  await core.observeRequest({
    id: 'load-child', path: '/api/v1/sessions/load', startedAt: now,
    body: requestBody(clientId, { runtime_id: 'runtime-child', checkpoint_id: 'raw-secret-checkpoint' }),
  });
  await core.observeRequest({
    id: 'turn-child', path: '/api/v1/sessions/turns', startedAt: now,
    body: requestBody(clientId, { runtime_id: 'runtime-child', text: 'continue' }),
  });
  await core.observeResponse({ id: 'turn-child', status: 200, body: { turn_id: 'turn-child-id' }, endedAt: now });
  await core.observeSse({
    runtimeId: 'runtime-child', turnId: 'turn-child-id', receivedAt: now,
    event: { kind: 'output_delta', stream_id: 'assistant', sequence: 1, delta: 'answer' },
  });
  await core.observeSse({
    runtimeId: 'runtime-child', turnId: 'turn-child-id', receivedAt: now,
    event: { kind: 'output_delta', stream_id: 'assistant', sequence: 1, delta: 'answer' },
  });
  await core.observeSse({
    runtimeId: 'runtime-child', turnId: 'turn-child-id', receivedAt: now,
    event: { kind: 'output_delta', stream_id: 'thinking', sequence: 2, delta: 'reasoning' },
  });
  await core.observeSse({
    runtimeId: 'runtime-child', turnId: 'turn-child-id', receivedAt: now,
    event: { kind: 'turn_completed', usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } },
  });
  await core.finish(0, null);

  assert.equal(outbox.events.length, 2);
  const childEdge = outbox.events[1];
  assert.equal(childEdge.fromSessionId, runtimeKey('runtime-parent'));
  assert.equal(childEdge.toSessionId, runtimeKey('runtime-child'));
  assert.equal((childEdge.fromLocator as { name: string }).name, 'task');
  assert.equal(outbox.events.some(event => event.toSessionId === runtimeKey('runtime-temp')), false);
  assert.equal(outbox.sessions.some(session => session.sessionId === runtimeKey('runtime-temp')), false);
  assert.equal(writer.events.some(event => String(event.sessionId).endsWith(runtimeKey('runtime-temp'))), false);
  assert.equal(writer.events.some(event => event.kind === 'llm' && event.output === 'answer'), true);
  assert.equal(writer.events.some(event => (
    event.kind === 'llm'
    && (event.attributes as Record<string, unknown>)['mcts.reasoning'] === 'reasoning'
  )), true);
  assert.doesNotMatch(JSON.stringify([...core.runs.values()]), /raw-secret-checkpoint|secret prompt|union-sensitive-run-id/);
  assert.equal(roleFor([...core.runs.values()][0].runtimes.get(runtimeKey('runtime-child'))), 'solver-child');
});

test('MCTS stdout parser accepts only the documented stable summary lines', () => {
  const parser = new MctsStdoutParser();
  assert.deepEqual(parser.parse('▶ startup  mode=sweverified  task=case-1'), {
    type: 'startup', fields: { mode: 'sweverified', task: 'case-1' },
  });
  assert.deepEqual(parser.parse('▶ choose  iter=2  node=root/c0'), { type: 'choose', iteration: 2, node: 'root/c0' });
  assert.deepEqual(parser.parse('  root/c0 score=0.750 timing=after testcases=v4'), {
    type: 'node-score', node: 'root/c0', score: 0.75, timing: 'after', testcasesVersion: 4,
  });
  assert.deepEqual(parser.parse('OFFICIAL TEST PASS  node=root/c0'), { type: 'official-result', passed: true, node: 'root/c0' });
  assert.equal(parser.parse('password=hunter2 command=rm -rf workspace'), undefined);
  assert.equal(inspectableJson('/api/v1/sessions/files/read'), true);
  assert.equal(inspectableJson('/api/v1/sessions/exec'), false);
  assert.equal(inspectableJson('/api/v1/sessions/files/write'), false);
});

test('MCTS role classifier uses structural evidence and keeps uncertain runtimes unknown', () => {
  const runtime = (overrides: Record<string, unknown>) => ({
    openType: 'open', hasTurn: true, hasCheckpoint: false, fileReads: 0, profile: {}, ...overrides,
  });
  assert.equal(roleFor(runtime({ openType: 'load' })), 'solver-child');
  assert.equal(roleFor(runtime({ hasCheckpoint: true })), 'solver-initial');
  assert.equal(roleFor(runtime({ fileReads: 1 })), 'author');
  assert.equal(roleFor(runtime({ profile: { toolsEnabled: false, maxTurns: 2 } })), 'selector');
  assert.equal(roleFor(runtime({ profile: { toolsEnabled: false, maxTurns: 1 } })), 'memory-helper');
  assert.equal(roleFor(runtime({})), 'unknown');
});

test('MCTS observer installer creates an isolated 0600 config and managed wrapper', async () => {
  const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-insight-mcts-install-'));
  const previousApiKey = process.env.AGENT_INSIGHT_API_KEY;
  const previousInsightHome = process.env.AGENT_INSIGHT_HOME;
  process.env.AGENT_INSIGHT_API_KEY = 'test-api-key';
  delete process.env.AGENT_INSIGHT_HOME;
  try {
    const result = await install({
      homeDir: temporaryHome,
      sourceDir: path.resolve('scripts/agent-trace-collectors/mcts-xgovernor-proxy'),
      skipVersionCheck: true,
    });
    assert.equal((await fs.stat(result.configPath)).mode & 0o777, 0o600);
    assert.match(await fs.readFile(result.commandPath, 'utf8'), /managed-by-agent-insight-mcts-xgovernor-proxy/);
    assert.equal(JSON.parse(await fs.readFile(result.configPath, 'utf8')).captureReasoning, false);
  } finally {
    if (previousApiKey === undefined) delete process.env.AGENT_INSIGHT_API_KEY;
    else process.env.AGENT_INSIGHT_API_KEY = previousApiKey;
    if (previousInsightHome === undefined) delete process.env.AGENT_INSIGHT_HOME;
    else process.env.AGENT_INSIGHT_HOME = previousInsightHome;
    await fs.rm(temporaryHome, { recursive: true, force: true });
  }
});

test('transparent gateway preserves request and SSE response bytes while observing safe JSON', async () => {
  const rawRequest = Buffer.from(JSON.stringify({ runtime_id: 'rt-1', lease: { client_id: 'run-1' } }));
  const sseBody = Buffer.from(': heartbeat\n\ndata: {"kind":"output_delta",\ndata: "runtime_id":"rt-1","turn_id":"turn-1","stream_id":"assistant","sequence":1,"delta":"ok"}\n\n');
  let upstreamRequest = Buffer.alloc(0);
  const upstream = http.createServer((request, response) => {
    if (request.url?.endsWith('/events')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(sseBody);
      return;
    }
    request.on('data', chunk => { upstreamRequest = Buffer.concat([upstreamRequest, chunk]); });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"runtime_id":"rt-1"}');
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === 'object');
  await preflightUpstream(`http://127.0.0.1:${upstreamAddress.port}`);
  const observedRequests: Array<Record<string, unknown>> = [];
  const observedSse: Array<Record<string, unknown>> = [];
  const gateway = await createGateway({
    upstreamUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    onRequest: (value: Record<string, unknown>) => observedRequests.push(value),
    onSseEvent: (value: Record<string, unknown>) => observedSse.push(value),
  });
  try {
    const response = await fetch(`${gateway.url}/api/v1/sessions/open`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: rawRequest,
    });
    assert.equal(await response.text(), '{"runtime_id":"rt-1"}');
    const stream = await fetch(`${gateway.url}/api/v1/sessions/rt-1/turns/turn-1/events`);
    assert.deepEqual(Buffer.from(await stream.arrayBuffer()), sseBody);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(upstreamRequest, rawRequest);
    const observedBody = observedRequests[0].body as { lease: { client_id: string } };
    const observedEvent = observedSse[0].event as { delta: string };
    assert.equal(observedBody.lease.client_id, 'run-1');
    assert.equal(observedEvent.delta, 'ok');
  } finally {
    await gateway.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
