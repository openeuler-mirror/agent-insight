import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import AdmZip from 'adm-zip';

import { GET as getInstaller } from '@/app/api/ingest/setup/goal-plus/route';
import { GET as getAsset } from '@/app/api/ingest/setup/goal-plus/assets/[asset]/route';
import { GET as getSetup } from '@/app/api/ingest/setup/route';
import { GET as getAutoSetup } from '@/app/api/ingest/setup/auto/route';

const require = createRequire(import.meta.url);
const { install } = require('../scripts/agent-trace-collectors/goal-plus/install.cjs');
const { attachSource } = require('../scripts/agent-trace-collectors/goal-plus/lib/source-registry.cjs');
const {
  loadConfig,
  startWatcher,
  stopWatcher,
} = require('../scripts/agent-trace-collectors/goal-plus/goal-plus-collector.cjs');

const ENTRIES = [
  'goal-plus/goal-plus-collector.cjs',
  'goal-plus/install.cjs',
  'goal-plus/lib/gp-snapshot-parser.cjs',
  'goal-plus/lib/pi-native-parser.cjs',
  'goal-plus/lib/source-registry.cjs',
  'goal-plus/uninstall.cjs',
  'shared/collaboration-transport.cjs',
  'shared/pi-trace-helpers.cjs',
  'shared/trace-transport.cjs',
];

test('Goal Plus setup serves a checksum-pinned self-contained bundle', async () => {
  const installer = await getInstaller(new Request('https://insight.example/api/ingest/setup/goal-plus'));
  const source = await installer.text();
  assert.equal(installer.status, 200);
  assert.match(source, /Node\.js >=22\.19\.0/);
  assert.match(source, /AGENT_INSIGHT_API_KEY/);
  assert.doesNotMatch(source, /apiKey=/);
  const expected = /EXPECTED_SHA256='([a-f0-9]{64})'/.exec(source)?.[1];
  assert.ok(expected);

  const response = await getAsset(new Request('https://insight.example/asset'), { params: Promise.resolve({ asset: 'goal-plus-collector.zip' }) });
  const buffer = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash('sha256').update(buffer).digest('hex'), expected);
  assert.deepEqual(new AdmZip(buffer).getEntries().map(entry => entry.entryName).sort(), ENTRIES);
});

test('Goal Plus setup emits a PowerShell bootstrap and rejects unknown assets', async () => {
  const installer = await getInstaller(new Request('https://insight.example/api/ingest/setup/goal-plus', { headers: { 'x-platform': 'windows' } }));
  const source = await installer.text();
  assert.equal(installer.headers.get('content-type'), 'application/x-powershell; charset=utf-8');
  assert.match(source, /Get-FileHash/);
  assert.match(source, /Expand-Archive/);
  assert.doesNotMatch(source, /apiKey=/);
  const denied = await getAsset(new Request('https://insight.example/asset'), { params: Promise.resolve({ asset: '../../package.json' }) });
  assert.equal(denied.status, 404);
});

test('legacy Goal Plus setup input is transparently mapped to the Pi installation', async () => {
  for (const platform of ['unix', 'windows'] as const) {
    const main = await getSetup(new Request('https://insight.example/api/ingest/setup?frameworks=goal-plus&goalPlusHosts=pi,codex&key=synthetic&nokey=1', {
      headers: { host: 'insight.example', 'x-forwarded-proto': 'https', 'x-platform': platform },
    }));
    const auto = await getAutoSetup(new Request(
      'https://insight.example/api/setup/auto?frameworks=goal-plus&goalPlusHosts=pi,codex&apiKey=synthetic&host=insight.example',
      { headers: { host: 'insight.example', 'x-forwarded-proto': 'https', 'x-platform': platform } },
    ));
    for (const [name, response] of [['main', main], ['auto', auto]] as const) {
      const generated = await response.text();
      assert.equal(response.status, 200);
      assert.match(generated, /SELECTED_FRAMEWORKS(?:=| = )"pi-agent"/);
      assert.match(generated, /GOAL_PLUS_HOSTS(?:=| = )""/);
      assert.doesNotMatch(generated, /SELECTED_FRAMEWORKS(?:=| = )"goal-plus/);
      assert.doesNotMatch(generated, /GOAL_PLUS_HOSTS(?:=| = )"(?:pi|codex)/i);
      if (platform === 'unix') {
        const syntax = spawnSync('bash', ['-n'], { input: generated, encoding: 'utf8' });
        assert.equal(syntax.status, 0, `${name} Bash setup script must parse: ${syntax.stderr}`);
      }
    }
  }
});

test('Goal Plus installer writes only managed collector state', async t => {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'goal-plus-install-'));
  t.after(() => fsp.rm(homeDir, { recursive: true, force: true }));
  const previousKey = process.env.AGENT_INSIGHT_API_KEY;
  const previousHome = process.env.AGENT_INSIGHT_HOME;
  process.env.AGENT_INSIGHT_API_KEY = 'synthetic-install-key';
  delete process.env.AGENT_INSIGHT_HOME;
  t.after(() => {
    if (previousKey === undefined) delete process.env.AGENT_INSIGHT_API_KEY;
    else process.env.AGENT_INSIGHT_API_KEY = previousKey;
    if (previousHome === undefined) delete process.env.AGENT_INSIGHT_HOME;
    else process.env.AGENT_INSIGHT_HOME = previousHome;
  });
  const result = await install({ homeDir, sourceDir: path.join(process.cwd(), 'scripts', 'agent-trace-collectors', 'goal-plus'), skipVersionCheck: true });
  assert.equal(result.packageDir, path.join(homeDir, '.agent-insight', 'collectors', 'goal-plus'));
  const config = JSON.parse(await fsp.readFile(result.configPath, 'utf8'));
  assert.equal(config.apiKey, 'synthetic-install-key');
  assert.deepEqual(config.hosts, ['pi']);
  assert.match(await fsp.readFile(result.commandPath, 'utf8'), /managed-by-agent-insight-goal-plus/);

  await install({ homeDir, sourceDir: path.join(process.cwd(), 'scripts', 'agent-trace-collectors', 'goal-plus'), skipVersionCheck: true });
  const reinstalled = JSON.parse(await fsp.readFile(result.configPath, 'utf8'));
  assert.deepEqual(reinstalled.hosts, ['pi']);
});

test('Pi-managed Goal Plus installation replaces an existing configuration', async t => {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'goal-plus-compatible-install-'));
  t.after(() => fsp.rm(homeDir, { recursive: true, force: true }));
  const packageDir = path.join(homeDir, '.agent-insight', 'collectors', 'goal-plus');
  const configPath = path.join(packageDir, 'config.json');
  await fsp.mkdir(packageDir, { recursive: true });
  const manualConfig = {
    version: 1,
    apiKey: 'synthetic-compatible-key',
    baseUrl: 'https://manual.example',
    hosts: ['pi'],
    otlpEndpoint: 'https://manual.example/custom/traces',
  };
  await fsp.writeFile(configPath, `${JSON.stringify(manualConfig, null, 2)}\n`);
  const result = await install({
    homeDir,
    sourceDir: path.join(process.cwd(), 'scripts', 'agent-trace-collectors', 'goal-plus'),
    skipVersionCheck: true,
    createWrapper: false,
    managedBy: 'pi-agent',
    apiKey: 'pi-managed-key',
    baseUrl: 'https://pi.example',
    otlpEndpoint: 'https://pi.example/traces',
    collaborationSessionsEndpoint: 'https://pi.example/sessions',
    collaborationEventsEndpoint: 'https://pi.example/events',
  });

  assert.equal(result.observerEnabled, true);
  assert.deepEqual(JSON.parse(await fsp.readFile(configPath, 'utf8')), {
    version: 1,
    apiKey: 'pi-managed-key',
    baseUrl: 'https://pi.example',
    hosts: ['pi'],
    managedBy: 'pi-agent',
    otlpEndpoint: 'https://pi.example/traces',
    collaborationSessionsEndpoint: 'https://pi.example/sessions',
    collaborationEventsEndpoint: 'https://pi.example/events',
  });
  assert.equal(result.watcher.reason, 'no_sources');
});

test('Pi installation replaces a different-account Goal Plus collector', async t => {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'goal-plus-account-replace-'));
  t.after(() => fsp.rm(homeDir, { recursive: true, force: true }));
  const packageDir = path.join(homeDir, '.agent-insight', 'collectors', 'goal-plus');
  const configPath = path.join(packageDir, 'config.json');
  const collectorPath = path.join(packageDir, 'goal-plus-collector.cjs');
  await fsp.mkdir(packageDir, { recursive: true });
  await fsp.writeFile(configPath, '{"version":1,"apiKey":"another-account"}\n');
  await fsp.writeFile(collectorPath, 'manual collector\n');
  const previousKey = process.env.AGENT_INSIGHT_API_KEY;
  process.env.AGENT_INSIGHT_API_KEY = 'pi-account';
  t.after(() => {
    if (previousKey === undefined) delete process.env.AGENT_INSIGHT_API_KEY;
    else process.env.AGENT_INSIGHT_API_KEY = previousKey;
  });

  const result = await install({
    homeDir,
    sourceDir: path.join(process.cwd(), 'scripts', 'agent-trace-collectors', 'goal-plus'),
    skipVersionCheck: true,
    createWrapper: false,
    managedBy: 'pi-agent',
  });

  assert.equal(result.observerEnabled, true);
  assert.equal(result.observerStatus, 'dormant');
  assert.equal(JSON.parse(await fsp.readFile(configPath, 'utf8')).apiKey, 'pi-account');
  assert.match(await fsp.readFile(collectorPath, 'utf8'), /COLLECTOR_VERSION/);
});

test('Pi-managed reinstall restarts an existing Goal Plus watcher with the new identity', async t => {
  if (process.platform === 'win32') return t.skip('detached process signaling differs on Windows');
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'goal-plus-account-restart-'));
  let activeConfig: Awaited<ReturnType<typeof loadConfig>> | undefined;
  t.after(async () => {
    if (activeConfig) await stopWatcher(activeConfig);
    await fsp.rm(homeDir, { recursive: true, force: true });
  });
  const sourceDir = path.join(process.cwd(), 'scripts', 'agent-trace-collectors', 'goal-plus');
  const common = {
    homeDir,
    sourceDir,
    skipVersionCheck: true,
    createWrapper: false,
    managedBy: 'pi-agent',
    baseUrl: 'http://127.0.0.1:9',
    otlpEndpoint: 'http://127.0.0.1:9/traces',
    collaborationSessionsEndpoint: 'http://127.0.0.1:9/sessions',
    collaborationEventsEndpoint: 'http://127.0.0.1:9/events',
  };
  const first = await install({ ...common, apiKey: 'first-account-key' });
  const fixture = path.join(process.cwd(), 'test', 'fixtures', 'goal-plus', '.gp');
  await attachSource(fixture, { homeDir });
  const firstConfig = await loadConfig({ homeDir, configPath: first.configPath });
  activeConfig = firstConfig;
  const started = await startWatcher(firstConfig, { intervalMs: 60_000 });
  assert.equal(started.running, true);

  const second = await install({ ...common, apiKey: 'second-account-key' });
  const secondConfig = await loadConfig({ homeDir, configPath: second.configPath });
  activeConfig = secondConfig;
  assert.equal(second.stoppedWatcher.stopped, true);
  assert.equal(second.watcher.running, true);
  assert.notEqual(second.watcher.pid, started.pid);
  assert.equal(secondConfig.apiKey, 'second-account-key');
});

test('Agent Insight launch paths re-ensure Goal Plus watcher without blocking the server', async () => {
  for (const relative of ['scripts/develop_start.sh', 'scripts/start.sh']) {
    const source = await fsp.readFile(path.join(process.cwd(), relative), 'utf8');
    assert.match(source, /agent-trace-collectors\/goal-plus\/goal-plus-collector\.cjs/);
    assert.match(source, /ensure --config/);
    assert.match(source, /Agent Insight remains available/);
  }

  const cliStart = await fsp.readFile(path.join(process.cwd(), 'scripts', 'start.js'), 'utf8');
  assert.match(cliStart, /function ensureGoalPlusWatcher/);
  assert.match(cliStart, /'ensure'/);
  assert.match(cliStart, /Agent Insight remains available/);
});
