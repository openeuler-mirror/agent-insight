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
    assert.match(script, /LlamaIndex[^\n]+llamaindex/);
    assert.match(script, /INSTALL_LLAMAINDEX=false/);
    assert.match(script, /AGENT_INSIGHT_LLAMAINDEX_PYTHON/);
    assert.match(script, /AGENT_INSIGHT_LLAMAINDEX_VENV/);
    assert.match(script, /LLAMAINDEX_VENV\/bin\/python/);
    assert.match(script, /export AGENT_INSIGHT_LLAMAINDEX_PYTHON=%q/);
    assert.match(script, /api\/ingest\/setup\/llamaindex-collector/);
    assert.match(script, /LLAMAINDEX_SOURCE_DIR="\$LLAMAINDEX_ROOT\/current"/);
    assert.match(script, /"\$LLAMAINDEX_PYTHON" -m zipfile -e/);
    assert.match(script, /pip install --disable-pip-version-check "llama-index-observability-otel==0\.6\.4"/);
    assert.match(script, /agent_insight_llamaindex\/__init__\.py/);
    assert.match(script, /llamaindex_env\.sh/);
    assert.match(script, /uninstall_llamaindex_collector\.sh/);
    assert.match(script, /otel_data\/llamaindex/);
    assert.doesNotMatch(script, /ensurepip|pip uninstall/);
    assert.match(script, /agent_insight_llamaindex\.cli configure --endpoint/);
    assert.doesNotMatch(script, /agent_insight_llamaindex\.cli configure[^\n]+--api-key/);
    assert.match(script, /if ! PYTHONPATH=.*agent_insight_llamaindex\.cli configure/);
    assert.match(script, /Unable to configure the LlamaIndex collector/);
    assert.match(script, /PYTHONPATH="\$LLAMAINDEX_SOURCE_DIR/);
    assert.match(script, /agent_insight_llamaindex\.cli run --/);
    assert.match(script, /deployment will continue/);

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
    assert.match(script, /LlamaIndex[^\n]+llamaindex/);
    assert.match(script, /\$INSTALL_LLAMAINDEX = \$false/);
    assert.match(script, /AGENT_INSIGHT_LLAMAINDEX_PYTHON/);
    assert.match(script, /AGENT_INSIGHT_LLAMAINDEX_VENV/);
    assert.match(script, /Scripts\\python\.exe/);
    assert.match(script, /llamaIndexEnvScript.*AGENT_INSIGHT_LLAMAINDEX_PYTHON/);
    assert.match(script, /api\/ingest\/setup\/llamaindex-collector/);
    assert.match(script, /pip install --disable-pip-version-check "llama-index-observability-otel==0\.6\.4"/);
    assert.match(script, /\.agent-insight\\collectors\\llamaindex/);
    assert.match(script, /& \$llamaIndexPython -m zipfile -e/);
    assert.match(script, /\[Guid\]::NewGuid\(\)/);
    assert.match(script, /finally \{/);
    assert.match(script, /llamaindex_env\.ps1/);
    assert.match(script, /uninstall_llamaindex_collector\.ps1/);
    assert.doesNotMatch(script, /ensurepip|pip uninstall/);
    assert.match(script, /agent_insight_llamaindex\.cli configure --endpoint/);
    assert.doesNotMatch(script, /agent_insight_llamaindex\.cli configure[^\n]+--api-key/);
    assert.match(script, /\$LASTEXITCODE -ne 0/);
    assert.match(script, /Unable to configure the LlamaIndex collector/);
    assert.match(script, /agent_insight_llamaindex\.cli run --/);
    assert.match(script, /deployment will continue/);
    assert.match(script, /import llama_index\.core" 2>\$null/);
  }
});

test('install guide exposes LlamaIndex through the shared one-line installer', () => {
  const page = readFileSync('src/app/(main)/accessconfig/install/page.tsx', 'utf8');
  assert.match(page, /value: 'llamaindex', label: 'LlamaIndex'/);
  assert.match(page, /value: 'llamaindex'/);
  assert.match(page, /getApiUrl\('\/api\/ingest\/setup'\)/);
  assert.match(page, /frameworks=\$\{frameworks\.join\(','\)\}/);
  assert.match(page, /frameworks\.includes\('llamaindex'\) \? 'llamaindexPromptPython=1' : ''/);
  assert.doesNotMatch(page, /llamaindexVenv=/);
  assert.doesNotMatch(page, /llamaindexPython=/);
  assert.doesNotMatch(page, /LlamaIndex Python environment/);
  assert.match(page, /curl -sSf/);
  assert.match(page, /\| bash/);
  assert.match(page, /irm/);
  assert.match(page, /\| iex/);
  assert.doesNotMatch(page, /api\/ingest\/setup\/llamaindex-collector/);
  assert.doesNotMatch(page, /zipfile -e/);
  assert.doesNotMatch(page, /python -m pip/);
  assert.doesNotMatch(page, /npm bundle/);
  assert.match(page, /agent_insight_llamaindex; agent_insight_llamaindex\.setup\(\)/);
  assert.doesNotMatch(page, /llamaindex-unix/);
  assert.doesNotMatch(page, /llamaindex-windows/);
  assert.match(page, /whiteSpace: 'pre-wrap'/);
  assert.match(page, /maxHeight: 320/);
});

test('interactive setup chooses the LlamaIndex Python environment after the script starts', async () => {
  const unixResponse = await getSetup(new Request(
    'http://localhost/api/ingest/setup?key=test-key&frameworks=llamaindex',
    { headers: { 'x-platform': 'unix', host: 'localhost:3000' } },
  ));
  const unixScript = await unixResponse.text();
  assert.match(unixScript, /Use a virtual environment for LlamaIndex/);
  assert.match(unixScript, /Virtual environment root/);
  assert.match(unixScript, /default: global Python/);
  assert.match(unixScript, /< \/dev\/tty/);
  assert.equal(spawnSync('bash', ['-n'], { input: unixScript, encoding: 'utf8' }).status, 0);

  const windowsResponse = await getSetup(new Request(
    'http://localhost/api/ingest/setup?key=test-key&frameworks=llamaindex',
    { headers: { 'x-platform': 'windows', host: 'localhost:3000' } },
  ));
  const windowsScript = await windowsResponse.text();
  assert.match(windowsScript, /Read-Host "👉 Use a virtual environment for LlamaIndex/);
  assert.match(windowsScript, /\[Console\]::IsInputRedirected/);

  const autoResponse = await getAutoSetup(new Request(
    'http://localhost/api/setup/auto?apiKey=test-key&host=http%3A%2F%2Flocalhost%3A3000',
    { headers: { 'x-platform': 'unix', host: 'localhost:3000' } },
  ));
  const autoScript = await autoResponse.text();
  assert.doesNotMatch(autoScript, /Use a virtual environment for LlamaIndex/);
  assert.match(autoScript, /LLAMAINDEX_CONFIGURED_MODE="auto"/);
});

test('install-guide command stays non-interactive except for LlamaIndex Python selection', async () => {
  const query = 'key=test-key&yes=1&frameworks=llamaindex&llamaindexPromptPython=1';

  const unixResponse = await getSetup(new Request(
    `http://localhost/api/ingest/setup?${query}`,
    { headers: { 'x-platform': 'unix', host: 'localhost:3000' } },
  ));
  const unixScript = await unixResponse.text();
  assert.match(unixScript, /^NONINTERACTIVE=true$/m);
  assert.match(unixScript, /^PROMPT_LLAMAINDEX_PYTHON=true$/m);
  assert.match(unixScript, /\[ "\$NONINTERACTIVE" != "true" \] \|\| \[ "\$PROMPT_LLAMAINDEX_PYTHON" = "true" \]/);
  assert.match(unixScript, /Use a virtual environment for LlamaIndex/);
  assert.equal(spawnSync('bash', ['-n'], { input: unixScript, encoding: 'utf8' }).status, 0);

  const windowsResponse = await getSetup(new Request(
    `http://localhost/api/ingest/setup?${query}`,
    { headers: { 'x-platform': 'windows', host: 'localhost:3000' } },
  ));
  const windowsScript = await windowsResponse.text();
  assert.match(windowsScript, /^\$NONINTERACTIVE = \$true$/m);
  assert.match(windowsScript, /^\$PROMPT_LLAMAINDEX_PYTHON = \$true$/m);
  assert.match(windowsScript, /\(\(-not \$NONINTERACTIVE\) -or \$PROMPT_LLAMAINDEX_PYTHON\)/);
  assert.match(windowsScript, /Read-Host "👉 Use a virtual environment for LlamaIndex/);
});

test('setup embeds an optional LlamaIndex virtual environment and otherwise keeps global Python', async () => {
  const unixVenv = '/opt/demo env/.venv';
  const unixResponse = await getSetup(new Request(
    `http://localhost/api/ingest/setup?key=test-key&frameworks=llamaindex&llamaindexPython=venv&llamaindexVenv=${encodeURIComponent(unixVenv)}`,
    { headers: { 'x-platform': 'unix', host: 'localhost:3000' } },
  ));
  const unixScript = await unixResponse.text();
  assert.match(unixScript, /LLAMAINDEX_CONFIGURED_VENV="\/opt\/demo env\/\.venv"/);
  assert.match(unixScript, /LLAMAINDEX_CONFIGURED_MODE="venv"/);
  assert.match(unixScript, /LLAMAINDEX_PYTHON_MODE="virtual environment"/);
  assert.match(unixScript, /LLAMAINDEX_PYTHON_MODE="global PATH"/);
  assert.match(unixScript, /printf 'export AGENT_INSIGHT_LLAMAINDEX_VENV=%q/);
  assert.equal(spawnSync('bash', ['-n'], { input: unixScript, encoding: 'utf8' }).status, 0);

  const windowsVenv = String.raw`C:\work tree\.venv`;
  const windowsResponse = await getSetup(new Request(
    `http://localhost/api/ingest/setup?key=test-key&frameworks=llamaindex&llamaindexPython=venv&llamaindexVenv=${encodeURIComponent(windowsVenv)}`,
    { headers: { 'x-platform': 'windows', host: 'localhost:3000' } },
  ));
  const windowsScript = await windowsResponse.text();
  assert.match(windowsScript, /\$llamaIndexConfiguredVenv = "C:\\work tree\\\.venv"/);
  assert.match(windowsScript, /\$llamaIndexConfiguredMode = "venv"/);
  assert.match(windowsScript, /Join-Path \$llamaIndexVenv "Scripts\\python\.exe"/);
  assert.match(windowsScript, /AGENT_INSIGHT_LLAMAINDEX_VENV =/);

  const autoResponse = await getAutoSetup(new Request(
    `http://localhost/api/setup/auto?apiKey=test-key&host=http%3A%2F%2Flocalhost%3A3000&llamaindexPython=venv&llamaindexVenv=${encodeURIComponent(unixVenv)}`,
    { headers: { 'x-platform': 'unix', host: 'localhost:3000' } },
  ));
  const autoScript = await autoResponse.text();
  assert.match(autoScript, /LLAMAINDEX_CONFIGURED_VENV="\/opt\/demo env\/\.venv"/);
  assert.match(autoScript, /LLAMAINDEX_CONFIGURED_MODE="venv"/);
  assert.equal(spawnSync('bash', ['-n'], { input: autoScript, encoding: 'utf8' }).status, 0);

  const globalResponse = await getSetup(new Request(
    'http://localhost/api/ingest/setup?key=test-key&frameworks=llamaindex&llamaindexPython=global',
    { headers: { 'x-platform': 'windows', host: 'localhost:3000' } },
  ));
  const globalScript = await globalResponse.text();
  assert.match(globalScript, /\$llamaIndexConfiguredMode = "global"/);
  assert.match(globalScript, /Remove-Item Env:AGENT_INSIGHT_LLAMAINDEX_VENV/);
});

test('one-line setup preselects LlamaIndex without falling back to the interactive picker', async () => {
  for (const platform of ['unix', 'windows']) {
    const response = await getSetup(new Request(
      'http://localhost/api/ingest/setup?key=test-key&frameworks=llamaindex',
      { headers: { 'x-platform': platform, host: 'localhost:3000' } },
    ));
    const script = await response.text();

    assert.equal(response.status, 200, platform);
    assert.match(script, /SELECTED_FRAMEWORKS(?:=| = )"llamaindex"/);
    assert.match(script, platform === 'windows'
      ? /\$INSTALL_LLAMAINDEX = \$true/
      : /INSTALL_LLAMAINDEX=true/);
    assert.match(script, /LlamaIndex-only setup: Node\.js check skipped/);
    assert.doesNotMatch(script, /Agent-insight requires Node\.js 20 or higher/);
    if (platform === 'unix') {
      assert.match(script, /CAN_PROMPT=false/);
      assert.match(script, /Non-interactive shell: using the new Host/);
      const syntax = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
      assert.equal(syntax.status, 0, syntax.stderr);
    }
  }
});

test('mixed one-line setup retains the Node.js requirement for command-line agents', async () => {
  const response = await getSetup(new Request(
    'http://localhost/api/ingest/setup?key=test-key&frameworks=opencode,llamaindex',
    { headers: { 'x-platform': 'unix', host: 'localhost:3000' } },
  ));
  const script = await response.text();

  assert.equal(response.status, 200);
  assert.match(script, /SELECTED_FRAMEWORKS="opencode,llamaindex"/);
  assert.match(script, /Agent-insight requires Node\.js 20 or higher/);
});

test('OpenCode watcher management is scoped to the installing account', async () => {
  for (const platform of ['unix', 'windows']) {
    const response = await getSetup(new Request(
      'http://localhost/api/ingest/setup?key=test-key&frameworks=opencode,openclaw,llamaindex',
      { headers: { 'x-platform': platform, host: 'localhost:3000' } },
    ));
    const script = await response.text();

    assert.equal(response.status, 200, platform);
    assert.match(script, /opencode_uploader\.pid/);
    assert.match(script, /opencode_uploader_client\.js/);
    if (platform === 'unix') {
      assert.match(script, /ps -o args= -p "\$OLD_PID"/);
      assert.doesNotMatch(script, /pkill -f "(?:skill-insight-opencode-uploader-loop|opencode_uploader_client\.js)"/);
      const syntax = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
      assert.equal(syntax.status, 0, syntax.stderr);
    } else {
      assert.match(script, /Get-CimInstance Win32_Process -Filter "ProcessId = \$oldUploaderPid"/);
      assert.doesNotMatch(script, /Get-Process \| Where-Object \{ \$_\.CommandLine -like "\*(?:skill-insight-opencode-uploader-loop|opencode_uploader_client\.js)\*"/);
    }
  }
});

test('agents page preserves LlamaIndex platform and does not mislabel unknown frameworks', () => {
  const page = readFileSync('src/app/(main)/agents/page.tsx', 'utf8');
  const platforms = readFileSync('src/lib/engine/observability/agent-platform.ts', 'utf8');
  assert.match(page, /normalizeAgentPlatform\(a\.platform\)/);
  assert.match(page, /AGENT_PLATFORMS\.map/);
  assert.match(platforms, /'llamaindex'/);
  assert.match(platforms, /: 'unknown'/);
});

test('collector endpoint serves a directly deployable Python runtime archive', async () => {
  const response = await getCollectorArchive();
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.deepEqual(Array.from(bytes.slice(0, 2)), [0x50, 0x4b]);
  const archive = new AdmZip(Buffer.from(bytes));
  const entries = archive.getEntries().map((entry) => entry.entryName);
  assert.ok(entries.includes('agent_insight_llamaindex/_bootstrap/sitecustomize.py'));
  assert.ok(entries.includes('agent_insight_llamaindex/__init__.py'));
  assert.ok(entries.includes('README.md'));
  assert.match(archive.readAsText('README.md'), /# LlamaIndex Trace Collector/);
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
  assert.ok(manifest.files.includes('docs/user-guide/observability/llamaindex-trace-collector.md'));
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

test('Unix uninstaller removes only LlamaIndex files and preserves trace data by default', {
  skip: process.platform === 'win32'
    ? 'the Unix script is executed by native Bash jobs; Windows exercises the PowerShell uninstaller'
    : false,
}, async (t) => {
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

test('Windows uninstaller removes only LlamaIndex files and preserves trace data by default', {
  skip: process.platform !== 'win32'
    ? 'the PowerShell uninstaller is executed by Windows jobs'
    : false,
}, async (t) => {
  const response = await getSetup(new Request(routes[0].url, {
    headers: { 'x-platform': 'windows', host: 'localhost:3000' },
  }));
  const setupScript = await response.text();
  const match = setupScript.match(
    /\$llamaIndexUninstallScript = @'\n([\s\S]*?)\n'@/,
  );
  assert.ok(match, 'generated setup must contain the scoped PowerShell uninstaller');

  const home = mkdtempSync(path.join(tmpdir(), 'llamaindex-uninstall-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const agentInsightHome = path.join(home, '.agent-insight');
  const collector = path.join(agentInsightHome, 'collectors', 'llamaindex', 'current');
  const spool = path.join(agentInsightHome, 'otel_data', 'llamaindex', 'account-test', 'spool');
  const otherCollector = path.join(agentInsightHome, 'opencode_uploader_client.js');
  const environment = path.join(agentInsightHome, 'llamaindex_env.ps1');
  const uninstaller = path.join(agentInsightHome, 'uninstall_llamaindex_collector.ps1');
  const profile = path.join(home, 'Microsoft.PowerShell_profile.ps1');
  mkdirSync(collector, { recursive: true });
  mkdirSync(spool, { recursive: true });
  writeFileSync(path.join(collector, '__init__.py'), '');
  writeFileSync(path.join(agentInsightHome, 'llamaindex.json'), '{}');
  writeFileSync(environment, '');
  writeFileSync(otherCollector, 'preserve');
  writeFileSync(profile, [
    '. "$HOME/.agent-insight/llamaindex_env.ps1"',
    '. "$HOME/.agent-insight/openclaw_otel_env.ps1"',
  ].join('\n'));
  writeFileSync(uninstaller, match[1]);

  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    'Set-Variable -Name HOME -Value $env:TEST_HOME -Force; '
      + 'Set-Variable -Name PROFILE -Value $env:TEST_PROFILE; '
      + '& $env:TEST_UNINSTALLER',
  ], {
    env: {
      ...process.env,
      TEST_HOME: home,
      TEST_PROFILE: profile,
      TEST_UNINSTALLER: uninstaller,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.ok(!existsSync(path.join(agentInsightHome, 'collectors', 'llamaindex')));
  assert.ok(!existsSync(environment));
  assert.ok(!existsSync(uninstaller));
  assert.ok(existsSync(path.join(agentInsightHome, 'llamaindex.json')));
  assert.ok(existsSync(spool));
  assert.ok(existsSync(otherCollector));
  assert.doesNotMatch(readFileSync(profile, 'utf8'), /llamaindex_env/);
  assert.match(readFileSync(profile, 'utf8'), /openclaw_otel_env/);
});
