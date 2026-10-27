import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const { loadConfig, preflightTrace } = require('../scripts/agent-trace-collectors/mcts-xgovernor-proxy/run.cjs');
const exec = promisify(execFile);

async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcts-credentials-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'installation');
  const spool = path.join(root, 'case-spool');
  const configPath = path.join(home, 'collectors/mcts-xgovernor-proxy/config.json');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.mkdir(spool);
  await fs.writeFile(configPath, JSON.stringify({ apiKey: 'stale-collector-key', baseUrl: 'https://platform.example' }));
  return { root, home, spool, configPath, args: { configPath }, env: { AGENT_INSIGHT_HOME: spool } };
}

test('MCTS reads installation credentials instead of stale collector config or per-case spool env', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.home, '.env'), 'export AGENT_INSIGHT_API_KEY="current-key" # shared\n');
  await fs.writeFile(path.join(f.spool, '.env'), 'AGENT_INSIGHT_API_KEY=wrong-case-key\n');
  const config = await loadConfig(f.args, f.env);
  assert.equal(config.apiKey, 'current-key');
  assert.equal(config.agentInsightHome, f.spool);
  assert.equal((await loadConfig(f.args, { ...f.env, AGENT_INSIGHT_API_KEY: 'explicit-key' })).apiKey, 'explicit-key');
  await fs.writeFile(path.join(f.home, '.env'), 'AGENT_INSIGHT_API_KEY=rotated-key\n');
  assert.equal((await loadConfig(f.args, f.env)).apiKey, 'rotated-key');
  assert.equal(JSON.parse(await fs.readFile(f.configPath, 'utf8')).apiKey, 'stale-collector-key');
});

test('MCTS supports legacy standalone config but does not fall back when shared key is explicitly cleared', async t => {
  const f = await fixture(t);
  assert.equal((await loadConfig(f.args, f.env)).apiKey, 'stale-collector-key');
  await fs.writeFile(path.join(f.home, '.env'), 'AGENT_INSIGHT_API_KEY=""\n');
  assert.equal((await loadConfig(f.args, f.env)).apiKey, '');
  await fs.writeFile(path.join(f.home, '.env'), 'UNRELATED=value\n');
  assert.equal((await loadConfig(f.args, f.env)).apiKey, 'stale-collector-key');
});

test('MCTS fails closed if shared credentials cannot be read', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.home, '.env'));
  await assert.rejects(loadConfig(f.args, f.env), /Cannot read MCTS shared collector credentials/);
});

test('Trace preflight sends an empty authenticated OTLP request without following redirects', async () => {
  await preflightTrace({ apiKey: 'synthetic-key', otlpEndpoint: 'https://platform.example/api/ingest/otel/v1/traces' }, async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://platform.example/api/ingest/otel/v1/traces');
    assert.deepEqual(JSON.parse(String(init.body)), { resourceSpans: [] });
    assert.equal((init.headers as Record<string, string>)['x-witty-api-key'], 'synthetic-key');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    return new Response(JSON.stringify({ status: 'accepted', received: 0 }));
  });
});

test('Trace preflight rejects invalid credentials, unavailable endpoints and unexpected responses without leaking secrets', async () => {
  const config = { apiKey: 'private-synthetic-key', otlpEndpoint: 'https://platform.example' };
  for (const status of [401, 403, 500]) {
    await assert.rejects(preflightTrace(config, async () => new Response(config.apiKey, { status })), (error: Error) => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.ok(!error.message.includes(config.apiKey));
      return true;
    });
  }
  await assert.rejects(preflightTrace(config, async () => { throw new Error(config.apiKey); }), /platform unreachable or request timed out/);
  await assert.rejects(preflightTrace(config, async () => new Response('<html>login</html>')), /unexpected response/);
  await assert.rejects(preflightTrace({ ...config, apiKey: '' }, () => assert.fail('must not send missing credentials')), /credential missing/);
});

for (const status of [401, 200]) test(`real launcher uses shared credentials and starts MCTS only after accepted auth (${status})`, async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.home, '.env'), 'AGENT_INSIGHT_API_KEY=shared-key\n');
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    assert.equal(req.headers['x-witty-api-key'], 'shared-key');
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? { status: 'accepted', received: 0 } : { error: 'rejected' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const marker = path.join(f.root, 'child-started');
  const env = { ...process.env, ...f.env, AGENT_INSIGHT_API_KEY: '', AGENT_INSIGHT_MCTS_REPO_DIR: '', AGENT_INSIGHT_MCTS_PYTHON: '', AGENT_INSIGHT_MCTS_PROXY_ENABLED: '1', AGENT_INSIGHT_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}/api/ingest/otel/v1/traces` };
  const execution = exec(process.execPath, [
    'scripts/agent-trace-collectors/mcts-xgovernor-proxy/run.cjs', '--strict', '--config', f.configPath, '--upstream', `http://127.0.0.1:${address.port}`,
    '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
  ], { env, timeout: 15000 });
  if (status === 200) {
    await execution;
    assert.equal(await fs.readFile(marker, 'utf8'), 'started');
    assert.ok(requests >= 1);
    return;
  }
  await assert.rejects(execution, (error: any) => {
    assert.match(error.stderr, /Trace authentication failed \(HTTP 401\)/);
    assert.ok(!error.stderr.includes('shared-key'));
    return true;
  });
  assert.equal(requests, 1);
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(f.spool, 'otel_data')), { code: 'ENOENT' });
});
