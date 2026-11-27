/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const pluginRoot = path.join(process.cwd(), 'scripts', 'agent-trace-collectors', 'deepseek-harness');

test('Harness publish manifest includes transitive local runtime imports', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));
  const pending = [manifest.main];
  const visited = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    assert.ok(manifest.files.includes(file), `published package is missing runtime module ${file}`);
    const source = fs.readFileSync(path.join(pluginRoot, file), 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*['"](\.\/[^'"]+)['"]/g)) {
      pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])));
    }
  }
  assert.ok(visited.has('dsh-context-details.mjs'));
});

test('Harness telemetry policy redacts recursively before Unicode-safe truncation', async () => {
  const plugin = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href);
  const original = {
    channel: 'ledger',
    time: 1,
    severity: 'info',
    attributes: {
      'session.id': 'session-1',
      authorization: 'Bearer secret-header',
      'x-witty-api-key': 'platform-secret',
    },
    body: {
      apiKey: 'sk-direct-secret',
      command: 'DEEPSEEK_API_KEY=sk-env-secret run',
      url: 'https://example.test/path?access_token=url-secret&ok=1',
      nested: [{ password: 'hunter2' }],
      long: '甲乙丙丁戊己庚辛壬癸',
    },
  };

  const transformed = plugin.redactTelemetryRecord(original, { maxStringChars: 6 });

  assert.notEqual(transformed, original);
  assert.equal(original.body.apiKey, 'sk-direct-secret');
  assert.equal(transformed.attributes.authorization, '[REDACTED]');
  assert.equal(transformed.attributes['x-witty-api-key'], '[REDACTED]');
  assert.equal(transformed.body.apiKey, '[REDACTED]');
  assert.equal(transformed.body.nested[0].password, '[REDACTED]');
  assert.doesNotMatch(transformed.body.command, /sk-env-secret/);
  assert.doesNotMatch(transformed.body.url, /url-secret/);
  assert.match(transformed.body.long, /^甲乙丙丁戊己…\[truncated chars=10 sha256=[0-9a-f]{16}\]$/);
  assert.equal(transformed.attributes['agent.insight.integration.name'], 'deepseek-harness');
  assert.equal(transformed.attributes['agent.insight.integration.version'], '0.1.0');
  assert.equal(transformed.attributes['agent.insight.redaction.policy'], 'v1');
});

test('Harness telemetry policy preserves ordinary prompts, Tool schema, and token accounting', async () => {
  const plugin = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href);
  const record = plugin.redactTelemetryRecord({
    channel: 'ledger',
    time: 1,
    severity: 'info',
    attributes: { 'session.id': 'session-2', 'event.type': 'request/header', 'event.seq': 0 },
    body: {
      header: {
        config: { model: 'deepseek-chat', maxTokens: 4096 },
        system: 'You are a coding agent.',
        tools: [{ name: 'read', description: 'Read a file' }],
      },
      usage: { inputTokens: 10, outputTokens: 2 },
    },
  });

  assert.equal(record.body.header.system, 'You are a coding agent.');
  assert.equal(record.body.header.tools[0].description, 'Read a file');
  assert.equal(record.body.usage.inputTokens, 10);
  assert.equal(record.body.usage.outputTokens, 2);
});

test('Harness plugin mounts the official synchronous waterfall', async () => {
  const plugin = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href);
  let eventName = '';
  let listener: any;
  const ctx = {
    on(name: string, callback: any) {
      eventName = name;
      listener = callback;
    },
  };

  plugin.apply(ctx, { maxStringChars: 64 });
  const transformed = listener(null, () => ({
    channel: 'ledger',
    time: 1,
    severity: 'info',
    attributes: {},
    body: { secret: 'do-not-export' },
  }));

  assert.equal(eventName, 'session-telemetry/record');
  assert.equal(transformed.body.secret, '[REDACTED]');
});

test('Harness bundle replaces the official telemetry row without embedding secrets', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));
  const patch = fs.readFileSync(path.join(pluginRoot, 'cordis.patch.yml'), 'utf8');

  assert.equal(packageJson.name, 'agent-insight-deepseek-harness-observability');
  assert.equal(packageJson.dsh.bundle.patch, './cordis.patch.yml');
  assert.match(patch, /^- id: session-telemetry-otel/m);
  assert.match(patch, /name: '@deepseek-ai\/dsh-session-telemetry-otel'/);
  assert.match(patch, /mode: !!js.*DISABLED.*FULL/);
  assert.match(patch, /url: !!js "/);
  assert.match(patch, /process\.env\.AGENT_INSIGHT_BASE_URL/);
  assert.match(patch, /process\.env\.AGENT_INSIGHT_API_KEY/);
  assert.match(patch, /x-witty-api-key/);
  assert.match(patch, /compression: gzip/);
  assert.doesNotMatch(patch, /replace\(\/\//);
  assert.doesNotMatch(patch, /harness-telemetry\.deepseeksvc\.com/);
  assert.doesNotMatch(patch, /sk-[a-zA-Z0-9]/);
});

test('Request membership captures exact supplied messages and bounds multibyte bodies', async () => {
  const plugin = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href);
  const options = { sessionId: 'session-test', messages: [
    { id: 'user-1', role: 'user', content: 'Keep API unchanged. API-381-TEST' },
    { id: 'tool-1', role: 'tool', content: '😀中'.repeat(4000) },
  ] };
  const manifest = plugin.buildRequestMembership(options, { captureBodies: true });
  assert.equal(manifest.items.length, 2);
  assert.equal(manifest.items[0].itemId, 'message:user-1');
  assert.ok(manifest.items[0].text.includes('API-381-TEST'));
  assert.equal(manifest.items[1].bodyStatus, 'truncated');
  assert.ok(manifest.items[1].storedBytes <= 8192);
  assert.ok(!manifest.items[1].text.includes('\uFFFD'));
  assert.equal(manifest.captureBoundary, 'harness-llm-stream');
  assert.equal(plugin.buildRequestMembership(options).items[0].text, undefined);
  assert.equal(plugin.buildRequestMembership({ messages: [{ role: 'user', content: 'unknown source' }] }).identityCoverage, 'partial');
});

test('Live exporter persists failed delivery and replays full redacted events after restart', async () => {
  const plugin = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href);
  const root = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'harness-outbox-'));
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.AGENT_INSIGHT_BASE_URL;
  const previousKey = process.env.AGENT_INSIGHT_API_KEY;
  process.env.AGENT_INSIGHT_BASE_URL = 'http://localhost:9999';
  process.env.AGENT_INSIGHT_API_KEY = 'test-owner-key';
  const payloads: any[] = [];
  const makeContext = () => {
    let listener: any;
    let close: any;
    return {
      ctx: { on(_name: string, fn: any) { listener = fn; },
        effect(factory: any) { close = factory(); }, logger: { warn() {} } },
      emit: (...args: any[]) => listener(...args),
      close: () => close(),
    };
  };
  try {
    globalThis.fetch = async () => { throw new Error('offline'); };
    const first = makeContext();
    plugin.registerLiveExporter(first.ctx, { telemetryDirectory: root });
    first.emit({ id: 'child', header: { parentSession: 'parent', cwd: '/tmp' } },
      { type: 'tool/call', seq: 8, time: 1000, data: { name: 'skill', arguments: { name: 'example', api_key: 'private' } } });
    await first.close();
    const scope = fs.readdirSync(root)[0];
    const queued = fs.readdirSync(path.join(root, scope)).filter(x => x.endsWith('.json'));
    assert.equal(queued.length, 1);
    const retryPath = path.join(root, scope, queued[0]);
    const pending = JSON.parse(fs.readFileSync(retryPath, 'utf8'));
    assert.ok(pending.agentInsightDelivery.nextAttemptAt > Date.now());
    pending.agentInsightDelivery.nextAttemptAt = 0;
    fs.writeFileSync(retryPath, JSON.stringify(pending));
    globalThis.fetch = async (_url: any, options: any) => {
      payloads.push(JSON.parse(options.body));
      return new Response('{}', { status: 200 });
    };
    const second = makeContext();
    plugin.registerLiveExporter(second.ctx, { telemetryDirectory: root });
    await second.close();
    assert.equal(fs.readdirSync(path.join(root, scope)).filter(x => x.endsWith('.json')).length, 0);
    const record = payloads[0].resourceLogs[0].scopeLogs[0].logRecords[0];
    assert.ok(JSON.stringify(record).includes('session.parent_id'));
    assert.ok(JSON.stringify(record).includes('skill'));
    assert.ok(!JSON.stringify(record).includes('private'));
    assert.ok(JSON.stringify(record).includes('[REDACTED]'));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.AGENT_INSIGHT_BASE_URL; else process.env.AGENT_INSIGHT_BASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.AGENT_INSIGHT_API_KEY; else process.env.AGENT_INSIGHT_API_KEY = previousKey;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Membership reports omitted bodies and full source byte counts without truncating fingerprints', async () => {
  const plugin = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href);
  const message = { id: 'm', role: 'user', content: '中'.repeat(40000) };
  const manifest = plugin.buildRequestMembership({ messages: [message] });
  assert.equal(manifest.items[0].bodyStatus, 'not-collected');
  assert.equal(manifest.items[0].storedBytes, 0);
  assert.equal(manifest.items[0].originalBytes, Buffer.byteLength(JSON.stringify(message)));
  assert.equal(plugin.buildRequestMembership({ messages: [message, message] }).identityCoverage, 'partial');
});

test('Member storage enforces serialized byte quota and removes expired records without new requests', async () => {
  const plugin = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href);
  const root = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'harness-members-'));
  try {
    const record = { sourceSessionId: 'same', attemptId: 'one', expiresAt: new Date(Date.now()+60000).toISOString(), text: 'x'.repeat(600000) };
    assert.equal(plugin.persistRequestMember(root, record), 'stored');
    assert.equal(plugin.persistRequestMember(root, { ...record, attemptId: 'two' }), 'quota');
    const lock = (await import('node:crypto')).createHash('sha256').update('same').digest('hex') + '.lock';
    fs.writeFileSync(path.join(root, lock), 'existing owner');
    assert.equal(plugin.persistRequestMember(root, { ...record, attemptId: 'three', text: '' }), 'busy');
    fs.unlinkSync(path.join(root, lock));
    assert.equal(plugin.cleanRequestMembers(root, Date.now()+120000), 1);
    assert.equal(plugin.persistRequestMember(root, { ...record, attemptId: 'four' }), 'stored');
    assert.equal(fs.readdirSync(root).filter(x => x.endsWith('.json')).length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Member cleanup registers an independent interval and releases it at shutdown', async () => {
  const plugin = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href);
  const root = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'harness-cleanup-'));
  const previousSet = globalThis.setInterval;
  const previousClear = globalThis.clearInterval;
  let tick: any, cleanup: any, cleared = false;
  try {
    globalThis.setInterval = ((fn: any, ms: number) => { assert.equal(ms, 60000); tick = fn; return { unref() {} }; }) as any;
    globalThis.clearInterval = (() => { cleared = true; }) as any;
    plugin.registerRequestMembers({ on() {}, effect(fn: any) { cleanup = fn(); }, logger: { warn() {} } }, { membersDirectory: root });
    fs.writeFileSync(path.join(root, 'expired.json'), JSON.stringify({ expiresAt: '2000-01-01T00:00:00Z' }));
    tick();
    assert.equal(fs.existsSync(path.join(root, 'expired.json')), false);
    cleanup(); assert.equal(cleared, true);
  } finally {
    globalThis.setInterval = previousSet; globalThis.clearInterval = previousClear;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Native request signal binds only one branded main request to its exact response', async () => {
  const plugin = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href);
  const root = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'harness-binding-'));
  const listeners = new Map<string, any>(); let dispose: any;
  try {
    const lookup = plugin.registerRequestMembers({ on(n: string, fn: any) { listeners.set(n, fn); }, effect(fn: any) { dispose = fn(); }, logger: { warn() {} } }, { membersDirectory: root, captureBodies: true, isAgentLoopRequest: (r: any) => r.main === true });
    const signal = new AbortController().signal;
    listeners.get('agent/request')({ agent: { session: { id: 's' } }, signal, turn: 2, step: 3 }, () => 'config');
    const stream = listeners.get('llm/stream');
    stream({ sessionId: 's', signal, main: false, messages: [{ id: 'title', role: 'user', content: 'Auxiliary title' }] }, () => []);
    stream({ sessionId: 's', signal, main: true, messages: [{ id: 'm', role: 'user', content: 'Keep API unchanged' }] }, () => []);
    listeners.get('session/event')({ id: 's' }, { type: 'assistant/message', seq: 27, data: { turn: 2, step: 3 } });
    const metadata = lookup('s', 27);
    assert.equal(metadata.bindingStatus, 'bound');
    assert.equal(metadata.response.eventSequence, 27);
    assert.equal(metadata.items[0].itemId, 'message:m');
    assert.equal(metadata.items[0].text, undefined);
    assert.equal(metadata.items[0].bodyStatus, 'not-uploaded');
    assert.equal(lookup('s', 27), undefined);
    const records = fs.readdirSync(root).filter(x => x.endsWith('.json')).map(x => JSON.parse(fs.readFileSync(path.join(root, x), 'utf8')));
    assert.equal(records.filter(x => x.bindingStatus === 'bound').length, 1);
    assert.equal(records.find(x => x.bindingStatus === 'bound').items[0].text.includes('Keep API unchanged'), true);
    // Concurrent or repeated main candidates are explicitly left unbound.
    stream({ sessionId: 's', signal, main: true, messages: [] }, () => []);
    stream({ sessionId: 's', signal, main: true, messages: [] }, () => []);
    listeners.get('session/event')({ id: 's' }, { type: 'assistant/message', seq: 28, data: { turn: 2, step: 3 } });
    assert.equal(lookup('s', 28), undefined);
  } finally { dispose?.(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('Concurrent processes cannot admit more than the per-session member byte quota', async () => {
  const pluginUrl = pathToFileURL(path.join(pluginRoot, 'index.js')).href;
  const root = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'harness-concurrent-'));
  const { spawn } = await import('node:child_process');
  try {
    const code = `const p=await import(process.argv[1]); p.persistRequestMember(process.argv[2],{sourceSessionId:'shared',attemptId:process.argv[3],expiresAt:'2099-01-01T00:00:00Z',text:'x'.repeat(600000)});`;
    await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, pluginUrl, root, String(i)], { stdio: 'pipe' });
      let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('exit', exit => exit === 0 ? resolve() : reject(new Error(stderr)));
    })));
    const files = fs.readdirSync(root).filter(x => x.endsWith('.json'));
    assert.equal(files.length, 1);
    assert.ok(files.reduce((n, file) => n + fs.statSync(path.join(root, file)).size, 0) <= 1048576);
    assert.equal(fs.readdirSync(root).some(x => x.endsWith('.lock')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Expired transport bodies are removed while retaining the telemetry event', async () => {
 const plugin=await import(pathToFileURL(path.join(pluginRoot,'index.js')).href);
 const root=fs.mkdtempSync(path.join((await import('node:os')).tmpdir(),'harness-scrub-'));
 try {
  const values=[{key:'text',value:{stringValue:'private body'}},{key:'bodyStatus',value:{stringValue:'available'}},{key:'storedBytes',value:{doubleValue:12}}];
  const payload={agentInsightBodyExpiresAt:'2000-01-01T00:00:00Z',resourceLogs:[{scopeLogs:[{logRecords:[{body:{kvlistValue:{values:[{key:'contextMembership',value:{kvlistValue:{values:[{key:'items',value:{arrayValue:{values:[{kvlistValue:{values}}]}}}]}}}]}}}]}]}]};
  const target=path.join(root,'one.json');fs.writeFileSync(target,JSON.stringify(payload));
  plugin.scrubExpiredOutboxBodies(root);
  const after=fs.readFileSync(target,'utf8');assert.equal(after.includes('private body'),false);assert.ok(after.includes('expired'));assert.ok(JSON.parse(after).resourceLogs);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('Skill injection category follows the original tool-call identity rather than text keywords', async () => {
 const plugin=await import(pathToFileURL(path.join(pluginRoot,'index.js')).href);
 const m=plugin.buildRequestMembership({messages:[{id:'a',role:'assistant',content:[{type:'tool-call',id:'call-skill',name:'skill'}]},{id:'b',role:'tool',source:{kind:'tool',callId:'call-skill'},content:'instruction'},{id:'c',role:'tool',source:{kind:'tool',callId:'other'},content:'skill keyword'}]});
 assert.equal(m.items[1].category,'skill-injection');assert.equal(m.items[1].sourceCallId,'call-skill');assert.equal(m.items[2].category,'tool');
});

test('Native estimate metadata never substitutes byte counts or invents estimates when unavailable', async () => {
 const plugin=await import(pathToFileURL(path.join(pluginRoot,'index.js')).href);
 const options={sessionId:'s',messages:[{id:'m',role:'user',content:[{type:'text',text:'中😀'}]}],tools:[{name:'bash'}]};
 assert.equal(plugin.buildRequestMembership(options).tokenEstimate,null);
 const m=plugin.buildRequestMembership(options,{estimates:{estimateMessage:()=>7,estimateToolsTokens:()=>11}});
 assert.equal(m.tokenEstimate.total,18);assert.equal(m.tokenEstimate.categories.user,7);
 assert.equal(m.tokenEstimate.approximate,true);assert.equal(m.providerWireCaptured,false);
 const broken=plugin.buildRequestMembership(options,{estimates:{estimateMessage(){throw Error('unsupported')},estimateToolsTokens:()=>11}});
 assert.equal(broken.tokenEstimate,null);
});

test('Unsupported request identity capability leaves ordinary live telemetry enabled', async () => {
 const plugin=await import(pathToFileURL(path.join(pluginRoot,'index.js')).href);
 const root=fs.mkdtempSync(path.join((await import('node:os')).tmpdir(),'harness-compat-'));
 const oldUrl=process.env.AGENT_INSIGHT_BASE_URL,oldKey=process.env.AGENT_INSIGHT_API_KEY;
 process.env.AGENT_INSIGHT_BASE_URL='http://127.0.0.1:9999';process.env.AGENT_INSIGHT_API_KEY='test-key';
 const events:string[]=[],effects:any[]=[],warnings:string[]=[];
 try {
  await plugin.apply({on(n:string){events.push(n)},effect(fn:any){effects.push(fn())},logger:{warn(s:string){warnings.push(s)}}},{live:true,captureRequestMembers:true,telemetryDirectory:root});
  assert.ok(events.includes('session/event'));assert.ok(!events.includes('llm/stream'));
  assert.equal(events.includes('agent/request'),false);assert.equal(warnings.length,0);
  for(const close of effects)await close();
 } finally {
  if(oldUrl===undefined)delete process.env.AGENT_INSIGHT_BASE_URL;else process.env.AGENT_INSIGHT_BASE_URL=oldUrl;
  if(oldKey===undefined)delete process.env.AGENT_INSIGHT_API_KEY;else process.env.AGENT_INSIGHT_API_KEY=oldKey;
  fs.rmSync(root,{recursive:true,force:true});
 }
});

test('Local body quota falls back to complete member metadata with an explicit omission status', async () => {
 const plugin=await import(pathToFileURL(path.join(pluginRoot,'index.js')).href);
 const root=fs.mkdtempSync(path.join((await import('node:os')).tmpdir(),'harness-quota-fallback-'));
 const listeners=new Map<string,any>();let dispose:any;
 try {
  fs.writeFileSync(path.join(root,'prior.json'),JSON.stringify({sourceSessionId:'s',expiresAt:'2099-01-01T00:00:00Z',padding:'x'.repeat(1040000)}));
  const lookup=plugin.registerRequestMembers({on(n:string,fn:any){listeners.set(n,fn)},effect(fn:any){dispose=fn()},logger:{warn(){}}},{membersDirectory:root,captureBodies:true,isAgentLoopRequest:()=>true});
  const signal=new AbortController().signal;
  listeners.get('agent/request')({agent:{session:{id:'s'}},signal,turn:1,step:1},()=>({}));
  listeners.get('llm/stream')({sessionId:'s',signal,messages:[{id:'m',role:'user',content:'x'.repeat(9000)}]},()=>[]);
  listeners.get('session/event')({id:'s'},{type:'assistant/message',seq:18,data:{turn:1,step:1}});
  const result=lookup('s',18);
  assert.equal(result.bodyCaptureStatus,'quota-omitted');assert.equal(result.bindingStatus,'bound');
  assert.equal(result.items[0].text,undefined);assert.equal(result.items[0].contentFingerprint.length,64);
  assert.ok(fs.readdirSync(root).filter(f=>f.endsWith('.json')).reduce((n,f)=>n+fs.statSync(path.join(root,f)).size,0)<=1048576);
 }finally{dispose?.();fs.rmSync(root,{recursive:true,force:true});}
});

test('A full local member cache still relays exact bound metadata without storing extra bodies', async () => {
 const plugin=await import(pathToFileURL(path.join(pluginRoot,'index.js')).href);
 const root=fs.mkdtempSync(path.join((await import('node:os')).tmpdir(),'harness-relay-'));
 const listeners=new Map<string,any>();let dispose:any;
 try {
  fs.writeFileSync(path.join(root,'prior.json'),JSON.stringify({sourceSessionId:'s',expiresAt:'2099-01-01T00:00:00Z',padding:'x'.repeat(1048000)}));
  const lookup=plugin.registerRequestMembers({on(n:string,fn:any){listeners.set(n,fn)},effect(fn:any){dispose=fn()},logger:{warn(){}}},{membersDirectory:root,captureBodies:true,isAgentLoopRequest:()=>true});
  const signal=new AbortController().signal;
  listeners.get('agent/request')({agent:{session:{id:'s'}},signal,turn:1,step:1},()=>({}));
  listeners.get('llm/stream')({sessionId:'s',signal,messages:[{id:'m',role:'user',content:'x'.repeat(9000)}]},()=>[]);
  listeners.get('session/event')({id:'s'},{type:'assistant/message',seq:18,data:{turn:1,step:1}});
  const result=lookup('s',18);
  assert.equal(result.localPersistenceStatus,'quota');assert.equal(result.bindingStatus,'bound');assert.equal(result.items[0].text,undefined);
  assert.equal(fs.readdirSync(root).filter(f=>f.endsWith('.json')).length,1);
 }finally{dispose?.();fs.rmSync(root,{recursive:true,force:true});}
});

test('A corrupt member file cannot block expiry of other bodies and ages out after the maximum retention', async () => {
 const plugin=await import(pathToFileURL(path.join(pluginRoot,'index.js')).href),root=fs.mkdtempSync(path.join((await import('node:os')).tmpdir(),'harness-corrupt-'));
 try{
  fs.writeFileSync(path.join(root,'a-corrupt.json'),'{partial private content');
  fs.writeFileSync(path.join(root,'b-expired.json'),JSON.stringify({expiresAt:'2000-01-01T00:00:00Z'}));
  let warned=0;assert.equal(plugin.cleanRequestMembers(root,Date.now(),()=>warned++),1);assert.equal(warned,1);
  assert.equal(fs.existsSync(path.join(root,'b-expired.json')),false);
  assert.equal(plugin.cleanRequestMembers(root,Date.now()+8*86400000),1);
  assert.equal(fs.readdirSync(root).length,0);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
