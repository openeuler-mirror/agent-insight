import assert from 'node:assert/strict';
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

const ENTRIES = [
  'goal-plus/goal-plus-collector.cjs',
  'goal-plus/install.cjs',
  'goal-plus/lib/gp-snapshot-parser.cjs',
  'goal-plus/lib/pi-native-parser.cjs',
  'goal-plus/lib/semantic-spool.cjs',
  'goal-plus/lib/source-registry.cjs',
  'goal-plus/uninstall.cjs',
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

test('unified setup preselects Goal Plus and delegates to its authenticated installer', async () => {
  const responses = [
    await getSetup(new Request('https://insight.example/api/ingest/setup?frameworks=goal-plus&key=synthetic&nokey=1', {
      headers: { host: 'insight.example', 'x-forwarded-proto': 'https', 'x-platform': 'unix' },
    })),
    await getAutoSetup(new Request('https://insight.example/api/setup/auto?frameworks=goal-plus&apiKey=synthetic&host=insight.example', {
      headers: { host: 'insight.example', 'x-forwarded-proto': 'https', 'x-platform': 'unix' },
    })),
  ];
  for (const response of responses) {
    const source = await response.text();
    assert.equal(response.status, 200);
    assert.match(source, /SELECTED_FRAMEWORKS="goal-plus"/);
    assert.match(source, /api\/ingest\/setup\/goal-plus/);
    assert.match(source, /Installing Goal Plus collector/);
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
  assert.equal(JSON.parse(await fsp.readFile(result.configPath, 'utf8')).apiKey, 'synthetic-install-key');
  assert.match(await fsp.readFile(result.commandPath, 'utf8'), /managed-by-agent-insight-goal-plus/);
});
