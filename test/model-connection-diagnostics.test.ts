/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import test from 'node:test';
import { probeModelConnection, classifyModelTestError } from '../src/lib/server/model-connection-test';
import { resetProxyConfigCache } from '../src/lib/ingest/proxy-config';

const config = { provider: 'custom', baseUrl: 'https://gateway.test/v1', model: 'test-model', apiKey: '' };
const completion = { choices: [{ message: { role: 'assistant', content: 'OK' } }] };
const options = () => ({ timeoutMs: 1000, signal: new AbortController().signal });

function fixture(t: test.TestContext, level = 'error') {
  const env = process.env;
  const dir = mkdtempSync(join(tmpdir(), 'model-test-log-'));
  process.env = { ...env, AGENT_INSIGHT_LOG_LEVEL: level, AGENT_INSIGHT_LOG_DIR: dir,
    http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '', no_proxy: '', NO_PROXY: '' };
  resetProxyConfigCache();
  const lines: string[] = [];
  for (const method of ['log', 'error'] as const) t.mock.method(console, method, (...args: unknown[]) => lines.push(args.join(' ')));
  t.after(() => { process.env = env; resetProxyConfigCache(); rmSync(dir, { recursive: true, force: true }); });
  return {
    records: () => lines.filter(line => line.startsWith('{')).map(line => JSON.parse(line))
      .filter(record => record.scope === 'ModelConnectionTest'),
    text: () => lines.join('\n') + readFileSync(join(dir, 'agent-insight.log'), 'utf8'),
  };
}

async function listen(t: test.TestContext, server: Server) {
  const sockets = new Set<Duplex>();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test('default error logs retain upstream 401 reason and final auth presence without leaking header values', async t => {
  const f = fixture(t);
  const appCode = 'fictional-app-code-private';
  const scene = 'fictional-scene-private';
  const origin = await listen(t, createServer(async (req, res) => {
    req.resume();
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers['x-apig-appcode'], appCode);
    res.writeHead(401, { 'content-type': 'application/json', 'x-request-id': 'gateway-request-42',
      'set-cookie': 'session=unrelated-cookie-secret', 'www-authenticate': 'Bearer realm="gateway"' });
    res.end(JSON.stringify({ code: 'INVALID_SCENE', message: `Scene expired: ${scene}; appCode=${appCode}`,
      headers: req.headers, cookie: 'unrelated-cookie-secret' }));
  }));
  await assert.rejects(probeModelConnection({ ...config, baseUrl: origin + '/v1',
    headers: { 'X-Apig-AppCode': appCode, sceneId: scene } }, options()),
  error => classifyModelTestError(error).code === 'authentication');
  const [record] = f.records();
  assert.ok(record, 'connection test must produce a diagnostic at the default error level');
  assert.equal(record.level, 'error');
  assert.equal(record.context.upstream.status, 401);
  assert.equal(record.context.upstream.requestId, 'gateway-request-42');
  assert.equal(record.context.upstream.errorCode, 'INVALID_SCENE');
  assert.match(record.context.upstream.reason, /Scene expired/);
  assert.equal(record.context.attempts[0].authorizationPresent, false);
  assert.deepEqual(record.context.attempts[0].customHeaderNames, ['sceneid', 'x-apig-appcode']);
  assert.equal(record.context.attempts[0].proxy.mode, 'direct');
  assert.equal(record.context.attempts[0].endpoint, origin + '/v1/chat/completions');
  for (const secret of [appCode, scene, 'unrelated-cookie-secret', 'no-api-key-required']) assert.ok(!f.text().includes(secret));
});

test('API keys, overridden authorization, URL credentials and query values are redacted before truncation', async t => {
  const f = fixture(t);
  const secrets = ['fictional-api-key-private', 'fictional-custom-auth-private', 'url-password-private', 'query-secret-private'];
  const raw = secrets.join(' ') + ' ' + encodeURIComponent(secrets[3]) + ' Bearer unknown-bearer-secret';
  await assert.rejects(probeModelConnection({ ...config, apiKey: secrets[0],
    baseUrl: `https://user:${secrets[2]}@gateway.test/v1?token=${secrets[3]}`,
    headers: { Authorization: secrets[1] } }, {
    ...options(), fetch: async () => Response.json({ error: { code: 'DENIED', type: 'auth_error', message: raw } }, { status: 401 }),
  }));
  const [record] = f.records();
  assert.equal(record.context.attempts[0].authorizationPresent, true);
  assert.equal(record.context.attempts[0].proxy.mode, 'custom');
  assert.equal(record.context.upstream.errorCode, 'DENIED');
  for (const secret of [...secrets, 'unknown-bearer-secret']) assert.ok(!f.text().includes(secret), secret);
  assert.ok(!record.context.attempts[0].endpoint.includes('?'));
  assert.ok(!record.context.attempts[0].endpoint.includes('@'));
});

test('successful native Anthropic tests log the actual Messages path at info and omit model output', async t => {
  const f = fixture(t, 'info');
  await probeModelConnection({ ...config, protocol: 'anthropic', apiKey: 'native-key-private' }, {
    ...options(), fetch: async () => Response.json({ id: 'msg-1', type: 'message', role: 'assistant',
      content: [{ type: 'text', text: 'model-output-private' }], stop_reason: 'end_turn' }),
  });
  const [record] = f.records();
  assert.equal(record.level, 'info');
  assert.equal(record.context.result, 'success');
  assert.equal(record.context.attempts[0].endpoint, 'https://gateway.test/v1/messages');
  assert.equal(record.context.attempts[0].apiKeyHeaderPresent, true);
  assert.ok(!f.text().includes('native-key-private'));
  assert.ok(!f.text().includes('model-output-private'));
});

test('proxy diagnostics follow actual CONNECT dispatch and cached NO_PROXY bypass decisions', async t => {
  const f = fixture(t, 'info');
  let directHits = 0;
  let proxyHits = 0;
  const sockets = new Set<Duplex>();
  const origin = await listen(t, createServer(async (req, res) => {
    req.resume();
    directHits++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(completion));
  }));
  const proxy = createServer();
  proxy.on('connect', (req, socket, head) => {
    proxyHits++;
    const destination = new URL('http://' + req.url);
    const upstream = connect(Number(destination.port), destination.hostname, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    sockets.add(socket); sockets.add(upstream);
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
  });
  const proxyOrigin = await listen(t, proxy);
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  process.env.HTTPS_PROXY = proxyOrigin.replace('http://', 'http://proxy-user:proxy-password-private@');
  for (const bypass of [false, true]) {
    process.env.NO_PROXY = bypass ? '127.0.0.1' : '';
    resetProxyConfigCache();
    await probeModelConnection({ ...config, baseUrl: origin + '/v1' }, options());
    const record = f.records().at(-1);
    assert.equal(record.context.attempts[0].proxy.mode, bypass ? 'direct' : 'proxy');
    assert.equal(record.context.attempts[0].proxy.bypassed, bypass);
    assert.equal(record.context.attempts[0].proxy.env, 'HTTPS_PROXY');
    assert.equal(record.context.attempts[0].proxy.endpoint, proxyOrigin);
    if (!bypass) {
      process.env.NO_PROXY = '127.0.0.1';
      await probeModelConnection({ ...config, baseUrl: origin + '/v1' }, options());
      assert.equal(f.records().at(-1).context.attempts[0].proxy.mode, 'proxy');
    }
  }
  assert.equal(proxyHits, 2);
  assert.equal(directHits, 3);
  assert.ok(!f.text().includes('proxy-password-private'));
});

test('proxy CONNECT rejection is distinguished from a model HTTP 401', async t => {
  const f = fixture(t);
  const proxy = createServer();
  proxy.on('connect', (_req, socket) => socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));
  process.env.HTTPS_PROXY = await listen(t, proxy);
  await assert.rejects(probeModelConnection(config, options()), error => classifyModelTestError(error).code === 'network');
  const [record] = f.records();
  assert.equal(record.context.attempts[0].proxy.mode, 'proxy');
  assert.equal(record.context.proxyTunnelStatus, 401);
  assert.equal(record.context.upstream, undefined);
});

test('plain text and HTML 401 errors are bounded and sanitized, without logging arbitrary JSON fields', async t => {
  const f = fixture(t);
  for (const [text, contentType, reason] of [
    ['Missing sceneId; Authorization: Bearer plain-text-secret', 'text/plain', /Missing sceneId/],
    ['<html><title>Gateway denied</title><body>Invalid AppCode<input value="hidden-secret"></body></html>', 'text/html', /Gateway denied/],
    [JSON.stringify({ error: { message: 'Denied', credentials: 'unknown-json-secret' }, debug: 'unknown-debug-secret' }), 'application/json', /Denied/],
  ] as const) {
    await assert.rejects(probeModelConnection(config, { ...options(),
      fetch: async () => new Response(text, { status: 401, headers: { 'content-type': contentType } }),
    }));
    assert.match(f.records().at(-1).context.upstream.reason, reason);
  }
  for (const secret of ['plain-text-secret', 'hidden-secret', 'unknown-json-secret', 'unknown-debug-secret']) assert.ok(!f.text().includes(secret));
});

test('APIG error_code/error_msg and body request_id are retained without echoing configured credentials', async t => {
  const f = fixture(t);
  await assert.rejects(probeModelConnection({ ...config, headers: { 'X-Apig-AppCode': 'private-app-code' } }, {
    ...options(), fetch: async () => Response.json({ error_code: 'APIG.0308',
      error_msg: 'Incorrect app authentication: private-app-code', request_id: 'apig-request-7',
      unrelated: 'private-debug-data' }, { status: 401 }),
  }));
  const [record] = f.records();
  assert.equal(record.context.upstream.errorCode, 'APIG.0308');
  assert.match(record.context.upstream.reason, /Incorrect app authentication/);
  assert.equal(record.context.upstream.requestId, 'apig-request-7');
  assert.ok(!f.text().includes('private-app-code'));
  assert.ok(!f.text().includes('private-debug-data'));
});

test('short custom header secrets cannot recursively expand redaction markers', async t => {
  const f = fixture(t);
  await assert.rejects(probeModelConnection({ ...config, headers: { 'X-One': 'E', 'X-Two': 'R' } }, {
    ...options(), fetch: async () => Response.json({ error: { message: 'ERR' } }, { status: 401 }),
  }));
  assert.equal(f.records()[0].context.upstream.reason, '[REDACTED][REDACTED][REDACTED]');
});

test('Cookie components and decoded Basic credentials are redacted from all upstream diagnostic fields', async t => {
  const f = fixture(t);
  const cases: Array<{ headers: Record<string, string>; secrets: string[] }> = [
    { headers: { Cookie: 'session=cookie-token-private; tenant="quoted-cookie-private"; encoded=url%2Fcookie%2Bprivate' },
      secrets: ['cookie-token-private', 'quoted-cookie-private', 'url/cookie+private'] },
    { headers: { Authorization: 'Basic ' + Buffer.from('test-user:basic-password-private').toString('base64') }, secrets: ['test-user', 'basic-password-private'] },
    { headers: { 'Proxy-Authorization': 'Basic ' + Buffer.from('proxy-user:basic-proxy-password-private').toString('base64') }, secrets: ['proxy-user', 'basic-proxy-password-private'] },
  ];
  for (const { headers, secrets } of cases) {
    await assert.rejects(probeModelConnection({ ...config, headers }, { ...options(), fetch: async () => Response.json({
      error: { message: 'Session expired: ' + secrets.join(' ') },
    }, { status: 401, headers: { 'x-request-id': secrets[0], 'www-authenticate': `Basic realm="${secrets.at(-1)}"` } }) }));
    const record = f.records().at(-1);
    const text = JSON.stringify(record);
    for (const secret of secrets) {
      assert.ok(!text.includes(secret), secret);
      assert.ok(!f.text().includes(secret), secret);
    }
  }
});

test('oversized upstream bodies are omitted instead of leaking a truncated credential', async t => {
  const f = fixture(t);
  await assert.rejects(probeModelConnection({ ...config, apiKey: 'private-key-at-boundary' }, {
    ...options(), fetch: async () => new Response('x'.repeat(8190) + 'private-key-at-boundary', { status: 401 }),
  }));
  const [record] = f.records();
  assert.equal(record.context.upstream.bodyTruncated, true);
  assert.ok(!f.text().includes('private-key'));
  assert.ok(f.text().length < 12_000);
});

test('error-body capture respects timeout and cancellation and never delays or duplicates the request', async t => {
  const f = fixture(t);
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    let calls = 0;
    const timer = cancelled ? setTimeout(() => controller.abort(), 10) : undefined;
    const started = Date.now();
    await assert.rejects(probeModelConnection(config, { timeoutMs: 30, signal: controller.signal,
      fetch: async (_url, init) => {
        calls++;
        return new Response(new ReadableStream({ start(stream) {
          stream.enqueue(new TextEncoder().encode('partial private error'));
          init!.signal!.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')));
        } }), { status: 401 });
      },
    }), error => classifyModelTestError(error).code === (cancelled ? 'cancelled' : 'timeout'));
    clearTimeout(timer);
    assert.equal(calls, 1);
    assert.ok(Date.now() - started < 1000);
    const record = f.records().at(-1);
    assert.equal(record.context.result, cancelled ? 'cancelled' : 'timeout');
    assert.equal(record.context.upstream.status, 401);
    assert.equal(record.context.upstream.bodyIncomplete, true);
  }
  assert.ok(!f.text().includes('partial private error'));
});

test('transport failures retain safe cause codes and logging sink failures never change probe results', async t => {
  const f = fixture(t);
  await assert.rejects(probeModelConnection(config, { ...options(), fetch: async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('private network detail'), { code: 'ECONNREFUSED' }) });
  } }));
  assert.ok(f.records()[0].context.causeCodes.includes('ECONNREFUSED'));
  assert.ok(!f.text().includes('private network detail'));
  t.mock.method(console, 'error', () => { throw new Error('broken sink'); });
  await assert.rejects(probeModelConnection(config, { ...options(), fetch: async () => new Response('Denied', { status: 401 }) }),
    error => classifyModelTestError(error).code === 'authentication');
});
