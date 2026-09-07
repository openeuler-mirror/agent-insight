import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { parseGoalPlusRoot } = require('../scripts/agent-trace-collectors/goal-plus/lib/gp-snapshot-parser.cjs');
const { parsePiSession } = require('../scripts/agent-trace-collectors/goal-plus/lib/pi-native-parser.cjs');
const { attachSource, loadRegistry } = require('../scripts/agent-trace-collectors/goal-plus/lib/source-registry.cjs');
const { buildSemanticBatches, loadConfig, startWatcher, stopWatcher, watcherStatus } = require('../scripts/agent-trace-collectors/goal-plus/goal-plus-collector.cjs');
const { enqueueSemanticBatch, uploadSemanticBatches } = require('../scripts/agent-trace-collectors/goal-plus/lib/semantic-spool.cjs');
const fixture = path.join(process.cwd(), 'test', 'fixtures', 'goal-plus', '.gp');

type ParsedSnapshot = { snapshotId: string; kind: string; payload?: Record<string, unknown> };
type ParsedRoot = { diagnostics: unknown[]; snapshots: ParsedSnapshot[]; piSessions: unknown[] };
type NativeEvent = {
  eventId: string;
  sessionId: string;
  kind: string;
  usage?: { total?: number };
  tool?: { name?: string };
  skill?: { name?: string };
};
type ParsedPi = { fidelity: string; events: NativeEvent[]; diagnostics?: Array<{ code: string }> };

async function copiedFixture(t: test.TestContext) {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'goal-plus-collector-'));
  t.after(() => fsp.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, '.gp');
  await fsp.cp(fixture, root, { recursive: true });
  return { temporary, root };
}

test('Goal Plus source attach is canonical and idempotent', async t => {
  const { temporary, root } = await copiedFixture(t);
  const registryPath = path.join(temporary, 'sources.json');
  const first = await attachSource(root, { registryPath });
  const second = await attachSource(root, { registryPath });
  assert.equal(first.sourceId, second.sourceId);
  assert.equal((await loadRegistry(registryPath)).sources.length, 1);
  assert.match(first.workspaceFingerprint, /^sha256:[a-f0-9]{64}$/);
});

test('Goal Plus managed watcher stays stopped and rejects startup without attached sources', async t => {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'goal-plus-watcher-'));
  t.after(() => fsp.rm(homeDir, { recursive: true, force: true }));
  const configPath = path.join(homeDir, '.agent-insight', 'collectors', 'goal-plus', 'config.json');
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, JSON.stringify({ apiKey: 'synthetic', hosts: ['pi'], baseUrl: 'http://example.invalid' }));
  const config = await loadConfig({ homeDir, configPath });
  const status = await watcherStatus(config);
  assert.equal(status.running, false);
  assert.equal(status.ready, false);
  assert.equal(status.sourceCount, 0);
  assert.deepEqual(status.hosts, ['pi']);
  const lockPath = path.join(path.dirname(configPath), 'runtime', 'watcher.lock');
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  await fsp.writeFile(lockPath, '2147483647\n');
  await assert.rejects(() => startWatcher(config), /No Goal Plus sources are attached/);
  await assert.rejects(() => fsp.access(lockPath));
});

test('Goal Plus managed watcher starts idempotently and stops without touching native collectors', async t => {
  if (process.platform === 'win32') return t.skip('detached process signaling differs on Windows');
  const { temporary, root } = await copiedFixture(t);
  const homeDir = path.join(temporary, 'home');
  const configPath = path.join(homeDir, '.agent-insight', 'collectors', 'goal-plus', 'config.json');
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, JSON.stringify({
    apiKey: 'synthetic',
    hosts: ['codex'],
    semanticEndpoint: 'http://127.0.0.1:9/semantic',
    otlpEndpoint: 'http://127.0.0.1:9/traces',
  }));
  await attachSource(root, { homeDir });
  const config = await loadConfig({ homeDir, configPath });
  t.after(() => stopWatcher(config));

  const started = await startWatcher(config, { intervalMs: 60_000 });
  assert.equal(started.running, true);
  assert.equal(started.ready, true);
  const repeated = await startWatcher(config, { intervalMs: 60_000 });
  assert.equal(repeated.alreadyRunning, true);
  assert.equal(repeated.pid, started.pid);
  const stopped = await stopWatcher(config);
  assert.equal(stopped.stopped, true);
  assert.equal((await watcherStatus(config)).running, false);
});

test('semantic parser emits stable bounded snapshots without local paths', async t => {
  const { root } = await copiedFixture(t);
  const source = { sourceId: 'gpsrc_fixture', root, label: 'fixture', workspaceFingerprint: `sha256:${'a'.repeat(64)}` };
  const first = await parseGoalPlusRoot(source) as ParsedRoot;
  const second = await parseGoalPlusRoot(source) as ParsedRoot;
  assert.equal(first.diagnostics.length, 0);
  assert.deepEqual(first.snapshots.map(item => item.snapshotId), second.snapshots.map(item => item.snapshotId));
  assert.deepEqual(new Set(first.snapshots.map(item => item.kind)), new Set(['goal', 'goal_event', 'frozen_spec', 'run', 'best', 'candidate', 'agent_session', 'report_meta']));
  const serialized = JSON.stringify(first.snapshots);
  assert.doesNotMatch(serialized, /\/home\/example/);
  assert.doesNotMatch(serialized, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(first.piSessions.length, 1);
});

test('semantic parser preserves only bounded Codex correlation identities', async t => {
  const { root } = await copiedFixture(t);
  const sessionPath = path.join(root, 'runs', 'run_demo', 'agent_sessions', 'agent_001.json');
  const session = JSON.parse(await fsp.readFile(sessionPath, 'utf8'));
  session.host = 'codex';
  session.host_handle.host = 'codex';
  session.host_handle.metadata = {
    codex_conversation_id: 'conversation-demo',
    codex_turn_id: 'turn-demo',
    codex_execution_id: 'conversation-demo:turn:turn-demo',
    transcript_path: '/home/example/private/transcript.jsonl',
  };
  await fsp.writeFile(sessionPath, JSON.stringify(session));
  const parsed = await parseGoalPlusRoot({ sourceId: 'gpsrc_fixture', root }) as ParsedRoot;
  const agentSession = parsed.snapshots.find(item => item.kind === 'agent_session');
  const hostMetadata = agentSession?.payload?.hostMetadata as Record<string, unknown>;
  assert.equal(hostMetadata.codexConversationId, 'conversation-demo');
  assert.equal(hostMetadata.codexTurnId, 'turn-demo');
  assert.equal(hostMetadata.codexExecutionId, 'conversation-demo:turn:turn-demo');
  assert.doesNotMatch(JSON.stringify(agentSession), /private\/transcript/);
});

test('semantic parser ignores an incomplete JSONL tail', async t => {
  const { root } = await copiedFixture(t);
  await fsp.appendFile(path.join(root, 'goal-plus', 'gp_demo', 'events.jsonl'), '{"event_id":"half');
  const parsed = await parseGoalPlusRoot({ sourceId: 'gpsrc_fixture', root }) as ParsedRoot;
  assert.equal(parsed.diagnostics.length, 0);
  assert.equal(parsed.snapshots.filter(item => item.kind === 'goal_event').length, 1);
});

test('semantic batches keep limits and publish scan checkpoint on the final batch', () => {
  const snapshots = Array.from({ length: 101 }, (_, index) => ({ snapshotId: `snapshot-${index}`, payload: {} }));
  const batches = buildSemanticBatches(
    { sourceId: 'source', workspaceFingerprint: `sha256:${'a'.repeat(64)}` },
    { snapshots, scannedFiles: 101 },
    '2026-09-03T00:00:00.000Z',
    '2026-09-03T00:00:01.000Z',
  );
  assert.equal(batches.length, 2);
  assert.equal(batches[0].snapshots.length, 100);
  assert.equal(batches[0].source.scanCompletedAt, undefined);
  assert.equal(batches[1].source.scanCompletedAt, '2026-09-03T00:00:01.000Z');
});

test('semantic uploader retries transient responses before acknowledging', async t => {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'goal-plus-spool-'));
  t.after(() => fsp.rm(homeDir, { recursive: true, force: true }));
  const batch = {
    format: 'agent-insight.goal-plus-batch',
    version: 1,
    source: { sourceId: 'source', semanticCheckpoint: { scanStartedAt: '2026-09-03T00:00:00.000Z', batchOrdinal: 0 } },
    snapshots: [],
  };
  await enqueueSemanticBatch(batch, { apiKey: 'test-key', homeDir });
  let calls = 0;
  const result = await uploadSemanticBatches({
    apiKey: 'test-key',
    homeDir,
    endpoint: 'http://example.invalid/upload',
    sleep: async () => undefined,
    fetch: async () => {
      calls += 1;
      const ok = calls === 3;
      return { ok, status: ok ? 200 : 503, json: async () => ok ? { accepted: 0, duplicate: 0, rejected: [] } : {} };
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.uploadedBatches, 1);
});

test('Pi passive parser uses one stable canonical session with LLM and tool events', async t => {
  const { root } = await copiedFixture(t);
  const descriptor = { sourceId: 'gpsrc_fixture', agentSessionId: 'agent_001', runId: 'run_demo', candidateId: 'candidate_001', role: 'candidate-worker', sessionFile: 'runs/run_demo/pi_sessions/agent_001.jsonl' };
  const first = await parsePiSession(root, descriptor) as ParsedPi;
  const second = await parsePiSession(root, descriptor) as ParsedPi;
  assert.equal(first.fidelity, 'derived');
  assert.ok(first.events.some(item => item.kind === 'agent'));
  assert.ok(first.events.some(item => item.kind === 'llm' && item.usage?.total === 25));
  assert.ok(first.events.some(item => item.kind === 'tool' && item.tool?.name === 'read'));
  assert.ok(first.events.some(item => item.kind === 'skill' && item.skill?.name === 'demo-skill'));
  assert.ok(first.events.every(item => item.sessionId === 'goal-plus:gpsrc_fixture:agent_001'));
  assert.deepEqual(first.events.map(item => item.eventId), second.events.map(item => item.eventId));
});

test('Pi passive parser skips incomplete tails and diagnoses malformed complete records', async t => {
  const { root } = await copiedFixture(t);
  const sessionFile = path.join(root, 'runs', 'run_demo', 'pi_sessions', 'agent_001.jsonl');
  await fsp.appendFile(sessionFile, '{"malformed"\n{"partial"');
  const parsed = await parsePiSession(root, {
    sourceId: 'gpsrc_fixture',
    agentSessionId: 'agent_001',
    sessionFile: path.relative(root, sessionFile),
  }) as ParsedPi;
  assert.ok(parsed.events.some(item => item.kind === 'agent'));
  assert.deepEqual(parsed.diagnostics?.map(item => item.code), ['invalid_pi_jsonl_record']);
});

test('Pi passive locator rejects symlink escape', async t => {
  if (process.platform === 'win32') return t.skip('symlink permissions vary on Windows');
  const { temporary, root } = await copiedFixture(t);
  const outside = path.join(temporary, 'outside.jsonl');
  await fsp.writeFile(outside, '{}\n');
  const link = path.join(root, 'runs', 'run_demo', 'pi_sessions', 'escape.jsonl');
  fs.symlinkSync(outside, link);
  await assert.rejects(() => parsePiSession(root, { sourceId: 's', agentSessionId: 'a', sessionFile: path.relative(root, link) }), /non-symlink/);
});
