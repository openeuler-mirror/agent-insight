import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import AdmZip from 'adm-zip';

import { GET as getSetup } from '@/app/api/ingest/setup/route';
import { GET as getAutoSetup } from '@/app/api/ingest/setup/auto/route';
import {
  GET as getCollectorArchive,
} from '@/app/api/ingest/setup/llamaindex-collector/route';
import { collectorArchive } from '@/app/api/ingest/setup/llamaindex-collector/archive';

const routes = [
  {
    name: 'setup',
    get: getSetup,
    url: 'http://localhost/api/ingest/setup?key=test-key',
  },
  {
    name: 'auto setup',
    get: getAutoSetup,
    url: 'http://localhost/api/setup/auto?apiKey=test-key&host=http%3A%2F%2Flocalhost%3A3000',
  },
];

test('Unix setup offers, installs, and configures the LlamaIndex collector', async () => {
  for (const route of routes) {
    const response = await route.get(new Request(route.url, {
      headers: { 'x-platform': 'unix', host: 'localhost:3000' },
    }));
    const script = await response.text();

    assert.equal(response.status, 200, route.name);
    assert.match(script, /LlamaIndex Trace Collector[^\n]+llamaindex/);
    assert.match(script, /INSTALL_LLAMAINDEX=false/);
    assert.match(script, /AGENT_INSIGHT_LLAMAINDEX_PYTHON/);
    assert.match(script, /api\/ingest\/setup\/llamaindex-collector/);
    assert.match(script, /LLAMAINDEX_SOURCE_DIR="\$LLAMAINDEX_ROOT\/current"/);
    assert.match(script, /"\$LLAMAINDEX_PYTHON" -m zipfile -e/);
    assert.match(script, /agent_insight_llamaindex\/__init__\.py/);
    assert.match(script, /llamaindex_env\.sh/);
    assert.match(script, /uninstall_llamaindex_collector\.sh/);
    assert.match(script, /otel_data\/llamaindex/);
    assert.doesNotMatch(script, /ensurepip|pip install|pip uninstall/);
    assert.match(script, /agent_insight_llamaindex\.cli configure --endpoint/);
    assert.doesNotMatch(script, /agent_insight_llamaindex\.cli configure[^\n]+--api-key/);
    assert.match(script, /if ! PYTHONPATH=.*agent_insight_llamaindex\.cli configure/);
    assert.match(script, /Unable to configure the LlamaIndex collector/);
    assert.match(script, /PYTHONPATH="\$LLAMAINDEX_SOURCE_DIR/);
    assert.match(script, /agent_insight_llamaindex\.cli run --/);

    const syntax = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
    assert.equal(syntax.status, 0, `${route.name}: ${syntax.stderr}`);
  }
});

test('Windows setup offers the same LlamaIndex installation path', async () => {
  for (const route of routes) {
    const response = await route.get(new Request(route.url, {
      headers: { 'x-platform': 'windows', host: 'localhost:3000' },
    }));
    const script = await response.text();

    assert.equal(response.status, 200, route.name);
    assert.match(script, /LlamaIndex Trace Collector[^\n]+llamaindex/);
    assert.match(script, /\$INSTALL_LLAMAINDEX = \$false/);
    assert.match(script, /AGENT_INSIGHT_LLAMAINDEX_PYTHON/);
    assert.match(script, /api\/ingest\/setup\/llamaindex-collector/);
    assert.match(script, /\.agent-insight\\collectors\\llamaindex/);
    assert.match(script, /& \$llamaIndexPython -m zipfile -e/);
    assert.match(script, /\[Guid\]::NewGuid\(\)/);
    assert.match(script, /finally \{/);
    assert.match(script, /llamaindex_env\.ps1/);
    assert.match(script, /uninstall_llamaindex_collector\.ps1/);
    assert.doesNotMatch(script, /ensurepip|pip install|pip uninstall/);
    assert.match(script, /agent_insight_llamaindex\.cli configure --endpoint/);
    assert.doesNotMatch(script, /agent_insight_llamaindex\.cli configure[^\n]+--api-key/);
    assert.match(script, /\$LASTEXITCODE -ne 0/);
    assert.match(script, /Unable to configure the LlamaIndex collector/);
    assert.match(script, /agent_insight_llamaindex\.cli run --/);
  }
});

test('install guide exposes one-click and manual LlamaIndex onboarding', () => {
  const page = readFileSync('src/app/(main)/accessconfig/install/page.tsx', 'utf8');
  assert.match(page, /LlamaIndex Trace Collector/);
  assert.match(page, /api\/ingest\/setup\/llamaindex-collector/);
  assert.match(page, /LLAMAINDEX_PYTHON.*-m zipfile -e/);
  assert.match(page, /llamaIndexPython -m zipfile -e/);
  assert.match(page, /direct deploy/);
  assert.doesNotMatch(page, /python -m pip/);
  assert.match(page, /AGENT_INSIGHT_API_KEY/);
  assert.doesNotMatch(page, /npm bundle/);
  assert.match(page, /agent_insight_llamaindex\.cli run -- .*app\.py/);
  assert.match(page, /agent_insight_llamaindex; agent_insight_llamaindex\.setup\(\)/);
  assert.match(page, /llamaindex-unix/);
  assert.match(page, /llamaindex-windows/);
  assert.match(page, /set -euo pipefail/);
  assert.match(page, /LLAMAINDEX_BACKUP/);
  assert.match(page, /trap cleanup_llamaindex_install EXIT/);
  assert.match(page, /if ! mv .*LLAMAINDEX_STAGING.*LLAMAINDEX_COLLECTOR_DIR/);
  assert.match(page, /\$ErrorActionPreference = "Stop"/);
  assert.match(page, /\[Guid\]::NewGuid\(\)/);
  assert.match(page, /\$llamaIndexBackup/);
  assert.match(page, /\} finally \{/);
  assert.match(page, /Unable to configure the LlamaIndex collector/);
  assert.match(page, /whiteSpace: 'pre-wrap'/);
  assert.match(page, /maxHeight: 320/);
});

test('agents page preserves LlamaIndex platform and does not mislabel unknown frameworks', () => {
  const page = readFileSync('src/app/(main)/agents/page.tsx', 'utf8');
  assert.match(page, /value === 'llamaindex'/);
  assert.match(page, /\{ value: 'llamaindex', label: 'llamaindex' \}/);
  assert.match(page, /return 'unknown'/);
  assert.match(page, /\{ value: 'unknown', label: '未知' \}/);
});

test('collector endpoint serves a directly deployable Python runtime archive', async () => {
  const response = await getCollectorArchive();
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.deepEqual(Array.from(bytes.slice(0, 2)), [0x50, 0x4b]);
  const entries = new AdmZip(Buffer.from(bytes)).getEntries().map((entry) => entry.entryName);
  assert.ok(entries.includes('agent_insight_llamaindex/_bootstrap/sitecustomize.py'));
  assert.ok(entries.includes('agent_insight_llamaindex/__init__.py'));
  assert.ok(entries.includes('README.md'));
  assert.ok(!entries.includes('pyproject.toml'));
  assert.ok(!entries.some((name) => name.startsWith('src/')));
  assert.ok(!entries.includes('install.py'));
  assert.ok(!entries.includes('bootstrap/sitecustomize.py'));
  assert.ok(!entries.some((name) => name.includes('__pycache__') || name.endsWith('.pyc')));
  assert.ok(!entries.includes('src/agent_insight_llamaindex/auto_instrumentation.py'));
});

test('collector archive cache invalidates when bundled source changes', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'llamaindex-archive-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'src', 'agent_insight_llamaindex');
  mkdirSync(packageRoot, { recursive: true });
  const modulePath = path.join(packageRoot, '__init__.py');
  writeFileSync(modulePath, 'VERSION = "before"\n');
  writeFileSync(path.join(root, 'README.md'), 'collector fixture\n');

  const before = collectorArchive(root, true);
  writeFileSync(modulePath, 'VERSION = "after-cache-invalidation"\n');
  const after = collectorArchive(root, true);

  assert.equal(
    new AdmZip(before).readAsText('agent_insight_llamaindex/__init__.py'),
    'VERSION = "before"\n',
  );
  assert.equal(
    new AdmZip(after).readAsText('agent_insight_llamaindex/__init__.py'),
    'VERSION = "after-cache-invalidation"\n',
  );
  assert.notDeepEqual(before, after);
});

test('local npm server package carries collector source without Python package metadata', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { files: string[] };
  assert.ok(manifest.files.includes('scripts/'));
  assert.ok(!manifest.files.includes('scripts/llamaindex_extension/tests/**'));
  assert.ok(manifest.files.includes('!scripts/llamaindex_extension/tests/**'));
  assert.ok(manifest.files.includes('!scripts/llamaindex_extension/pyproject.toml'));
  assert.ok(manifest.files.includes('!scripts/llamaindex_extension/**/__pycache__/**'));
  assert.ok(manifest.files.includes('!scripts/llamaindex_extension/**/*.pyc'));
  const prepare = readFileSync('scripts/prepare-npm-package.js', 'utf8');
  assert.match(prepare, /copyLlamaIndexCollector/);
  assert.match(prepare, /prunePythonBytecode\(targetRoot\)/);
  assert.doesNotMatch(prepare, /offer it to pip|pyproject\.toml/);
});

test('Unix uninstaller removes only LlamaIndex files and preserves trace data by default', async (t) => {
  const response = await getSetup(new Request(routes[0].url, {
    headers: { 'x-platform': 'unix', host: 'localhost:3000' },
  }));
  const setupScript = await response.text();
  const match = setupScript.match(
    /cat > "\$HOME\/\.agent-insight\/uninstall_llamaindex_collector\.sh" << 'LLAMAINDEX_UNINSTALL_EOF'\n([\s\S]*?)\nLLAMAINDEX_UNINSTALL_EOF/,
  );
  assert.ok(match, 'generated setup must contain the scoped uninstaller');

  const home = mkdtempSync(path.join(tmpdir(), 'llamaindex-uninstall-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const agentInsightHome = path.join(home, '.agent-insight');
  const collector = path.join(agentInsightHome, 'collectors', 'llamaindex', 'current');
  const spool = path.join(agentInsightHome, 'otel_data', 'llamaindex', 'account-test', 'spool');
  const otherCollector = path.join(agentInsightHome, 'opencode_uploader_client.js');
  const environment = path.join(agentInsightHome, 'llamaindex_env.sh');
  const uninstaller = path.join(agentInsightHome, 'uninstall_llamaindex_collector.sh');
  mkdirSync(collector, { recursive: true });
  mkdirSync(spool, { recursive: true });
  writeFileSync(path.join(collector, '__init__.py'), '');
  writeFileSync(path.join(agentInsightHome, 'llamaindex.json'), '{}');
  writeFileSync(environment, '');
  writeFileSync(otherCollector, 'preserve');
  writeFileSync(path.join(home, '.bashrc'), [
    'source "$HOME/.agent-insight/llamaindex_env.sh"',
    'source "$HOME/.agent-insight/claude_otel_env.sh"',
  ].join('\n'));
  writeFileSync(uninstaller, match[1], { mode: 0o700 });

  const result = spawnSync('bash', [uninstaller], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(path.join(agentInsightHome, 'collectors', 'llamaindex')));
  assert.ok(!existsSync(environment));
  assert.ok(!existsSync(uninstaller));
  assert.ok(existsSync(path.join(agentInsightHome, 'llamaindex.json')));
  assert.ok(existsSync(spool));
  assert.ok(existsSync(otherCollector));
  assert.doesNotMatch(readFileSync(path.join(home, '.bashrc'), 'utf8'), /llamaindex_env/);
  assert.match(readFileSync(path.join(home, '.bashrc'), 'utf8'), /claude_otel_env/);
});
