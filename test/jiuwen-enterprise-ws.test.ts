/* Copyright (c) 2026 Huawei Technologies Co., Ltd. SPDX-License-Identifier: Apache-2.0 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const { WebSocketServer } = require('ws');

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuwen-ee-ws-'));
  const file = path.join(dir, 'credentials.json');
  const counters = { login: 0, refresh: 0, discover: 0, sends: 0 };
  let rejectDiscovery = false;
  let contexts = [
    { user_id: 'alice', group_id: 'group-a', bot_id: 'bot-a', jiuwenclaw_id: 'node-a', agent_name: 'test1', group_name: 'A', jiuwenclaw_name: 'Node A' },
    { user_id: 'alice', group_id: 'group-b', bot_id: 'bot-b', jiuwenclaw_id: 'node-b', agent_name: 'test1', group_name: 'B', jiuwenclaw_name: 'Node B' },
  ];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/idp/v1/auth/token') {
      counters.login++;
      assert.equal(new URLSearchParams(raw).get('username'), 'alice');
      if (new URLSearchParams(raw).get('password') !== 'private-secret') { res.statusCode = 401; res.end('{"error":"private-secret"}'); return; }
      res.end(JSON.stringify({ access_token: 'private-token', refresh_token: 'private-refresh', expires_in: 3600 }));
    } else if (req.url === '/idp/v1/auth/refresh') {
      counters.refresh++; res.end(JSON.stringify({ access_token: 'private-token-2', refresh_token: 'private-refresh-2', expires_in: 3600 }));
    } else if (req.url === '/api/v1/user-console/agent-contexts') {
      counters.discover++;
      if (rejectDiscovery && req.headers.authorization === 'Bearer private-token') { res.statusCode = 401; res.end('{}'); return; }
      assert.match(String(req.headers.authorization), /^Bearer private-token/);
      res.end(JSON.stringify({ code: 200, data: { contexts } }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    assert.match(String(req.headers.authorization), /^Bearer private-token/);
    const url = new URL(req.url!, 'http://localhost');
    const bot = url.searchParams.get('bot_id');
    assert.ok(contexts.some(c => c.bot_id === bot));
    assert.ok(String(req.headers.cookie).includes(`jiuwenclaw_id=${bot === 'bot-a' ? 'node-a' : 'node-b'}`));
    wss.handleUpgrade(req, socket, head, (ws: any) => {
      ws.on('message', (raw: Buffer) => {
        const x = JSON.parse(String(raw)); counters.sends++;
        const payload = x.method === 'models.list' ? { models: [{ model_name: bot === 'bot-a' ? 'model-a' : 'model-b' }], active_model: bot === 'bot-a' ? 'model-a' : 'model-b' } : { session_id: 'web_enterprise_native' };
        ws.send(JSON.stringify({ type: 'res', id: x.id, ok: true, payload }));
        if (x.method === 'chat.send') ws.send(JSON.stringify({ type: 'event', event: 'chat.final', payload: { session_id: 'web_enterprise_native', content: 'ok' } }));
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  fs.writeFileSync(file, JSON.stringify({ baseUrl, username: 'alice', password: 'private-secret' }), { mode: 0o600 });
  return { file, dir, counters, baseUrl, setReject: () => { rejectDiscovery = true; }, revoke: () => { contexts = []; },
    close: async () => { for (const ws of wss.clients) ws.terminate(); await new Promise<void>(r => server.close(() => r())); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('enterprise discovers identities, disambiguates names, isolates models and reports no secrets', async () => {
  const f = await fixture();
  try {
    const { createEnterpriseWs } = require('../scripts/jiuwen-enterprise-ws.cjs');
    const client = createEnterpriseWs({ configFile: f.file });
    const cap = await client.refresh();
    assert.equal(cap.ready, true); assert.equal(cap.agents.length, 2);
    assert.notEqual(cap.agents[0], cap.agents[1]);
    assert.match(cap.agentCatalog[0].label, /test1/);
    assert.deepEqual(cap.agentCatalog.map((a: any) => a.models), [['model-a'], ['model-b']]);
    assert.doesNotMatch(JSON.stringify(cap), /private-secret|private-token|private-refresh/);
    const target = await client.resolve(cap.agents[0]);
    assert.equal(new URL(target.url).searchParams.get('bot_id'), 'bot-a');
    assert.equal(f.counters.login, 1);
    assert.deepEqual(fs.readdirSync(f.dir), ['credentials.json']);
    f.setReject(); await client.refresh(); assert.equal(f.counters.refresh, 1);
    fs.chmodSync(f.file, 0o644);
    await assert.rejects(client.resolve(cap.agents[0]), { code: 'JIUWEN_CONFIG_INVALID' });
    fs.chmodSync(f.file, 0o600);
    await client.refresh();
    f.revoke(); await assert.rejects(client.resolve(cap.agents[0]), { code: 'JIUWEN_CONTEXT_UNAVAILABLE' });
    assert.deepEqual(client.probe().agents, []);
  } finally { await f.close(); }
});

test('enterprise rejects permissions, password errors and insecure entry without leaking responses', async () => {
  const f = await fixture();
  try {
    const { createEnterpriseWs } = require('../scripts/jiuwen-enterprise-ws.cjs');
    const client = createEnterpriseWs({ configFile: f.file });
    fs.chmodSync(f.file, 0o644);
    await assert.rejects(client.refresh(), { code: 'JIUWEN_CONFIG_INVALID' });
    fs.chmodSync(f.file, 0o600);
    fs.writeFileSync(f.file, JSON.stringify({ baseUrl: f.baseUrl, username: 'alice', password: 'wrong-secret' }));
    await assert.rejects(client.refresh(), (e: any) => e.code === 'JIUWEN_AUTH_REQUIRED' && !/private|wrong-secret/.test(e.message));
    assert.equal(client.probe().ready, false);
    fs.writeFileSync(f.file, JSON.stringify({ baseUrl: 'http://example.com', username: 'alice', password: 'private-secret' }));
    await assert.rejects(client.refresh(), { code: 'JIUWEN_CONFIG_INVALID' });
  } finally { await f.close(); }
});

test('enterprise runtime routes selected Agent using authenticated #588 WebSocket protocol', async () => {
  const f = await fixture(); const prev = process.env.AGENT_INSIGHT_JIUWEN_ENTERPRISE_CONFIG;
  process.env.AGENT_INSIGHT_JIUWEN_ENTERPRISE_CONFIG = f.file;
  try {
    const ee = require('../scripts/jiuwen-enterprise-ws.cjs').enterpriseWs;
    const cap = await ee.refresh();
    const runtime = require('../scripts/jiuwen-experiment-runtime.cjs');
    const client = require('../scripts/reliability-client.cjs');
    const services = require('../services/executor/src/environment/services.cjs').createServices({ cfg: {}, client });
    assert.deepEqual(await services.checkAgent({ platform: 'jiuwenswarm', agent: cap.agents[0], model: 'model-a' }), []);
    const unavailable = await services.checkAgent({ platform: 'jiuwenswarm', agent: cap.agents[0], model: 'model-b' });
    assert.equal(unavailable[0].code, 'MODEL_UNAVAILABLE');
    const result = await runtime.run({ agent: cap.agents[0], input: 'original unchanged input', model: 'model-a', timeoutSeconds: 5 });
    assert.equal(result.sessionId, 'web_enterprise_native');
    await assert.rejects(runtime.run({ agent: 'main_agent', input: 'no fallback' }), { code: 'JIUWEN_CONTEXT_UNAVAILABLE' });
  } finally {
    if (prev === undefined) delete process.env.AGENT_INSIGHT_JIUWEN_ENTERPRISE_CONFIG; else process.env.AGENT_INSIGHT_JIUWEN_ENTERPRISE_CONFIG = prev;
    await f.close();
  }
});

test('changing enterprise account during login discards the old identity and its pending token result', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuwen-ee-account-race-'));
  const file = path.join(dir, 'credentials.json');
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const loginStarted = new Promise<void>(r => { started = r; });
  const auths: string[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/idp/v1/auth/token') {
      const user = new URLSearchParams(raw).get('username');
      if (user === 'old-admin') { started(); await gate; }
      res.end(JSON.stringify({ access_token: user + '-token', refresh_token: user + '-refresh', expires_in: 3600 }));
    } else { auths.push(String(req.headers.authorization)); res.end(JSON.stringify({ code: 200, data: { contexts: [] } })); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  const write = (username: string) => fs.writeFileSync(file, JSON.stringify({ baseUrl, username, password: 'test-password' }), { mode: 0o600 });
  try {
    const client = require('../scripts/jiuwen-enterprise-ws.cjs').createEnterpriseWs({ configFile: file });
    write('old-admin'); const first = client.refresh().then(() => null, (e: any) => e);
    await loginStarted;
    write('new-limited-user'); const second = client.refresh(); release();
    await second; const oldError = await first;
    assert.equal(oldError?.code, 'JIUWEN_CONFIG_CHANGED');
    await client.refresh();
    assert.deepEqual(auths, ['Bearer new-limited-user-token', 'Bearer new-limited-user-token']);
    assert.equal(client.probe().reason.includes('没有授权'), true);
  } finally { release(); await new Promise<void>(r => server.close(() => r())); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('authenticated socket receives exactly one server close notification promptly', async () => {
  const server = http.createServer(); const wss = new WebSocketServer({ server });
  wss.on('connection', (ws: any) => ws.on('message', () => ws.close(1000, 'finished')));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${(server.address() as any).port}/ws`;
  const socket = require('../scripts/jiuwen-enterprise-ws.cjs').authorizedSocket({ url, headers: {} });
  try {
    let closed = 0;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server close was not propagated')), 500);
      socket.addEventListener('open', () => socket.send('please-close'));
      socket.addEventListener('close', () => { closed++; clearTimeout(timer); resolve(); });
    });
    assert.equal(closed, 1); assert.equal(socket.readyState, 3);
  } finally { socket.close(); for (const ws of wss.clients) ws.terminate(); await new Promise<void>(r => server.close(() => r())); }
});

test('late failure from old enterprise identity cannot clear the new account capability', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuwen-ee-late-error-')); const file = path.join(dir, 'credentials.json');
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(r => { release = r; }); const loginStarted = new Promise<void>(r => { started = r; });
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/idp/v1/auth/token') {
      const user = new URLSearchParams(raw).get('username');
      if (user === 'old-admin') { started(); await gate; res.statusCode = 500; res.end('{}'); return; }
      res.end(JSON.stringify({ access_token: user + '-token', refresh_token: user + '-refresh', expires_in: 3600 }));
    } else res.end(JSON.stringify({ code: 200, data: { contexts: [] } }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  const write = (username: string) => fs.writeFileSync(file, JSON.stringify({ baseUrl, username, password: 'test-password' }), { mode: 0o600 });
  try {
    const client = require('../scripts/jiuwen-enterprise-ws.cjs').createEnterpriseWs({ configFile: file });
    write('old-admin'); const first = client.refresh().then(() => null, (e: any) => e); await loginStarted;
    write('new-limited-user'); const current = await client.refresh(); release();
    assert.equal((await first)?.code, 'JIUWEN_CONFIG_CHANGED');
    assert.deepEqual(client.probe(), current);
  } finally { release(); await new Promise<void>(r => server.close(() => r())); fs.rmSync(dir, { recursive: true, force: true }); }
});
