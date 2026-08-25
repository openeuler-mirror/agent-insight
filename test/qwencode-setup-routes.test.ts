import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { GET as setupGet } from '../src/app/api/ingest/setup/route';
import { GET as autoSetupGet } from '../src/app/api/ingest/setup/auto/route';
import { GET as collectorGet } from '../src/app/api/ingest/setup/qwencode-collector/[file]/route';

function runNode(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('the setup route uses direct local HTTP only for Qwen while preserving shared defaults', async () => {
  for (const platform of ['unix', 'windows']) {
    const response = await setupGet(new Request('http://localhost:3000/api/ingest/setup?frameworks=qwencode', {
      headers: { host: 'localhost:3000', 'x-platform': platform },
    }));
    const script = await response.text();
    assert.match(script, /AGENT_INSIGHT_HOST\s*=\s*"https:\/\/localhost:3000"/);
    assert.match(script, /AGENT_INSIGHT_BASE_URL\s*=\s*"https:\/\/localhost:3000"/);
    assert.match(script, /QWENCODE_BASE_URL\s*=\s*"http:\/\/localhost:3000"/);
  }
});

test('the shared setup route preserves the HTTPS default for external collectors without proxy headers', async () => {
  for (const platform of ['unix', 'windows']) {
    const response = await setupGet(new Request('http://internal:3000/api/ingest/setup?frameworks=hermes', {
      headers: { host: 'collector.example', 'x-platform': platform },
    }));
    const script = await response.text();
    assert.match(script, /AGENT_INSIGHT_HOST\s*=\s*"https:\/\/collector\.example"/);
    assert.match(script, /AGENT_INSIGHT_BASE_URL\s*=\s*"https:\/\/collector\.example"/);
    assert.doesNotMatch(script, /AGENT_INSIGHT_HOST\s*=\s*"http:\/\/collector\.example"/);
  }
});

test('the curl setup script accepts Qwen Code as a preselected framework and installs it', async () => {
  const response = await setupGet(new Request('http://localhost:3000/api/ingest/setup?frameworks=qwencode', {
    headers: { 'x-platform': 'windows' },
  }));
  const script = await response.text();

  assert.match(script, /\$SELECTED_FRAMEWORKS = "qwencode"/);
  assert.match(script, /将安装以下组件: Qwen Code/);
  assert.match(script, /\{ name: 'OpenCode', value: 'opencode' \}/);
  assert.match(script, /\{ name: 'Claude Code', value: 'claude' \}/);
  assert.match(script, /\{ name: 'Hermes', value: 'hermes' \}/);
  assert.match(script, /\{ name: 'JiuwenSwarm', value: 'jiuwen' \}/);
  assert.match(script, /\{ name: 'Qwen Code', value: 'qwencode' \}/);
  assert.match(script, /INSTALL_QWENCODE/);
  assert.match(script, /qwencode-collector-source/);
  assert.match(script, /Join-Path \$qwenCollectorSource "install\.mjs"/);
  assert.match(script, /@\("configure\.mjs", "install\.mjs"\)/);
  assert.match(script, /native OTLP telemetry configured/);
});

test('the Unix setup script configures Qwen native telemetry after credentials exist', async () => {
  const response = await setupGet(new Request('https://collector.example/api/ingest/setup?frameworks=qwencode&key=test-key&nokey=1', {
    headers: {
      host: 'collector.example:4318',
      'x-forwarded-proto': 'https',
      'x-platform': 'unix',
    },
  }));
  const script = await response.text();

  assert.match(script, /AGENT_INSIGHT_HOST="https:\/\/collector\.example:4318"/);
  assert.match(script, /QWENCODE_BASE_URL="https:\/\/collector\.example:4318"/);
  assert.match(script, /for file in configure\.mjs install\.mjs; do/);
  assert.match(script, /node "\$QWENCODE_COLLECTOR_DIR\/install\.mjs"/);
  assert.match(script, /Qwen Code native OTLP telemetry configured/);
});

test('the direct Qwen collector install derives telemetry configuration from Agent Insight settings', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'qwencode-direct-install-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.agent-insight'), { recursive: true });
  await mkdir(join(home, '.qwen'), { recursive: true });
  await writeFile(join(home, '.agent-insight', '.env'), [
    'AGENT_INSIGHT_HOST=localhost:3000',
    'AGENT_INSIGHT_API_KEY=direct-install-key',
  ].join('\n'), 'utf8');
  await writeFile(join(home, '.qwen', '.env'), [
    'QWEN_MODEL=qwen3-coder',
    'QWEN_TELEMETRY_ENABLED=false',
    'QWEN_TELEMETRY_OTLP_TRACES_ENDPOINT=http://stale.example/api/ingest/otel/v1/traces',
    'OTEL_EXPORTER_OTLP_HEADERS=x-witty-api-key=stale-key',
  ].join('\n'), 'utf8');

  const result = await runNode([join(process.cwd(), 'scripts', 'qwencode-collector', 'install.mjs')], {
    HOME: home,
    USERPROFILE: home,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /direct-install-key/);

  const qwenEnvironment = await readFile(join(home, '.qwen', '.env'), 'utf8');
  assert.match(qwenEnvironment, /^QWEN_MODEL=qwen3-coder$/m);
  assert.match(qwenEnvironment, /^QWEN_TELEMETRY_ENABLED=true$/m);
  assert.match(qwenEnvironment, /^QWEN_TELEMETRY_OTLP_PROTOCOL=http$/m);
  assert.match(qwenEnvironment, /^QWEN_TELEMETRY_OTLP_TRACES_ENDPOINT=http:\/\/localhost:3000\/api\/ingest\/otel\/v1\/traces$/m);
  assert.match(qwenEnvironment, /^QWEN_TELEMETRY_OTLP_LOGS_ENDPOINT=http:\/\/localhost:3000\/api\/ingest\/otel\/v1\/logs$/m);
  assert.match(qwenEnvironment, /^QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES=true$/m);
  assert.match(qwenEnvironment, /^OTEL_EXPORTER_OTLP_HEADERS=x-witty-api-key=direct-install-key$/m);
  assert.match(qwenEnvironment, /^OTEL_SERVICE_NAME=qwencode$/m);
  assert.doesNotMatch(qwenEnvironment, /stale\.example|stale-key/);
});

test('the Qwen collector uninstall removes only its managed environment values', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'qwencode-uninstall-env-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.qwen'), { recursive: true });
  await writeFile(join(home, '.qwen', '.env'), [
    'QWEN_MODEL=qwen3-coder',
    'QWEN_TELEMETRY_ENABLED=true',
    'QWEN_TELEMETRY_OTLP_PROTOCOL=http',
    'QWEN_TELEMETRY_OTLP_TRACES_ENDPOINT=http://collector.example/api/ingest/otel/v1/traces',
    'QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES=true',
    'OTEL_EXPORTER_OTLP_HEADERS=x-witty-api-key=secret-to-remove',
    'OTEL_SERVICE_NAME=qwencode',
  ].join('\n'), 'utf8');

  const result = await runNode([join(process.cwd(), 'scripts', 'qwencode-collector', 'uninstall.mjs')], {
    HOME: home,
    USERPROFILE: home,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /secret-to-remove/);

  const qwenEnvironment = await readFile(join(home, '.qwen', '.env'), 'utf8');
  assert.match(qwenEnvironment, /^QWEN_MODEL=qwen3-coder$/m);
  assert.doesNotMatch(qwenEnvironment, /QWEN_TELEMETRY_|OTEL_EXPORTER_OTLP_HEADERS|OTEL_SERVICE_NAME|secret-to-remove/);
});

test('the local npm auto-setup script installs Qwen Code from its package files', async () => {
  const response = await autoSetupGet(new Request(
    'http://localhost:3000/api/ingest/setup/auto?apiKey=test-key&host=localhost:3000',
    { headers: { 'x-platform': 'windows' } },
  ));
  const script = await response.text();

  assert.match(script, /\{ name: 'OpenClaw', value: 'openclaw' \}/);
  assert.match(script, /\{ name: 'Qwen Code', value: 'qwencode' \}/);
  assert.match(script, /INSTALL_QWENCODE/);
  assert.match(script, /require\.resolve\('agent-insight\/package\.json'\)/);
  assert.match(script, /scripts\\qwencode-collector\\install\.mjs/);
  assert.match(script, /scripts\\qwencode-collector\\install\.mjs/);
  assert.match(script, /Qwen Code native OTLP telemetry configured/);
});

test('the Unix auto-setup script configures Qwen native telemetry', async () => {
  const response = await autoSetupGet(new Request(
    'https://collector.example/api/ingest/setup/auto?apiKey=test-key&host=collector.example:4318',
    { headers: { 'x-platform': 'unix' } },
  ));
  const script = await response.text();

  assert.match(script, /node "\$QWENCODE_PACKAGE_ROOT\/scripts\/qwencode-collector\/install\.mjs"/);
  assert.match(script, /Qwen Code native OTLP telemetry configured/);
});

test('the collector download route serves only allow-listed collector modules', async () => {
  const allowed = await collectorGet(new Request('http://localhost:3000/api/ingest/setup/qwencode-collector/configure.mjs'), {
    params: Promise.resolve({ file: 'configure.mjs' }),
  });
  assert.equal(allowed.status, 200);
  assert.match(await allowed.text(), /QWEN_TELEMETRY_ENABLED/);

  const legacy = await collectorGet(new Request('http://localhost:3000/api/ingest/setup/qwencode-collector/index.mjs'), {
    params: Promise.resolve({ file: 'index.mjs' }),
  });
  assert.equal(legacy.status, 404);

  const denied = await collectorGet(new Request('http://localhost:3000/api/ingest/setup/qwencode-collector/package.json'), {
    params: Promise.resolve({ file: 'package.json' }),
  });
  assert.equal(denied.status, 404);
});
