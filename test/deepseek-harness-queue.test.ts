import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
const plugin = () => import(pathToFileURL(path.resolve('scripts/agent-trace-collectors/deepseek-harness/index.js')).href);

test('Queue admission bounds total bytes and count without evicting pending events', async () => {
  const p = await plugin(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-queue-'));
  try {
    assert.equal(p.admitTelemetry(dir, { text: 'first' }, { queueMaxFiles: 1 }), 'stored');
    assert.equal(p.admitTelemetry(dir, { text: 'second' }, { queueMaxFiles: 1 }), 'quota');
    assert.equal(p.admitTelemetry(dir, { text: 'large'.repeat(100) }, { queueMaxBytes: 20 }), 'quota');
    assert.equal(fs.readdirSync(dir).filter(x => x.endsWith('.json')).length, 1);
    fs.writeFileSync(path.join(dir, '.admission.lock'), 'other');
    assert.equal(p.admitTelemetry(dir, {}, {}), 'busy');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Backoff persists attempts, honors retry-after and caps hostile server delays', async () => {
  const p = await plugin();
  const row = p.retryTelemetry({}, 429, '10', 1000);
  assert.equal(row.agentInsightDelivery.nextAttemptAt, 11000);
  p.retryTelemetry(row, 503, '999999999', 2000);
  assert.equal(row.agentInsightDelivery.nextAttemptAt, 62000);
  assert.equal(row.agentInsightDelivery.attempts, 2);
  assert.equal(p.retryTelemetry({}, 'network', undefined, 1000).agentInsightDelivery.nextAttemptAt, 2000);
});

test('Dead letter isolation is bounded, preserves source payload and expires independently', async () => {
  const p = await plugin(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dead-'));
  try {
    p.admitTelemetry(dir, { resourceLogs: [] }, {}, 1000);
    const first = fs.readdirSync(dir)[0];
    assert.equal(p.quarantineTelemetry(dir, first, 'http-400', { deadMaxFiles: 1 }), true);
    p.admitTelemetry(dir, { resourceLogs: [] }, {}, 2000);
    const second = fs.readdirSync(dir).find(x => x.endsWith('.json'))!;
    assert.equal(p.quarantineTelemetry(dir, second, 'http-400', { deadMaxFiles: 1 }), false);
    p.maintainTelemetryQueue(dir, {}, 7 * 86400000 + 2000);
    assert.equal(fs.readdirSync(path.join(dir, 'dead-letter')).length, 0);
    assert.equal(fs.existsSync(path.join(dir, second)), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Permanent HTTP poison does not block the next event; authentication failure remains retryable', async () => {
  const p = await plugin(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-http-'));
  const old = { fetch: globalThis.fetch, url: process.env.AGENT_INSIGHT_BASE_URL, key: process.env.AGENT_INSIGHT_API_KEY };
  process.env.AGENT_INSIGHT_BASE_URL = 'http://test.invalid'; process.env.AGENT_INSIGHT_API_KEY = 'test-key';
  let close: any, count = 0;
  try {
    const scope = (await import('node:crypto')).createHash('sha256').update('http://test.invalid\0test-key').digest('hex');
    const root = path.join(dir, scope); fs.mkdirSync(root);
    p.admitTelemetry(root, { resourceLogs: [], id: 1 }, {}, Date.now());
    p.admitTelemetry(root, { resourceLogs: [], id: 2 }, {}, Date.now() + 1);
    globalThis.fetch = (async () => new Response('{}', { status: ++count === 1 ? 400 : 200 })) as any;
    p.registerLiveExporter({ on() {}, effect(fn: any) { close = fn(); }, logger: { warn() {} } }, { telemetryDirectory: dir });
    await close();
    assert.equal(count, 2); assert.equal(fs.readdirSync(path.join(root, 'dead-letter')).length, 1);
    p.admitTelemetry(root, { resourceLogs: [] });
    globalThis.fetch = (async () => new Response('{}', { status: 401 })) as any;
    p.registerLiveExporter({ on() {}, effect(fn: any) { close = fn(); }, logger: { warn() {} } }, { telemetryDirectory: dir });
    await close();
    const pending = fs.readdirSync(root).find(x => x.endsWith('.json'))!;
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, pending), 'utf8')).agentInsightDelivery.status, 401);
  } finally {
    globalThis.fetch = old.fetch;
    for (const [name, value] of [['AGENT_INSIGHT_BASE_URL', old.url], ['AGENT_INSIGHT_API_KEY', old.key]]) { if (value === undefined) delete process.env[name!]; else process.env[name!] = value; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Replay adapter refuses unknown versions and modified source without changing package files', async () => {
  const adapter = await import(pathToFileURL(path.resolve('scripts/agent-trace-collectors/deepseek-harness/replay-compat.mjs')).href);
  assert.equal(adapter.compatibleReplaySource('changed', '0.2.2-rc.1'), null);
  assert.equal(adapter.compatibleReplaySource('changed', '0.9.0'), null);
});

test('Expired bodies are scrubbed from both active and dead-letter queues at their own deadline', async () => {
  const p=await plugin(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-dead-ttl-')),now=Date.now();
  try {
    const values=[{key:'text',value:{stringValue:'PRIVATE_BODY_381'}},{key:'bodyStatus',value:{stringValue:'available'}},{key:'storedBytes',value:{doubleValue:16}}];
    const payload={agentInsightBodyExpiresAt:new Date(now+1000).toISOString(),resourceLogs:[{scopeLogs:[{logRecords:[{body:{kvlistValue:{values:[{key:'contextMembership',value:{kvlistValue:{values:[{key:'items',value:{arrayValue:{values:[{kvlistValue:{values}}]}}}]}}}]}}}]}]}]};
    p.admitTelemetry(dir,payload,{},now);const first=fs.readdirSync(dir).find(f=>f.endsWith('.json'))!;
    assert.equal(p.quarantineTelemetry(dir,first,'http-400'),true);p.admitTelemetry(dir,payload,{},now+1);
    p.maintainTelemetryQueue(dir,{},now+999);
    assert.ok(fs.readFileSync(path.join(dir,'dead-letter',first),'utf8').includes('PRIVATE_BODY_381'));
    p.maintainTelemetryQueue(dir,{},now+1000);
    for(const root of [dir,path.join(dir,'dead-letter')])for(const name of fs.readdirSync(root).filter(f=>f.endsWith('.json'))){
      const text=fs.readFileSync(path.join(root,name),'utf8');assert.ok(!text.includes('PRIVATE_BODY_381'));assert.ok(text.includes('expired'));assert.ok(JSON.parse(text).resourceLogs);
    }
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('Concurrent queue writers share admission limits across processes', async () => {
  const { spawn } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-queue-race-'));
  try {
    const script = `import {admitTelemetry} from ${JSON.stringify(pathToFileURL(path.resolve('scripts/agent-trace-collectors/deepseek-harness/index.js')).href)}; console.log(admitTelemetry(process.argv[1], {event:process.pid}, {queueMaxFiles:2}));`;
    const results = await Promise.all(Array.from({ length: 8 }, () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir]);
      let text = ''; child.stdout.on('data', data => text += data); child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(text.trim()) : reject(new Error('queue child failed')));
    })));
    assert.ok(results.every(value => ['stored', 'busy', 'quota'].includes(value)));
    assert.ok(results.filter(value => value === 'stored').length <= 2);
    assert.ok(fs.readdirSync(dir).filter(file => file.endsWith('.json')).length <= 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
