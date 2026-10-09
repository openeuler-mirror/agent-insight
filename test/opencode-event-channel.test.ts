import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { prepareOpencodeEventChannel, createOpencodeEventReader } = require('../scripts/opencode-experiment-events.cjs');

test('事件通道保留原配置、隔离运行标识，并拒绝其他 Session 的信号', () => {
  const config = { model: 'test/model', permission: { '*': 'deny' }, plugin: ['existing-plugin'] };
  const a = prepareOpencodeEventChannel({ OPENCODE_CONFIG_CONTENT: JSON.stringify(config) });
  const b = prepareOpencodeEventChannel({});
  assert.notEqual(a.token, b.token);
  const merged = JSON.parse(a.env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(merged.permission, config.permission);
  assert.equal(merged.model, config.model);
  assert.equal(merged.plugin[0], 'existing-plugin');
  const events: unknown[] = [];
  const reader = createOpencodeEventReader(a.token, {
    onReady: () => events.push('ready'), onSession: (id: string) => events.push(id), onEvent: (event: unknown) => events.push(event),
    onModel: (model: string) => events.push(model), onTrigger: (skill: string) => events.push(skill),
  });
  const push = (value: object, token = a.token) => reader.push(JSON.stringify({ protocol: 1, token, ...value }) + '\n');
  push({ kind: 'ready' }, b.token);
  assert.equal(reader.ready, false);
  push({ kind: 'ready' });
  push({ kind: 'session', sessionId: 'root' });
  push({ kind: 'session', sessionId: 'other' });
  push({ kind: 'event', sessionId: 'child', signal: { type: 'session.error' } });
  push({ kind: 'event', sessionId: 'root', signal: { type: 'session.status' } });
  push({ kind: 'model', sessionId: 'child', model: 'wrong/model' });
  push({ kind: 'model', sessionId: 'root', model: 'test/model' });
  push({ kind: 'trigger', sessionId: 'root', skillName: 'target-skill' });
  push({ kind: 'finished', sessionId: 'child' });
  assert.equal(reader.completed, false);
  push({ kind: 'finished', sessionId: 'root' });
  assert.equal(reader.completed, true);
  assert.deepEqual(events, ['ready', 'root', { type: 'session.status' }, 'test/model', 'target-skill']);
  assert.throws(() => prepareOpencodeEventChannel({ OPENCODE_CONFIG_CONTENT: 'broken' }), { code: 'EVENT_MONITOR_UNAVAILABLE' });
});

const cli = process.env.OPENCODE_EVENT_TEST_CLI;

test('真实插件仅转发当前根会话，用户输入不算模型活动，诊断脱敏且不转发正文', async () => {
  const plugin = pathToFileURL(path.resolve('scripts/opencode-experiment-events.mjs')).href;
  const script = `import plugin from ${JSON.stringify(plugin)};
    const hooks = await plugin();
    const emit = (type, properties) => hooks.event({event:{type,properties}});
    await emit('session.created',{info:{id:'root'}});
    await emit('session.created',{info:{id:'other'}});
    await emit('session.created',{info:{id:'child',parentID:'root'}});
    for(const sessionID of ['other','child']) await emit('session.error',{sessionID,error:{message:'wrong-session'}});
    await emit('message.updated',{info:{id:'user-msg',sessionID:'root',role:'user'}});
    await emit('message.part.updated',{part:{messageID:'user-msg',sessionID:'root',type:'text',text:'private user prompt'}});
    await emit('session.status',{sessionID:'root',status:{type:'retry',attempt:1,message:'Cannot connect to API: api_key=private-secret'}});
    await emit('message.updated',{info:{id:'assistant-msg',sessionID:'root',role:'assistant',providerID:'csi-provider',modelID:'GLM-5.2'}});
    await emit('message.part.delta',{sessionID:'root',messageID:'assistant-msg',delta:'private model response'});
    await emit('message.part.updated',{part:{id:'tool-1',messageID:'assistant-msg',sessionID:'root',type:'tool',tool:'skill',state:{status:'running',input:{skill:'target-skill'}}}});
    await emit('message.part.updated',{part:{id:'tool-1',messageID:'assistant-msg',sessionID:'root',type:'tool',tool:'skill',state:{status:'completed',input:{skill:'target-skill'}}}});
    await emit('message.part.updated',{part:{id:'tool-1',messageID:'assistant-msg',sessionID:'root',type:'tool',tool:'skill',state:{status:'completed',input:{skill:'target-skill'}}}});
    await emit('message.part.updated',{part:{id:'tool-2',messageID:'assistant-msg',sessionID:'root',type:'tool',tool:'read',state:{status:'completed',input:{filePath:'/workspace/.opencode/skills/other-skill/SKILL.md'}}}});
    await emit('session.idle',{sessionID:'root'});
    await emit('session.error',{sessionID:'root',error:{message:'connection failed',apiKey:'private-secret'}});`;
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, AGENT_INSIGHT_EVENT_TOKEN: 'fixture-token' }, stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
    });
    let result = ''; let error = '';
    child.stdio[3]!.on('data', chunk => { result += chunk; });
    child.stderr!.on('data', chunk => { error += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(result) : reject(new Error(error)));
  });
  const frames = output.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(frames.filter(frame => frame.kind === 'trigger').map(frame => frame.skillName), ['target-skill', 'other-skill']);
  assert.deepEqual(frames.filter(frame => frame.kind === 'model').map(frame => frame.model), ['csi-provider/GLM-5.2']);
  assert.equal(frames.filter(frame => frame.kind === 'finished').length, 1);
  assert.deepEqual(frames.filter(frame => frame.kind === 'event').map(frame => frame.signal.type),
    ['session.status', 'text', 'tool_use', 'tool_use', 'tool_use', 'tool_use', 'session.error']);
  assert.ok(frames.slice(1).every(frame => frame.sessionId === 'root'));
  assert.doesNotMatch(output, /private-secret|private user prompt|private model response|wrong-session/);
});

test('真实 OpenCode 原始事件通道：本地模型鉴权失败、断连和重试恢复', { skip: !cli, timeout: 180_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-opencode-events-'));
  let mode = 'auth';
  let requests = 0;
  let firstRequestAt = 0;
  const attempts = new Map<string, number>();
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests++;
    firstRequestAt ||= Date.now();
    if (mode === 'disconnect') { req.socket.destroy(); return; }
    const count = (attempts.get(body) || 0) + 1;
    attempts.set(body, count);
    if (mode === 'auth' || (mode === 'recover' && count === 1)) {
      res.writeHead(mode === 'auth' ? 401 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: mode === 'auth' ? 'Invalid API key' : 'temporary upstream failure', type: 'api_error' } }));
      return;
    }
    const stream = JSON.parse(body || '{}').stream;
    if (stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const choice of [{ delta: { role: 'assistant', content: 'OK' }, finish_reason: null }, { delta: {}, finish_reason: 'stop' }]) {
        res.write(`data: ${JSON.stringify({ id: 'test-completion', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, ...choice }] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'test-completion', model: 'mock', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }));
    }
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as { port: number }).port;
    const runner = path.resolve('scripts/reliability-client.cjs');
    for (const current of ['auth', 'disconnect', 'recover']) {
      mode = current;
      attempts.clear(); requests = 0; firstRequestAt = 0;
      const work = path.join(root, current);
      fs.mkdirSync(work);
      const config = {
        model: 'mock/mock', small_model: 'mock/mock', plugin: [], permission: { '*': 'deny' },
        provider: { mock: { npm: '@ai-sdk/openai-compatible', name: 'Local mock', options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'test-only' }, models: { mock: { name: 'Mock', limit: { context: 8192, output: 128 } } } } },
      };
      const started = Date.now();
      const script = `const c=require(${JSON.stringify(runner)}); c.runExperimentCase({clientId:'local-test',workspaceBase:process.cwd()},{platform:'opencode',agent:'build',model:'mock/mock',input:'Reply with OK.',timeoutSeconds:60}).then(r=>console.log(JSON.stringify({ok:true,...r})),e=>console.log(JSON.stringify({ok:false,...e.runFacts,code:e.code,message:e.message})));`;
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', script], { cwd: work, env: {
          NODE_ENV: 'test', PATH: `${path.dirname(cli!)}:${process.env.PATH}`, HOME: root, USERPROFILE: root,
          XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'),
          AGENT_INSIGHT_HOME: path.join(root, 'insight'), OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
          OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
        }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = ''; let err = '';
        child.stdout.on('data', chunk => { out += chunk; });
        child.stderr.on('data', chunk => { err += chunk; });
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve(out) : reject(new Error(`runner exit ${code}: ${err.slice(-1000)}`)));
      });
      const result = JSON.parse(output.trim().split('\n').at(-1)!);
      if (!requests || result.code === 'EVENT_MONITOR_UNAVAILABLE') {
        const logs = fs.readdirSync(root, { recursive: true }).map(String).filter(name => name.endsWith('.log'));
        for (const log of logs) t.diagnostic(fs.readFileSync(path.join(root, log), 'utf8').slice(-2200));
      }
      assert.ok(requests > 0, `${current}: ${JSON.stringify(result)}`);
      assert.ok(result.traceId, `${current}: ${JSON.stringify(result)}`);
      assert.equal(result.eventMonitorReady, true, JSON.stringify(result));
      assert.ok(result.eventSignalCount > 0, JSON.stringify(result));
      if (current === 'recover') assert.equal(result.ok, true, JSON.stringify(result));
      else {
        assert.equal(result.code, current === 'auth' ? 'MODEL_UNAVAILABLE' : 'MODEL_ERROR', JSON.stringify(result));
        assert.ok(Date.now() - firstRequestAt < 20_000, current);
      }
      t.diagnostic(`${current}: code=${result.code || 'success'}, requests=${requests}, totalMs=${Date.now() - started}, afterRequestMs=${Date.now() - firstRequestAt}`);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
