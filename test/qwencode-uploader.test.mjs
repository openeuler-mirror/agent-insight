import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';

const collectorDir = join(process.cwd(), 'scripts', 'qwencode-collector');
const uploaderUrl = pathToFileURL(join(collectorDir, 'uploader.mjs')).href;
const collectorScript = join(collectorDir, 'index.mjs');
const testScope = `key-${createHash('sha256').update('test-key').digest('hex').slice(0, 16)}`;

function runNode(args, { env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function createTestHome(endpoint) {
  const home = await mkdtemp(join(tmpdir(), 'qwencode-uploader-'));
  await mkdir(join(home, '.qwen'), { recursive: true });
  await writeFile(
    join(home, '.qwen', '.env'),
    `AGENT_INSIGHT_API_KEY=test-key\nAGENT_INSIGHT_OTLP_ENDPOINT=${endpoint}\n`,
    'utf8',
  );
  return home;
}

function homeEnvironment(home) {
  return {
    USERPROFILE: home,
    HOME: home,
    AGENT_INSIGHT_API_KEY: 'test-key',
  };
}

async function startOtlpServer(handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, headers: request.headers, body });
    handler(requests.length, request, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    requests,
    endpoint: `http://127.0.0.1:${address.port}/api/ingest/otel/v1/traces`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function writeAgentSpoolRecord(home, sessionId) {
  const spoolDir = join(home, '.agent-insight', 'otel_data', 'qwencode', testScope, 'spool', sessionId);
  await mkdir(spoolDir, { recursive: true });
  await writeFile(join(spoolDir, 'record.json'), JSON.stringify({
    version: 1,
    traceType: 'agent',
    traceId: '1'.repeat(32),
    spanId: '2'.repeat(16),
    parentSpanId: null,
    sessionId,
    name: 'agent.qwen-code',
    model: 'test-model',
    query: 'test',
    result: 'ok',
    startTimeMs: Date.now() - 10,
    endTimeMs: Date.now(),
    status: 'ok',
  }));
  return spoolDir;
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test('QwenCode uploader retries with backoff, archives success, and does not upload twice', async (t) => {
  const otlp = await startOtlpServer((attempt, _request, response) => {
    response.statusCode = attempt === 1 ? 503 : 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: attempt > 1 }));
  });
  t.after(otlp.close);
  const home = await createTestHome(otlp.endpoint);
  t.after(() => rm(home, { recursive: true, force: true }));

  const sessionId = 'retry-session';
  const scope = testScope;
  const spoolDir = join(home, '.agent-insight', 'otel_data', 'qwencode', scope, 'spool', sessionId);
  await mkdir(spoolDir, { recursive: true });
  await writeFile(join(spoolDir, 'record.json'), JSON.stringify({
    version: 1,
    traceType: 'agent',
    traceId: '1'.repeat(32),
    spanId: '2'.repeat(16),
    parentSpanId: null,
    sessionId,
    name: 'agent.qwen-code',
    model: 'test-model',
    query: 'test',
    result: 'ok',
    startTimeMs: Date.now() - 10,
    endTimeMs: Date.now(),
    status: 'ok',
  }));

  const script = `
    const { flushSessionSpool } = await import(${JSON.stringify(uploaderUrl)});
    const first = await flushSessionSpool(${JSON.stringify(sessionId)}, { attempts: 3, baseDelayMs: 50 });
    const second = await flushSessionSpool(${JSON.stringify(sessionId)}, { attempts: 3, baseDelayMs: 50 });
    process.stdout.write(JSON.stringify({ first, second }));
  `;
  const result = await runNode(['--input-type=module', '-e', script], {
    env: homeEnvironment(home),
  });
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.first.uploaded, 1);
  assert.equal(output.first.attempts, 2);
  assert.equal(output.second.uploaded, 0);
  assert.equal(output.second.skipped, true);
  assert.equal(otlp.requests.length, 2);
  assert.equal(otlp.requests[1].headers['x-witty-api-key'], 'test-key');

  assert.deepEqual(await readdir(spoolDir), []);
  const uploaded = await readdir(join(home, '.agent-insight', 'otel_data', 'qwencode', scope, 'uploaded', sessionId));
  assert.deepEqual(uploaded, ['record.json']);
  const body = JSON.parse(otlp.requests[1].body);
  assert.equal(body.resourceSpans[0].scopeSpans[0].spans.length, 1);
});

test('QwenCode flush records a sanitized failure when uploads remain pending', async (t) => {
  const otlp = await startOtlpServer((_attempt, _request, response) => {
    response.statusCode = 401;
    response.end('invalid key: server-side-secret');
  });
  t.after(otlp.close);
  const home = await createTestHome(otlp.endpoint);
  t.after(() => rm(home, { recursive: true, force: true }));

  const sessionId = 'failed-session';
  await writeAgentSpoolRecord(home, sessionId);
  const result = await runNode([join(collectorDir, 'flush.mjs')], { env: homeEnvironment(home) });
  assert.equal(result.code, 0, result.stderr);

  const failurePath = join(home, '.agent-insight', 'otel_data', 'qwencode', testScope, 'logs', 'last-upload-failures.json');
  const failure = JSON.parse(await readFile(failurePath, 'utf8'));
  assert.deepEqual(failure.failures, [{ sessionId, error: 'OTLP upload failed with HTTP 401' }]);
  assert.doesNotMatch(JSON.stringify(failure), /server-side-secret|test-key/);
});

test('QwenCode upload watcher refreshes its lock heartbeat while it is active', async (t) => {
  const otlp = await startOtlpServer((_attempt, _request, response) => {
    response.statusCode = 503;
    response.end('retry');
  });
  t.after(otlp.close);
  const home = await createTestHome(otlp.endpoint);
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeAgentSpoolRecord(home, 'watcher-heartbeat');

  const child = spawn(process.execPath, [join(collectorDir, 'flush.mjs'), '--watch'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...homeEnvironment(home),
      AGENT_INSIGHT_QWEN_UPLOAD_INTERVAL_MS: '1000',
      AGENT_INSIGHT_QWEN_UPLOADER_IDLE_EXIT_MS: '1000',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => child.once('close', resolve));

  try {
    const lockPath = join(home, '.agent-insight', 'otel_data', 'qwencode', testScope, 'locks', 'watcher.lock');
    const acquired = await waitFor(async () => {
      try {
        await stat(lockPath);
        return true;
      } catch {
        return false;
      }
    });
    assert.equal(acquired, true, `watcher did not acquire its lock: ${stderr}`);

    const initialMtime = (await stat(lockPath)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    const refreshedMtime = (await stat(lockPath)).mtimeMs;
    assert.ok(refreshedMtime > initialMtime, 'watcher lock mtime was not refreshed');
    assert.ok(Date.now() - refreshedMtime < 1_500, 'watcher lock heartbeat became stale');
  } finally {
    if (child.exitCode === null) child.kill();
    await closed;
  }
});

test('QwenCode SessionEnd triggers an immediate asynchronous spool upload', async (t) => {
  const otlp = await startOtlpServer((_attempt, _request, response) => {
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end('{"ok":true}');
  });
  t.after(otlp.close);
  const home = await createTestHome(otlp.endpoint);
  t.after(() => rm(home, { recursive: true, force: true }));
  const sessionId = 'session-end-upload';

  const event = JSON.stringify({
    session_id: sessionId,
    hook_event_name: 'SessionEnd',
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
    reason: 'test',
  });
  const result = await runNode([collectorScript], {
    env: homeEnvironment(home),
    input: event,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { continue: true, suppressOutput: true });

  const scope = testScope;
  const uploadedDir = join(home, '.agent-insight', 'otel_data', 'qwencode', scope, 'uploaded', sessionId);
  const uploaded = await waitFor(async () => {
    try {
      return (await readdir(uploadedDir)).length >= 2;
    } catch {
      return false;
    }
  });
  assert.equal(uploaded, true, 'SessionEnd spool files were not uploaded immediately');
  assert.ok(otlp.requests.length >= 1);

  const records = await Promise.all((await readdir(uploadedDir)).map(async (name) => (
    JSON.parse(await readFile(join(uploadedDir, name), 'utf8'))
  )));
  assert.ok(records.some((record) => record.traceType === 'hook' && record.hookEventName === 'SessionEnd'));
  assert.ok(records.some((record) => record.traceType === 'agent'));
});

test('QwenCode Stop emits a completed root agent span for headless sessions', async (t) => {
  const otlp = await startOtlpServer((_attempt, _request, response) => {
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end('{"ok":true}');
  });
  t.after(otlp.close);
  const home = await createTestHome(otlp.endpoint);
  t.after(() => rm(home, { recursive: true, force: true }));
  const sessionId = 'headless-stop-upload';

  const event = JSON.stringify({
    session_id: sessionId,
    hook_event_name: 'Stop',
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
    last_assistant_message: 'done',
  });
  const result = await runNode([collectorScript], {
    env: homeEnvironment(home),
    input: event,
  });
  assert.equal(result.code, 0, result.stderr);

  const uploadedDir = join(home, '.agent-insight', 'otel_data', 'qwencode', testScope, 'uploaded', sessionId);
  const uploaded = await waitFor(async () => {
    try {
      return (await readdir(uploadedDir)).length >= 1;
    } catch {
      return false;
    }
  });
  assert.equal(uploaded, true, 'Stop spool files were not uploaded immediately');

  const records = await Promise.all((await readdir(uploadedDir)).map(async (name) => (
    JSON.parse(await readFile(join(uploadedDir, name), 'utf8'))
  )));
  const agent = records.find((record) => record.traceType === 'agent');
  assert.equal(agent?.endReason, 'turn_stop');
  assert.equal(agent?.status, 'ok');
});
