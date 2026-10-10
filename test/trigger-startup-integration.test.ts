import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const cli = process.env.TRIGGER_TEST_OPENCODE;

test('真实 OpenCode：用例分析冷启动、触发分析工作区复用、命中即停及鉴权失败', { skip: !cli, timeout: 300_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-integration-'));
  let mode = 'cold';
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    calls.push(mode);
    if (mode === 'auth') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key', type: 'api_error' } }));
      return;
    }
    const tool = mode === 'hit' && input.tools?.some((item: { function?: { name: string } }) => item.function?.name === 'skill');
    const message = tool
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'skill-test-call', type: 'function', function: { name: 'skill', arguments: '{"name":"test-skill"}' } }] }
      : { role: 'assistant', content: 'OK' };
    if (input.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const delta = tool ? { ...message, tool_calls: message.tool_calls!.map(call => ({ index: 0, ...call })) } : message;
      for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }]) {
        res.write(`data: ${JSON.stringify({ id: 'mock-completion', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, ...choice }] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'mock-completion', model: 'mock', choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }] }));
    }
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const config = { provider: { mock: { npm: '@ai-sdk/openai-compatible', name: 'Local mock', options: {
      baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: 'test-only',
    }, models: { mock: { name: 'Mock', limit: { context: 16384, output: 128 } } } } } };
    const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'opencode'), `#!${process.execPath}
if(process.argv.includes('debug')) { console.log(${JSON.stringify(JSON.stringify(config))}); process.exit(0); }
if(process.argv.includes('--help')) { console.log('opencode run --format json'); process.exit(0); }
const child=require('node:child_process').spawn(${JSON.stringify(cli)},process.argv.slice(2),{stdio:['inherit','inherit','inherit',3]});
child.on('error',()=>process.exit(1)); child.on('exit',code=>process.exit(code||0));
`, { mode: 0o700 });
    const script = `const client=require(${JSON.stringify(path.resolve('scripts/reliability-client.cjs'))});
const readline=require('node:readline').createInterface({input:process.stdin});
readline.on('line',async line=>{
 const {input,trigger}=JSON.parse(line);
 const skill={name:'test-skill',version:1,files:{'SKILL.md':'---\\nname: test-skill\\ndescription: local test skill\\n---\\nThis is a test skill.'}};
 const payload={platform:'opencode',agent:'build',model:'mock/mock',input,timeoutSeconds:trigger?10:90,startupTimeoutSeconds:120,
 correlation:{experimentId:'local-integration'},skillExecution:trigger
 ? {version:2,mode:'trigger',targetSkillName:'test-skill',skills:[skill]} : {version:1,skill}};
 try {const result=await client.runExperimentCase({clientId:'local-test',workspaceBase:process.cwd()},payload); console.log(JSON.stringify({ok:true,...result}));}
 catch(e){console.log(JSON.stringify({ok:false,...e.runFacts,code:e.code,message:e.message}));}
});`;
    const child = spawn(process.execPath, ['-e', script], { cwd: root, env: {
      NODE_ENV: 'test', PATH: `${bin}:${process.env.PATH}`, HOME: root, USERPROFILE: root,
      XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'),
      AGENT_INSIGHT_HOME: path.join(root, 'insight'), OPENCODE_DISABLE_MODELS_FETCH: 'true',
      OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffered = ''; let stderr = '';
    let receive: ((line: string) => void) | undefined;
    child.stdout.on('data', chunk => {
      buffered += chunk;
      const lines = buffered.split('\n'); buffered = lines.pop()!;
      for (const line of lines) if (line.startsWith('{')) receive?.(line);
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    try {
      for (const current of ['use-case', 'cold', 'hit', 'auth']) {
        mode = current;
        const output = new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`no result: ${stderr}`)), 140_000);
          receive = line => { clearTimeout(timer); resolve(line); };
        });
        child.stdin.write(JSON.stringify({
          input: current === 'use-case' ? '请分析这条日志是否有异常' : '/Users/test/logs.txt 请判断是否需要 test-skill',
          trigger: current !== 'use-case',
        }) + '\n');
        const result = JSON.parse(await output);
        t.diagnostic(`${mode}: code=${result.code || 'success'}, startupMs=${result.startupDurationMs}, reused=${result.workspaceReused}`);
        assert.equal(result.eventMonitorReady, true, JSON.stringify(result));
        assert.ok(calls.includes(mode), JSON.stringify(result));
        if (mode !== 'use-case') assert.equal(result.workspaceReused, mode !== 'cold');
        if (mode === 'auth') assert.equal(result.code, 'MODEL_UNAVAILABLE', JSON.stringify(result));
        else {
          assert.equal(result.ok, true, JSON.stringify(result));
          if (mode === 'use-case') assert.equal(result.modelActivityObserved, true);
          else {
            assert.equal(result.triggerDecision.triggered, mode === 'hit');
            assert.equal(result.triggerDecision.actualModel, 'mock/mock');
          }
        }
      }
    } finally {
      child.stdin.end();
      await exited;
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
