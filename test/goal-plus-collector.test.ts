import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { parseGoalPlusRoot } = require('../scripts/agent-trace-collectors/goal-plus/lib/gp-snapshot-parser.cjs');
const {
  importPiSessions,
  messageText,
  parsePiSession,
  runtimeOutcome,
} = require('../scripts/agent-trace-collectors/goal-plus/lib/pi-native-parser.cjs');
const { attachSource, loadRegistry } = require('../scripts/agent-trace-collectors/goal-plus/lib/source-registry.cjs');
const {
  activateGoalPlusSource,
  ensureWatcher,
  loadConfig,
  scanSource,
  startWatcher,
  stopWatcher,
  watcherStatus,
} = require('../scripts/agent-trace-collectors/goal-plus/goal-plus-collector.cjs');
const { collectorStateDir } = require('../scripts/agent-trace-collectors/shared/trace-transport.cjs');
const fixture = path.join(process.cwd(), 'test', 'fixtures', 'goal-plus', '.gp');

type ParsedSnapshot = { snapshotId: string; kind: string; payload?: Record<string, unknown> };
type PiSessionDescriptor = {
  sessionFile: string;
  sessionFormat?: string;
  sessionKind?: string;
  nativeSessionId?: string;
  canonicalSessionId?: string;
  host?: string;
  runnerFailed?: boolean;
  timedOut?: boolean;
  progressStatus?: string;
  controlledTermination?: boolean;
  runtimeBudgetSeconds?: number;
  terminalState?: string;
  businessState?: string;
  exitCode?: number;
  errorMessage?: string;
};
type ParsedRoot = {
  diagnostics: Array<{ code?: string }>;
  snapshots: ParsedSnapshot[];
  piSessions: PiSessionDescriptor[];
  relationships: Array<{
    binding: { collaborationId: string; sessionId: string; traceSessionId: string; eventClock: string };
    event: { collaborationId: string; eventId: string; fromSessionId: string; toSessionId: string; fromLocator?: unknown };
  }>;
};
type NativeEvent = {
  eventId: string;
  sessionId: string;
  kind: string;
  input?: string;
  output?: string;
  status?: string;
  attributes?: Record<string, unknown>;
  usage?: { total?: number };
  tool?: { name?: string };
  skill?: { name?: string };
};
type ParsedPi = { fidelity: string; events: NativeEvent[]; diagnostics?: Array<{ code: string }> };

function memoryWriter(events: NativeEvent[], order: string[] = []) {
  return {
    async append(event: NativeEvent) {
      order.push('append');
      events.push(event);
      return event;
    },
    async flush() {
      order.push('flush');
    },
  };
}

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

test('Pi auto-detection activates only a Goal Plus record owned by the current native session', async t => {
  const { temporary, root } = await copiedFixture(t);
  const configPath = path.join(temporary, 'collector', 'config.json');
  const config = {
    apiKey: 'synthetic',
    homeDir: temporary,
    configPath,
    registryPath: path.join(path.dirname(configPath), 'sources.json'),
    otlpEndpoint: 'http://example.invalid/traces',
    collaborationSessionsEndpoint: 'http://example.invalid/collaboration-sessions',
    collaborationEventsEndpoint: 'http://example.invalid/collaboration-events',
  };
  const calls: string[] = [];
  const result = await activateGoalPlusSource(root, {
    goalId: 'gp_demo',
    nativeSessionId: 'pi-main-session-001',
  }, config, {
    scanSource: async () => {
      calls.push('scan');
      return { piSessions: 1 };
    },
    ensureWatcher: async () => {
      calls.push('watcher');
      return { running: true, ensured: true };
    },
  });

  assert.equal(result.status, 'ACTIVE');
  assert.deepEqual(calls, ['scan', 'watcher']);
  const [source] = (await loadRegistry(config.registryPath)).sources;
  assert.equal(source.managedBy, 'pi-agent-auto-detect');
  assert.equal(source.goalId, 'gp_demo');
  assert.equal(source.nativeSessionId, 'pi-main-session-001');
  const activation = JSON.parse(await fsp.readFile(path.join(path.dirname(configPath), 'runtime', 'activation.json'), 'utf8'));
  assert.equal(activation.status, 'ACTIVE');
});

test('Pi auto-detection refuses an unrelated Goal Plus workspace without attaching it', async t => {
  const { temporary, root } = await copiedFixture(t);
  const configPath = path.join(temporary, 'collector', 'config.json');
  const config = {
    apiKey: 'synthetic',
    homeDir: temporary,
    configPath,
    registryPath: path.join(path.dirname(configPath), 'sources.json'),
  };
  await assert.rejects(() => activateGoalPlusSource(root, {
    goalId: 'gp_demo',
    nativeSessionId: 'another-pi-session',
  }, config, {
    scanSource: async () => assert.fail('untrusted source must not be scanned'),
    ensureWatcher: async () => assert.fail('untrusted source must not start a watcher'),
  }), /does not belong to the current Pi session/);
  assert.equal((await loadRegistry(config.registryPath)).sources.length, 0);
  const activation = JSON.parse(await fsp.readFile(path.join(path.dirname(configPath), 'runtime', 'activation.json'), 'utf8'));
  assert.equal(activation.status, 'DEGRADED');
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
  const ensured = await ensureWatcher(config);
  assert.equal(ensured.ensured, false);
  assert.equal(ensured.reason, 'no_sources');
  const lockPath = path.join(path.dirname(configPath), 'runtime', 'watcher.lock');
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  await fsp.writeFile(lockPath, '2147483647\n');
  await assert.rejects(() => startWatcher(config), /No Goal Plus sources are attached/);
  await assert.rejects(() => fsp.access(lockPath));
});

test('Goal Plus watcher status exposes a malformed native uploader lock', async t => {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'goal-plus-uploader-status-'));
  t.after(() => fsp.rm(homeDir, { recursive: true, force: true }));
  const configPath = path.join(homeDir, '.agent-insight', 'collectors', 'goal-plus', 'config.json');
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, JSON.stringify({
    apiKey: 'synthetic',
    hosts: ['pi'],
    baseUrl: 'http://example.invalid',
  }));
  const nativeStateDir = collectorStateDir('pi-agent', 'synthetic', homeDir);
  await fsp.mkdir(nativeStateDir, { recursive: true });
  await fsp.writeFile(path.join(nativeStateDir, 'uploader.lock'), '');

  const status = await watcherStatus(await loadConfig({ homeDir, configPath }));
  assert.equal(status.ready, false);
  assert.equal(status.uploader.state, 'invalid');
  assert.equal(status.uploader.reason, 'empty-lock');
});

test('Goal Plus config keeps its source registry adjacent to a custom managed directory', async t => {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'goal-plus-custom-home-'));
  t.after(() => fsp.rm(homeDir, { recursive: true, force: true }));
  const configPath = path.join(homeDir, 'custom-agent-insight', 'collectors', 'goal-plus', 'config.json');
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, JSON.stringify({ apiKey: 'synthetic', hosts: ['pi'] }));

  const config = await loadConfig({ homeDir, configPath });
  assert.equal(config.registryPath, path.join(path.dirname(configPath), 'sources.json'));
});

test('Goal Plus managed config keeps the installed identity authoritative', async t => {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'goal-plus-config-authority-'));
  t.after(() => fsp.rm(homeDir, { recursive: true, force: true }));
  const configPath = path.join(homeDir, '.agent-insight', 'collectors', 'goal-plus', 'config.json');
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, JSON.stringify({
    apiKey: 'managed-key',
    baseUrl: 'https://managed-base.invalid/root/',
    otlpEndpoint: 'https://managed.invalid/traces',
    collaborationSessionsEndpoint: 'https://managed.invalid/collaboration-sessions',
    collaborationEventsEndpoint: 'https://managed.invalid/collaboration-events',
    hosts: ['pi'],
  }));
  const previousApiKey = process.env.AGENT_INSIGHT_API_KEY;
  const previousOtlpEndpoint = process.env.AGENT_INSIGHT_OTLP_ENDPOINT;
  const previousGoalPlusApiKey = process.env.AGENT_INSIGHT_GOAL_PLUS_API_KEY;
  const previousGoalPlusBaseUrl = process.env.AGENT_INSIGHT_GOAL_PLUS_BASE_URL;
  process.env.AGENT_INSIGHT_API_KEY = 'ambient-key';
  process.env.AGENT_INSIGHT_OTLP_ENDPOINT = 'https://ambient.invalid/traces';
  process.env.AGENT_INSIGHT_GOAL_PLUS_API_KEY = 'independent-worker-key';
  t.after(() => {
    if (previousApiKey === undefined) delete process.env.AGENT_INSIGHT_API_KEY;
    else process.env.AGENT_INSIGHT_API_KEY = previousApiKey;
    if (previousOtlpEndpoint === undefined) delete process.env.AGENT_INSIGHT_OTLP_ENDPOINT;
    else process.env.AGENT_INSIGHT_OTLP_ENDPOINT = previousOtlpEndpoint;
    if (previousGoalPlusApiKey === undefined) delete process.env.AGENT_INSIGHT_GOAL_PLUS_API_KEY;
    else process.env.AGENT_INSIGHT_GOAL_PLUS_API_KEY = previousGoalPlusApiKey;
    if (previousGoalPlusBaseUrl === undefined) delete process.env.AGENT_INSIGHT_GOAL_PLUS_BASE_URL;
    else process.env.AGENT_INSIGHT_GOAL_PLUS_BASE_URL = previousGoalPlusBaseUrl;
  });

  const managed = await loadConfig({ homeDir, configPath });
  assert.equal(managed.apiKey, 'managed-key');
  assert.equal(managed.apiKeySource, 'config');
  assert.equal(managed.otlpEndpoint, 'https://managed.invalid/traces');
  assert.equal(managed.collaborationSessionsEndpoint, 'https://managed.invalid/collaboration-sessions');
  assert.equal(managed.collaborationEventsEndpoint, 'https://managed.invalid/collaboration-events');
  assert.deepEqual(managed.configDiagnostics.map((item: { code: string }) => item.code), [
    'ignored_ambient_otlp_endpoint',
  ]);
  assert.doesNotMatch(JSON.stringify(managed.configDiagnostics), /managed-key|ambient-key/);

  const missing = await loadConfig({ homeDir, configPath: path.join(homeDir, 'missing-config.json') });
  assert.equal(missing.apiKey, '');
  assert.equal(missing.apiKeySource, 'missing');

  process.env.AGENT_INSIGHT_GOAL_PLUS_BASE_URL = 'https://explicit.invalid/base/';
  const baseOverridden = await loadConfig({ homeDir, configPath });
  assert.equal(baseOverridden.otlpEndpoint, 'https://explicit.invalid/base/api/ingest/otel/v1/traces');
  assert.equal(baseOverridden.collaborationSessionsEndpoint, 'https://explicit.invalid/base/api/ingest/collaborations/sessions');
  assert.equal(baseOverridden.collaborationEventsEndpoint, 'https://explicit.invalid/base/api/ingest/collaborations/events');

  delete process.env.AGENT_INSIGHT_GOAL_PLUS_BASE_URL;
  const baseOnlyConfigPath = path.join(homeDir, 'base-only.json');
  await fsp.writeFile(baseOnlyConfigPath, JSON.stringify({
    apiKey: 'managed-key',
    baseUrl: 'https://managed-base.invalid/root/',
  }));
  const baseOnly = await loadConfig({ homeDir, configPath: baseOnlyConfigPath });
  assert.equal(baseOnly.otlpEndpoint, 'https://managed-base.invalid/root/api/ingest/otel/v1/traces');
  assert.equal(baseOnly.collaborationSessionsEndpoint, 'https://managed-base.invalid/root/api/ingest/collaborations/sessions');
  assert.equal(baseOnly.collaborationEventsEndpoint, 'https://managed-base.invalid/root/api/ingest/collaborations/events');
});

test('Goal Plus watcher ensure recovers a stale PID after service restart', async t => {
  if (process.platform === 'win32') return t.skip('detached process signaling differs on Windows');
  const { temporary, root } = await copiedFixture(t);
  const homeDir = path.join(temporary, 'home');
  const configPath = path.join(homeDir, '.agent-insight', 'collectors', 'goal-plus', 'config.json');
  const runtimeDir = path.join(path.dirname(configPath), 'runtime');
  await fsp.mkdir(runtimeDir, { recursive: true });
  await fsp.writeFile(configPath, JSON.stringify({
    apiKey: 'synthetic',
    hosts: ['pi'],
    otlpEndpoint: 'http://127.0.0.1:9/traces',
  }));
  await attachSource(root, { homeDir });
  await fsp.writeFile(path.join(runtimeDir, 'watcher.json'), JSON.stringify({
    pid: 2_147_483_647,
    startedAt: '2026-09-07T00:00:00.000Z',
    intervalMs: 60_000,
  }));
  const config = await loadConfig({ homeDir, configPath });
  t.after(() => stopWatcher(config));

  const ensured = await ensureWatcher(config, { intervalMs: 60_000 });
  assert.equal(ensured.ensured, true);
  assert.equal(ensured.running, true);
  assert.equal(ensured.recoveredStalePid, 2_147_483_647);
  assert.notEqual(ensured.pid, 2_147_483_647);
  assert.equal((await watcherStatus(config)).running, true);
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
  const changedConfig = { ...config, otlpEndpoint: 'http://127.0.0.1:9/changed-traces' };
  const reconfigured = await ensureWatcher(changedConfig, { intervalMs: 60_000 });
  assert.equal(reconfigured.restartedForConfigChange, true);
  assert.notEqual(reconfigured.pid, started.pid);
  const rescheduled = await ensureWatcher(changedConfig, { intervalMs: 59_000 });
  assert.equal(rescheduled.restartedForConfigChange, false);
  assert.equal(rescheduled.restartedForIntervalChange, true);
  assert.equal(rescheduled.intervalMs, 59_000);
  assert.notEqual(rescheduled.pid, reconfigured.pid);
  const stopped = await stopWatcher(changedConfig);
  assert.equal(stopped.stopped, true);
  assert.equal((await watcherStatus(config)).running, false);
});

test('Goal Plus ensure stops an active watcher after its credential is revoked', async t => {
  if (process.platform === 'win32') return t.skip('detached process signaling differs on Windows');
  const { temporary, root } = await copiedFixture(t);
  const homeDir = path.join(temporary, 'home');
  const configPath = path.join(homeDir, '.agent-insight', 'collectors', 'goal-plus', 'config.json');
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, JSON.stringify({
    apiKey: 'synthetic',
    hosts: ['pi'],
    otlpEndpoint: 'http://127.0.0.1:9/traces',
  }));
  await attachSource(root, { homeDir });
  const config = await loadConfig({ homeDir, configPath });
  t.after(() => stopWatcher(config));

  const started = await startWatcher(config, { intervalMs: 60_000 });
  assert.equal(started.running, true);
  const revoked = await ensureWatcher({ ...config, apiKey: '' }, { intervalMs: 60_000 });
  assert.equal(revoked.ensured, false);
  assert.equal(revoked.reason, 'not_configured');
  assert.equal(revoked.stoppedForConfigRevocation, true);
  assert.equal(revoked.running, false);
  assert.equal((await watcherStatus(config)).running, false);
});

test('current Goal Plus parser emits stable bounded state without local paths', async t => {
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

test('Goal Plus parser rejects the removed host_handle session schema', async t => {
  const { root } = await copiedFixture(t);
  const sessionPath = path.join(root, 'runs', 'run_demo', 'agent_sessions', 'agent_001.json');
  const session = JSON.parse(await fsp.readFile(sessionPath, 'utf8'));
  delete session.agent_harness;
  delete session.runtime_provider;
  delete session.execution_scope;
  session.host = 'pi-rpc';
  session.host_handle = session.session_handle;
  delete session.session_handle;
  await fsp.writeFile(sessionPath, JSON.stringify(session));
  const parsed = await parseGoalPlusRoot({ sourceId: 'gpsrc_fixture', root }) as ParsedRoot;
  assert.equal(parsed.piSessions.length, 0);
  assert.equal(parsed.relationships.length, 0);
  assert.ok(parsed.diagnostics.some(item => item.code === 'unsupported_goal_plus_schema'));
});

test('Goal Plus parser ignores current Codex sessions outside the Pi-only collection scope', async t => {
  const { root } = await copiedFixture(t);
  const sessionPath = path.join(root, 'runs', 'run_demo', 'agent_sessions', 'agent_001.json');
  const session = JSON.parse(await fsp.readFile(sessionPath, 'utf8'));
  session.agent_harness = 'codex';
  session.session_handle.agent_harness = 'codex';
  await fsp.writeFile(sessionPath, JSON.stringify(session));
  const parsed = await parseGoalPlusRoot({ sourceId: 'gpsrc_fixture', root }) as ParsedRoot;
  assert.equal(parsed.piSessions.length, 0);
  assert.equal(parsed.relationships.length, 0);
  assert.equal(parsed.diagnostics.length, 0);
});

test('Goal Plus parser imports current ThinkThread Pi diagnostic archives as worker traces', async t => {
  const { root } = await copiedFixture(t);
  const metadataPath = path.join(root, 'runs', 'run_demo', 'agent_sessions', 'agent_001.json');
  const metadata = JSON.parse(await fsp.readFile(metadataPath, 'utf8'));
  metadata.runtime_provider = 'thinkthread';
  metadata.execution_scope = 'thinkthread_private';
  metadata.session_handle.runtime_provider = 'thinkthread';
  metadata.session_handle.external_id = 'tt-child';
  delete metadata.session_handle.metadata.session_file;
  await fsp.writeFile(metadataPath, JSON.stringify(metadata));

  const nativePath = path.join(root, 'runs', 'run_demo', 'pi_sessions', 'agent_001.jsonl');
  const entries = (await fsp.readFile(nativePath, 'utf8')).trim().split(/\r?\n/).map((line, index) => ({
    ...JSON.parse(line),
    id: `entry-${index}`,
    parentId: index ? `entry-${index - 1}` : null,
  }));
  await fsp.unlink(nativePath);
  const archive = path.join(root, 'host-logs', 'session-diagnostics', 'tt-child');
  const digest = 'b'.repeat(64);
  const batch = {
    version: 1,
    session_id: 'pi-native-demo',
    stream_id: 'stream-1',
    sequence: 0,
    captured_at: '2026-09-01T01:08:00.000Z',
    leaf_id: entries.at(-1)?.id,
    entries,
  };
  await fsp.mkdir(archive, { recursive: true });
  await fsp.writeFile(path.join(archive, `${digest}.json`), JSON.stringify(batch));
  await fsp.writeFile(path.join(archive, 'index.json'), JSON.stringify({
    version: 1,
    source: 'thinkthread_messages',
    agent_harness: 'pi',
    identity: { thinkthread_id: 'tt-child', agent_session_id: 'agent_001', run_id: 'run_demo', candidate_id: 'candidate_001' },
    batches: { [digest]: { stream_id: 'stream-1', sequence: 0, entries: entries.length } },
    pending_batches: {},
    status: 'recorded',
    session_id: 'pi-native-demo',
  }));

  const parsed = await parseGoalPlusRoot({ sourceId: 'gpsrc_fixture', root }) as ParsedRoot;
  assert.equal(parsed.diagnostics.length, 0);
  assert.equal(parsed.piSessions.length, 1);
  assert.equal(parsed.piSessions[0].sessionFormat, 'pi-diagnostic-archive');
  const trace = await parsePiSession(root, parsed.piSessions[0]) as ParsedPi;
  assert.ok(trace.events.some(event => event.kind === 'llm'));
  assert.ok(trace.events.some(event => event.kind === 'tool'));
  assert.ok(trace.events.every(event => event.sessionId === 'goal-plus:gpsrc_fixture:agent_001'));
});

test('Pi worker locator recovers uniquely timestamp-prefixed host sessions', async t => {
  const { root } = await copiedFixture(t);
  const metadataPath = path.join(root, 'runs', 'run_demo', 'agent_sessions', 'agent_001.json');
  const metadata = JSON.parse(await fsp.readFile(metadataPath, 'utf8'));
  delete metadata.session_handle.metadata.session_file;
  metadata.session_handle.metadata.runner_failed = true;
  metadata.session_handle.metadata.error = 'synthetic worker failure';
  await fsp.writeFile(metadataPath, JSON.stringify(metadata));
  const original = path.join(root, 'runs', 'run_demo', 'pi_sessions', 'agent_001.jsonl');
  const hostDir = path.join(root, 'host-sessions', 'pi');
  await fsp.mkdir(hostDir, { recursive: true });
  const recovered = path.join(hostDir, '2026-09-01T01-05-00-000Z_pi-native-demo.jsonl');
  await fsp.rename(original, recovered);

  const parsed = await parseGoalPlusRoot({ sourceId: 'gpsrc_fixture', root }) as ParsedRoot;
  assert.equal(parsed.piSessions.length, 1);
  const descriptor = parsed.piSessions[0];
  assert.equal(descriptor.sessionFile, recovered);
  assert.equal(descriptor.terminalState, 'failed');
  assert.equal(descriptor.errorMessage, 'synthetic worker failure');
});

test('Pi worker runtime timeout overrides a stale successful session state', async t => {
  const { root } = await copiedFixture(t);
  const metadataPath = path.join(root, 'runs', 'run_demo', 'agent_sessions', 'agent_001.json');
  const metadata = JSON.parse(await fsp.readFile(metadataPath, 'utf8'));
  metadata.status = 'completed';
  metadata.session_handle.metadata.timed_out = true;
  metadata.session_handle.metadata.exit_code = 143;
  await fsp.writeFile(metadataPath, JSON.stringify(metadata));

  const parsed = await parseGoalPlusRoot({ sourceId: 'gpsrc_fixture', root }) as ParsedRoot;
  const descriptor = parsed.piSessions.find(item => item.sessionKind !== 'main');
  assert.ok(descriptor);
  assert.equal(descriptor.terminalState, 'timed_out');
  assert.equal(descriptor.timedOut, true);
  assert.equal(descriptor.controlledTermination, false);
});

test('Pi worker descriptor recognizes completed RPC cleanup as a controlled termination', async t => {
  const { root } = await copiedFixture(t);
  const metadataPath = path.join(root, 'runs', 'run_demo', 'agent_sessions', 'agent_001.json');
  const metadata = JSON.parse(await fsp.readFile(metadataPath, 'utf8'));
  metadata.session_handle.metadata.runner_failed = false;
  metadata.session_handle.metadata.timed_out = false;
  metadata.session_handle.metadata.exit_code = 143;
  metadata.session_handle.metadata.terminal_state = 'completed';
  metadata.launch.budget_control = { max_runtime_seconds: 179 };
  await fsp.writeFile(metadataPath, JSON.stringify(metadata));

  const parsed = await parseGoalPlusRoot({ sourceId: 'gpsrc_fixture', root }) as ParsedRoot;
  const descriptor = parsed.piSessions.find(item => item.sessionKind !== 'main');
  assert.ok(descriptor);
  assert.equal((descriptor as PiSessionDescriptor & { agentHarness: string }).agentHarness, 'pi');
  assert.equal(descriptor.terminalState, 'completed');
  assert.equal(descriptor.progressStatus, 'completed');
  assert.equal(descriptor.controlledTermination, true);
  assert.equal(descriptor.runtimeBudgetSeconds, 179);
});

test('Goal Plus state parser ignores an incomplete JSONL tail', async t => {
  const { root } = await copiedFixture(t);
  await fsp.appendFile(path.join(root, 'goal-plus', 'gp_demo', 'events.jsonl'), '{"event_id":"half');
  const parsed = await parseGoalPlusRoot({ sourceId: 'gpsrc_fixture', root }) as ParsedRoot;
  assert.equal(parsed.diagnostics.length, 0);
  assert.equal(parsed.snapshots.filter(item => item.kind === 'goal_event').length, 1);
});

test('Goal Plus scan uploads worker traces and then their explicit relationships', async t => {
  const { temporary, root } = await copiedFixture(t);
  const order: string[] = [];
  const config = {
    apiKey: 'synthetic',
    homeDir: temporary,
    otlpEndpoint: 'http://example.invalid/traces',
    collaborationSessionsEndpoint: 'http://example.invalid/collaboration-sessions',
    collaborationEventsEndpoint: 'http://example.invalid/collaboration-events',
  };
  const source = {
    sourceId: 'gpsrc_fixture',
    root,
    workspaceFingerprint: `sha256:${'a'.repeat(64)}`,
  };

  await scanSource(source, config, {
    relationshipOutbox: {
      async enqueueRelationships(relationships: unknown[]) {
        order.push(`relationships:${relationships.length}`);
        return { queued: relationships.length * 2, rejected: 0 };
      },
      async flushOnce() {
        order.push('relationship-upload');
        return { acquired: true, uploaded: 2, retried: 0, rejected: 0, deferred: 0 };
      },
    },
    nativeImporter: async () => {
      order.push('native');
      return { imported: 1, uploadedEvents: 3, diagnostics: [] };
    },
  });

  assert.deepEqual(order, ['relationships:1', 'native', 'relationship-upload']);
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

test('Pi worker runtime outcome distinguishes controlled cleanup from timeout and crashes', () => {
  const active = runtimeOutcome({
    host: 'pi-rpc',
  }, false);
  assert.equal(active.failed, false);
  assert.equal(active.runtimeState, 'running');

  const controlled = runtimeOutcome({
    host: 'pi-rpc',
    terminalState: 'completed',
    progressStatus: 'completed',
    runnerFailed: false,
    timedOut: false,
    exitCode: 143,
  }, false);
  assert.equal(controlled.failed, false);
  assert.equal(controlled.controlledTermination, true);
  assert.equal(controlled.runtimeState, 'completed');
  assert.equal(controlled.error, undefined);

  const timedOut = runtimeOutcome({
    host: 'pi-rpc',
    terminalState: 'timed_out',
    progressStatus: 'timed_out',
    runnerFailed: false,
    timedOut: true,
    runtimeBudgetSeconds: 179,
    exitCode: 143,
  }, false);
  assert.equal(timedOut.failed, true);
  assert.equal(timedOut.controlledTermination, false);
  assert.equal(timedOut.runtimeState, 'timed_out');
  assert.equal(timedOut.error, 'Goal Plus Pi worker exceeded its 179-second runtime budget');

  const runnerFailed = runtimeOutcome({
    host: 'pi-rpc',
    terminalState: 'completed',
    progressStatus: 'completed',
    runnerFailed: true,
    timedOut: false,
    exitCode: 143,
  }, false);
  assert.equal(runnerFailed.failed, true);
  assert.equal(runnerFailed.error, 'Goal Plus Pi worker runner failed');

  const unexpectedExit = runtimeOutcome({
    host: 'pi-rpc',
    terminalState: 'completed',
    progressStatus: 'completed',
    runnerFailed: false,
    timedOut: false,
    controlledTermination: true,
    exitCode: 1,
  }, false);
  assert.equal(unexpectedExit.failed, true);
  assert.equal(unexpectedExit.error, 'Goal Plus Pi worker exited unexpectedly with code 1');
});

test('Pi passive parser treats a completed RPC SIGTERM as success but preserves its exit code', async t => {
  const { root } = await copiedFixture(t);
  const parsed = await parsePiSession(root, {
    sourceId: 'gpsrc_fixture',
    agentSessionId: 'agent_001',
    role: 'candidate-worker',
    host: 'pi-rpc',
    sessionFile: 'runs/run_demo/pi_sessions/agent_001.jsonl',
    terminalState: 'completed',
    progressStatus: 'completed',
    runnerFailed: false,
    timedOut: false,
    controlledTermination: true,
    exitCode: 143,
  }) as ParsedPi;
  const agent = parsed.events.find(item => item.kind === 'agent');
  assert.equal(agent?.status, 'success');
  assert.equal(agent?.attributes?.['goal_plus.runtime_state'], 'completed');
  assert.equal(agent?.attributes?.['goal_plus.controlled_termination'], true);
  assert.equal(agent?.attributes?.['goal_plus.exit_code'], 143);
});

test('Goal Plus Pi importer checkpoints durable events before upload and skips 100 unchanged scans', async t => {
  const { temporary, root } = await copiedFixture(t);
  const stateDir = path.join(temporary, 'pi-import-state');
  const descriptor = {
    sourceId: 'gpsrc_fixture',
    agentSessionId: 'agent_001',
    runId: 'run_demo',
    candidateId: 'candidate_001',
    role: 'candidate-worker',
    sessionFile: 'runs/run_demo/pi_sessions/agent_001.jsonl',
  };
  const appended: NativeEvent[] = [];
  const order: string[] = [];
  const checkpointPath = path.join(stateDir, 'goal-plus-import-checkpoint.json');
  await assert.rejects(() => importPiSessions(root, [descriptor], {
    apiKey: 'synthetic',
    homeDir: temporary,
    stateDir,
    endpoint: 'https://example.invalid/traces',
    writer: memoryWriter(appended, order),
    uploader: {
      async flushOnce() {
        order.push('upload');
        const checkpoint = JSON.parse(await fsp.readFile(checkpointPath, 'utf8'));
        assert.ok(checkpoint.sessions['goal-plus:gpsrc_fixture:agent_001']);
        throw new Error('synthetic network failure');
      },
    },
  }), /synthetic network failure/);
  assert.ok(appended.length > 0);
  assert.ok(order.lastIndexOf('flush') < order.indexOf('upload'));

  for (let index = 0; index < 100; index += 1) {
    const duplicateWrites: NativeEvent[] = [];
    const result = await importPiSessions(root, [descriptor], {
      apiKey: 'synthetic',
      homeDir: temporary,
      stateDir,
      endpoint: 'https://example.invalid/traces',
      upload: false,
      writer: memoryWriter(duplicateWrites),
      uploader: { async flushOnce() { throw new Error('upload must remain disabled'); } },
    });
    assert.equal(result.skipped, 1);
    assert.equal(result.appendedEvents, 0);
    assert.equal(duplicateWrites.length, 0);
  }
});

test('Pi importer reparses a legacy outcome checkpoint without replaying unchanged events', async t => {
  const { temporary, root } = await copiedFixture(t);
  const stateDir = path.join(temporary, 'pi-outcome-migration-state');
  const checkpointPath = path.join(stateDir, 'goal-plus-import-checkpoint.json');
  const descriptor = {
    sourceId: 'gpsrc_fixture',
    agentSessionId: 'agent_001',
    role: 'candidate-worker',
    host: 'pi-rpc',
    sessionFile: 'runs/run_demo/pi_sessions/agent_001.jsonl',
    terminalState: 'completed',
    progressStatus: 'completed',
    runnerFailed: false,
    timedOut: false,
    controlledTermination: true,
    exitCode: 143,
  };
  const firstEvents: NativeEvent[] = [];
  await importPiSessions(root, [descriptor], {
    apiKey: 'synthetic',
    homeDir: temporary,
    stateDir,
    endpoint: 'https://example.invalid/traces',
    upload: false,
    writer: memoryWriter(firstEvents),
  });
  const legacy = JSON.parse(await fsp.readFile(checkpointPath, 'utf8'));
  delete legacy.sessions['goal-plus:gpsrc_fixture:agent_001'].outcomeDerivationVersion;
  await fsp.writeFile(checkpointPath, JSON.stringify(legacy));

  const replayedEvents: NativeEvent[] = [];
  const migrated = await importPiSessions(root, [descriptor], {
    apiKey: 'synthetic',
    homeDir: temporary,
    stateDir,
    endpoint: 'https://example.invalid/traces',
    upload: false,
    writer: memoryWriter(replayedEvents),
  });
  assert.equal(migrated.skipped, 0);
  assert.equal(migrated.appendedEvents, 0);
  assert.equal(migrated.unchangedEvents, firstEvents.length);
  assert.equal(replayedEvents.length, 0);
  const checkpoint = JSON.parse(await fsp.readFile(checkpointPath, 'utf8'));
  assert.equal(
    checkpoint.sessions['goal-plus:gpsrc_fixture:agent_001'].outcomeDerivationVersion,
    3,
  );
});

test('Goal Plus Pi importer reports a blocked uploader instead of silently returning zero', async t => {
  const { temporary, root } = await copiedFixture(t);
  const events: NativeEvent[] = [];
  const result = await importPiSessions(root, [{
    sourceId: 'gpsrc_fixture',
    agentSessionId: 'agent_001',
    sessionFile: 'runs/run_demo/pi_sessions/agent_001.jsonl',
  }], {
    apiKey: 'synthetic',
    homeDir: temporary,
    stateDir: path.join(temporary, 'pi-upload-blocked'),
    endpoint: 'https://example.invalid/traces',
    writer: memoryWriter(events),
    uploader: {
      async flushOnce() {
        return {
          acquired: false,
          uploadedEvents: 0,
          lockStatus: { state: 'invalid', reason: 'empty-lock', recoverable: true },
        };
      },
    },
  });

  assert.ok(events.length > 0);
  assert.equal(result.uploadStatus.acquired, false);
  assert.deepEqual(
    result.diagnostics.filter((item: { code?: string }) => item.code === 'pi_upload_blocked'),
    [{
      code: 'pi_upload_blocked',
      message: 'Goal Plus Pi uploader did not acquire its lock: invalid (empty-lock)',
    }],
  );
});

test('Goal Plus Pi importer appends only new or changed events and refreshes terminal metadata', async t => {
  const { temporary, root } = await copiedFixture(t);
  const stateDir = path.join(temporary, 'pi-incremental-state');
  const sessionFile = path.join(root, 'runs', 'run_demo', 'pi_sessions', 'agent_001.jsonl');
  const descriptor = {
    sourceId: 'gpsrc_fixture',
    agentSessionId: 'agent_001',
    runId: 'run_demo',
    candidateId: 'candidate_001',
    role: 'candidate-worker',
    sessionFile: path.relative(root, sessionFile),
  };
  const initialEvents: NativeEvent[] = [];
  const first = await importPiSessions(root, [descriptor], {
    apiKey: 'synthetic',
    homeDir: temporary,
    stateDir,
    endpoint: 'https://example.invalid/traces',
    upload: false,
    writer: memoryWriter(initialEvents),
    uploader: { async flushOnce() { return { uploadedEvents: 0 }; } },
  });
  assert.equal(first.appendedEvents, initialEvents.length);

  await fsp.appendFile(sessionFile, [
    { type: 'message', timestamp: '2026-09-01T01:06:00Z', message: { role: 'user', content: 'One more check' } },
    { type: 'message', timestamp: '2026-09-01T01:06:10Z', message: { role: 'assistant', stopReason: 'stop', content: 'Additional result' } },
  ].map(record => JSON.stringify(record)).join('\n') + '\n');
  const incrementalEvents: NativeEvent[] = [];
  const incremental = await importPiSessions(root, [descriptor], {
    apiKey: 'synthetic',
    homeDir: temporary,
    stateDir,
    endpoint: 'https://example.invalid/traces',
    upload: false,
    writer: memoryWriter(incrementalEvents),
    uploader: { async flushOnce() { return { uploadedEvents: 0 }; } },
  });
  assert.equal(incremental.appendedEvents, 2);
  assert.equal(incrementalEvents.filter(event => event.kind === 'llm').length, 1);
  assert.equal(incrementalEvents.filter(event => event.kind === 'agent').length, 1);
  assert.ok(incremental.appendedEvents < initialEvents.length);

  const terminalEvents: NativeEvent[] = [];
  const terminal = await importPiSessions(root, [{
    ...descriptor,
    terminalState: 'failed',
    exitCode: 9,
    errorMessage: 'worker process failed',
  }], {
    apiKey: 'synthetic',
    homeDir: temporary,
    stateDir,
    endpoint: 'https://example.invalid/traces',
    upload: false,
    writer: memoryWriter(terminalEvents),
    uploader: { async flushOnce() { return { uploadedEvents: 0 }; } },
  });
  assert.equal(terminal.appendedEvents, 1);
  assert.equal(terminalEvents[0]?.kind, 'agent');
  assert.equal(terminalEvents[0]?.status, 'error');
  assert.equal(terminalEvents[0]?.attributes?.['goal_plus.exit_code'], 9);
});

test('Goal Plus Pi importer rebuilds a session checkpoint after truncation', async t => {
  const { temporary, root } = await copiedFixture(t);
  const stateDir = path.join(temporary, 'pi-truncation-state');
  const sessionFile = path.join(root, 'runs', 'run_demo', 'pi_sessions', 'agent_001.jsonl');
  const descriptor = {
    sourceId: 'gpsrc_fixture',
    agentSessionId: 'agent_001',
    sessionFile: path.relative(root, sessionFile),
  };
  const runImport = async (events: NativeEvent[]) => importPiSessions(root, [descriptor], {
    apiKey: 'synthetic',
    homeDir: temporary,
    stateDir,
    endpoint: 'https://example.invalid/traces',
    upload: false,
    writer: memoryWriter(events),
    uploader: { async flushOnce() { return { uploadedEvents: 0 }; } },
  });
  const initialEvents: NativeEvent[] = [];
  await runImport(initialEvents);

  await fsp.writeFile(sessionFile, [
    { type: 'message', timestamp: '2026-09-01T01:05:00Z', message: { role: 'user', content: 'Restarted session' } },
    { type: 'message', timestamp: '2026-09-01T01:05:01Z', message: { role: 'assistant', stopReason: 'stop', content: 'Recovered' } },
  ].map(record => JSON.stringify(record)).join('\n') + '\n');
  const rebuiltEvents: NativeEvent[] = [];
  const rebuilt = await runImport(rebuiltEvents);
  assert.equal(rebuilt.appendedEvents, 2);
  assert.deepEqual(new Set(rebuiltEvents.map(event => event.kind)), new Set(['llm', 'agent']));

  const unchangedEvents: NativeEvent[] = [];
  const unchanged = await runImport(unchangedEvents);
  assert.equal(unchanged.skipped, 1);
  assert.equal(unchangedEvents.length, 0);
  const checkpoint = JSON.parse(await fsp.readFile(path.join(stateDir, 'goal-plus-import-checkpoint.json'), 'utf8'));
  assert.equal(checkpoint.sessions['goal-plus:gpsrc_fixture:agent_001'].generation, 1);
});

test('Pi passive parser preserves thinking and reports aborted Goal Plus workers', async t => {
  const { root } = await copiedFixture(t);
  const sessionFile = path.join(root, 'runs', 'run_demo', 'pi_sessions', 'agent_001.jsonl');
  await fsp.appendFile(sessionFile, `${JSON.stringify({
    type: 'message',
    timestamp: '2026-09-01T01:05:40Z',
    message: {
      role: 'assistant',
      stopReason: 'aborted',
      content: [
        { type: 'thinking', thinking: 'full internal reasoning' },
        { type: 'text', text: 'partial visible answer' },
      ],
    },
  })}\n`);
  const parsed = await parsePiSession(root, {
    sourceId: 'gpsrc_fixture',
    agentSessionId: 'agent_001',
    sessionFile: path.relative(root, sessionFile),
    terminalState: 'aborted',
    exitCode: 143,
  }) as ParsedPi;
  const finalLlm = parsed.events.filter(item => item.kind === 'llm').at(-1);
  const agent = parsed.events.find(item => item.kind === 'agent');
  assert.match(finalLlm?.output || '', /<thinking>\nfull internal reasoning\n<\/thinking>/);
  assert.match(finalLlm?.output || '', /partial visible answer/);
  assert.equal(finalLlm?.status, 'error');
  assert.equal(agent?.status, 'error');
  assert.equal(agent?.attributes?.['goal_plus.exit_code'], 143);
});

test('Goal Plus parser emits one stable worker binding and edge without re-importing the Pi main trace', async t => {
  const { root } = await copiedFixture(t);
  const first = await parseGoalPlusRoot({ sourceId: 'gpsrc_fixture', root }) as ParsedRoot;
  const second = await parseGoalPlusRoot({ sourceId: 'gpsrc_fixture', root }) as ParsedRoot;

  assert.equal(first.piSessions.length, 1);
  assert.equal(first.piSessions.some(item => item.sessionKind === 'main'), false);
  assert.equal(first.relationships.length, 1);
  assert.deepEqual(first.relationships, second.relationships);
  const relationship = first.relationships[0];
  assert.match(relationship.binding.collaborationId, /^gp\.[a-f0-9]{32}$/);
  assert.equal(relationship.binding.sessionId, 'worker:run_demo:agent_001');
  assert.equal(relationship.binding.traceSessionId, 'goal-plus:gpsrc_fixture:agent_001');
  assert.equal(relationship.binding.eventClock, 'unknown');
  assert.equal(relationship.event.collaborationId, relationship.binding.collaborationId);
  assert.match(relationship.event.eventId, /^worker\.[a-f0-9]{32}$/);
  assert.equal(relationship.event.fromSessionId, 'main');
  assert.equal(relationship.event.toSessionId, relationship.binding.sessionId);
  assert.deepEqual(relationship.event.fromLocator, { recordType: 'tool', name: 'goal_plus_session_run' });
});

test('Pi continuation uses the latest assistant outcome instead of a recovered abort', async t => {
  const { root } = await copiedFixture(t);
  const sessionFile = path.join(root, 'runs', 'run_demo', 'pi_sessions', 'agent_001.jsonl');
  await fsp.writeFile(sessionFile, [
    { type: 'message', timestamp: '2026-09-01T01:05:00Z', message: { role: 'user', content: 'Start' } },
    { type: 'message', timestamp: '2026-09-01T01:05:10Z', message: { role: 'assistant', stopReason: 'aborted', content: [{ type: 'text', text: 'Partial' }] } },
    { type: 'message', timestamp: '2026-09-01T01:05:20Z', message: { role: 'user', content: 'Continue' } },
    { type: 'message', timestamp: '2026-09-01T01:05:30Z', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Recovered and done' }] } },
  ].map(record => JSON.stringify(record)).join('\n') + '\n');

  const parsed = await parsePiSession(root, {
    sourceId: 'gpsrc_fixture',
    agentSessionId: 'agent_001',
    sessionFile: path.relative(root, sessionFile),
    terminalState: 'completed',
    businessState: 'blocked',
  }) as ParsedPi;
  const llms = parsed.events.filter(item => item.kind === 'llm');
  const agent = parsed.events.find(item => item.kind === 'agent');
  assert.equal(llms[0]?.status, 'error');
  assert.equal(llms[1]?.status, 'success');
  assert.equal(agent?.status, 'success');
  assert.equal(agent?.attributes?.['goal_plus.business_state'], 'blocked');
});

test('Pi message text does not truncate large native content', () => {
  const text = '完整正文'.repeat(20_000);
  assert.equal(messageText({ content: [{ type: 'text', text }] }), text);
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
