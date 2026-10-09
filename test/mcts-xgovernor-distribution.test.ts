import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import AdmZip from 'adm-zip';

import { GET as getAutoSetup } from '@/app/api/ingest/setup/auto/route';
import { GET as getAsset } from '@/app/api/ingest/setup/mcts-xgovernor/assets/[asset]/route';
import { GET as getInstaller } from '@/app/api/ingest/setup/mcts-xgovernor/route';
import { GET as getSetup } from '@/app/api/ingest/setup/route';
import { parseFrameworks, resolveInstallProfile } from '@/lib/ingest/setup/install-profile';

const require = createRequire(import.meta.url);
const { install } = require('../scripts/agent-trace-collectors/mcts-xgovernor-proxy/install.cjs');

const ENTRIES = [
  'mcts-xgovernor-proxy/core.cjs',
  'mcts-xgovernor-proxy/gateway.cjs',
  'mcts-xgovernor-proxy/install.cjs',
  'mcts-xgovernor-proxy/run.cjs',
  'shared/collaboration-transport.cjs',
  'shared/trace-transport.cjs',
];

test('MCTS setup serves a checksum-pinned self-contained bundle', async () => {
  const installer = await getInstaller(new Request('https://insight.example/api/ingest/setup/mcts-xgovernor'));
  const source = await installer.text();
  assert.equal(installer.status, 200);
  assert.match(source, /Node\.js >=22\.19\.0/);
  assert.match(source, /AGENT_INSIGHT_API_KEY/);
  assert.doesNotMatch(source, /apiKey=/);
  const syntax = spawnSync('sh', ['-n'], { input: source, encoding: 'utf8' });
  assert.equal(syntax.status, 0, `MCTS bootstrap must parse as POSIX shell: ${syntax.stderr}`);
  const expected = /EXPECTED_SHA256='([a-f0-9]{64})'/.exec(source)?.[1];
  assert.ok(expected);

  const response = await getAsset(new Request('https://insight.example/asset'), {
    params: Promise.resolve({ asset: 'mcts-xgovernor-collector.zip' }),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200);
  assert.equal(createHash('sha256').update(buffer).digest('hex'), expected);
  assert.deepEqual(new AdmZip(buffer).getEntries().map(entry => entry.entryName).sort(), ENTRIES);
});

test('MCTS setup rejects Windows and unknown assets', async () => {
  const windows = await getInstaller(new Request('https://insight.example/api/ingest/setup/mcts-xgovernor', {
    headers: { 'x-platform': 'windows' },
  }));
  assert.equal(windows.status, 400);
  assert.match(await windows.text(), /WSL/);

  const denied = await getAsset(new Request('https://insight.example/asset'), {
    params: Promise.resolve({ asset: '../../package.json' }),
  });
  assert.equal(denied.status, 404);
});

test('setup routes reject unsafe MCTS upstream URLs', async () => {
  const urls = [
    'https://insight.example/api/ingest/setup?frameworks=mcts-xgovernor&mctsUpstream=https%3A%2F%2Fuser%3Asecret%40xgovernor.example&key=synthetic&yes=1&nokey=1',
    'https://insight.example/api/setup/auto?frameworks=mcts-xgovernor&mctsUpstream=file%3A%2F%2F%2Ftmp%2Fsocket&apiKey=synthetic&host=insight.example',
  ];
  for (const [index, url] of urls.entries()) {
    const response = index === 0
      ? await getSetup(new Request(url))
      : await getAutoSetup(new Request(url));
    assert.equal(response.status, 400);
  }
});

test('MCTS is a standalone installation framework', () => {
  const profile = resolveInstallProfile(parseFrameworks('mcts-xgovernor'));
  assert.deepEqual(profile.requestedFrameworks.map(item => item.value), ['mcts-xgovernor']);
  assert.deepEqual(profile.effectiveFrameworks.map(item => item.value), ['mcts-xgovernor']);
  assert.deepEqual(profile.autoAddedFrameworks, []);
  assert.deepEqual(profile.goalPlusHosts, []);
});

test('setup commands install only the selected MCTS collector and preserve its upstream', async () => {
  const upstream = 'http://127.0.0.1:9876';
  const main = await getSetup(new Request(
    `https://insight.example/api/ingest/setup?frameworks=mcts-xgovernor&mctsUpstream=${encodeURIComponent(upstream)}&key=synthetic&yes=1&nokey=1`,
    { headers: { host: 'insight.example', 'x-forwarded-proto': 'https', 'x-platform': 'unix' } },
  ));
  const auto = await getAutoSetup(new Request(
    `https://insight.example/api/setup/auto?frameworks=mcts-xgovernor&mctsUpstream=${encodeURIComponent(upstream)}&apiKey=synthetic&host=insight.example`,
    { headers: { host: 'insight.example', 'x-forwarded-proto': 'https', 'x-platform': 'unix' } },
  ));

  for (const [name, response] of [['main', main], ['auto', auto]] as const) {
    const generated = await response.text();
    assert.equal(response.status, 200);
    assert.match(generated, /mcts-xgovernor/);
    assert.match(generated, /MCTS_XGOVERNOR_UPSTREAM="http:\/\/127\.0\.0\.1:9876"/);
    assert.match(generated, /api\/ingest\/setup\/mcts-xgovernor/);
    assert.match(generated, /agent-insight-mcts-run --strict -- bash run_union\.sh/);
    assert.doesNotMatch(generated, /SELECTED_FRAMEWORKS="pi-agent"/);
    assert.doesNotMatch(generated, /AUTO_ADDED_FRAMEWORKS="pi-agent"/);
    const syntax = spawnSync('bash', ['-n'], { input: generated, encoding: 'utf8' });
    assert.equal(syntax.status, 0, `${name} Bash setup script must parse: ${syntax.stderr}`);
  }
});

test('MCTS installer writes an idempotent account-bound proxy configuration', async t => {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcts-xgovernor-install-'));
  t.after(() => fsp.rm(homeDir, { recursive: true, force: true }));
  const previous = {
    apiKey: process.env.AGENT_INSIGHT_API_KEY,
    baseUrl: process.env.AGENT_INSIGHT_BASE_URL,
    upstreamUrl: process.env.AGENT_INSIGHT_MCTS_UPSTREAM_URL,
    agentInsightHome: process.env.AGENT_INSIGHT_HOME,
  };
  process.env.AGENT_INSIGHT_API_KEY = 'synthetic-mcts-key';
  process.env.AGENT_INSIGHT_BASE_URL = 'https://insight.example/';
  process.env.AGENT_INSIGHT_MCTS_UPSTREAM_URL = 'http://127.0.0.1:9876';
  delete process.env.AGENT_INSIGHT_HOME;
  t.after(() => {
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore('AGENT_INSIGHT_API_KEY', previous.apiKey);
    restore('AGENT_INSIGHT_BASE_URL', previous.baseUrl);
    restore('AGENT_INSIGHT_MCTS_UPSTREAM_URL', previous.upstreamUrl);
    restore('AGENT_INSIGHT_HOME', previous.agentInsightHome);
  });

  const options = {
    homeDir,
    sourceDir: path.join(process.cwd(), 'scripts', 'agent-trace-collectors', 'mcts-xgovernor-proxy'),
    skipVersionCheck: true,
  };
  const result = await install(options);
  const config = JSON.parse(await fsp.readFile(result.configPath, 'utf8'));
  assert.equal(config.apiKey, 'synthetic-mcts-key');
  assert.equal(config.baseUrl, 'https://insight.example');
  assert.equal(config.upstreamUrl, 'http://127.0.0.1:9876');
  assert.match(await fsp.readFile(result.commandPath, 'utf8'), /managed-by-agent-insight-mcts-xgovernor-proxy/);

  const reinstalled = await install(options);
  assert.equal(reinstalled.commandPath, result.commandPath);
  assert.deepEqual(JSON.parse(await fsp.readFile(result.configPath, 'utf8')), config);
});
