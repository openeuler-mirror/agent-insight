import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import test from 'node:test';

const cli = process.env.OPENCODE_CREDENTIAL_TEST_CLI;

test('真实 OpenCode 1.19.3：恢复脱敏 Key 后执行隔离实验，缺失原始值时不请求模型', { skip: !cli, timeout: 180_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-credentials-native-'));
  const requests: { authorization?: string; routing?: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    requests.push({ authorization: req.headers.authorization, routing: req.headers['x-routing'] as string });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const choice of [{ delta: { role: 'assistant', content: 'OK' }, finish_reason: null }, { delta: {}, finish_reason: 'stop' }]) {
      res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: input.model, choices: [{ index: 0, ...choice }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  const run = (code: string, env: NodeJS.ProcessEnv) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('native test timeout')); }, 140_000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve({ code, output: output + (code ? errors : '') }); });
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, NODE_ENV: 'test', HOME: root, USERPROFILE: root, OPENCODE_TEST_HOME: root,
      XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'),
      XDG_STATE_HOME: path.join(root, 'state'), AGENT_INSIGHT_HOME: path.join(root, 'insight'),
      OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(root, 'managed'), OPENCODE_DISABLE_MODELS_FETCH: 'true',
      OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', TEST_MODEL_KEY: 'native-test-key',
    };
    const configFile = path.join(env.XDG_CONFIG_HOME!, 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ provider: { mock: {
      npm: '@ai-sdk/openai-compatible', name: 'Local mock',
      options: { baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        apiKey: '{env:TEST_MODEL_KEY}', headers: { 'x-routing': 'native-test-route' } },
      models: { mock: { name: 'Mock', limit: { context: 16384, output: 128 } } },
    } } }), { mode: 0o600 });
    const workspaceModule = JSON.stringify(path.resolve('scripts/skill-experiment-workspace.cjs'));
    const script = `
const assert=require('node:assert/strict'), fs=require('node:fs'), cp=require('node:child_process');
const cli=${JSON.stringify(cli)};
assert.equal(cp.execFileSync(cli,['--version'],{encoding:'utf8'}).trim(),'1.19.3');
const debug=JSON.parse(cp.execFileSync(cli,['debug','config'],{encoding:'utf8',maxBuffer:8*1024*1024}));
assert.equal(debug.provider.mock.options.apiKey,'***');
assert.equal(debug.provider.mock.options.headers['x-routing'],'***');
const {prepareSkillExperimentWorkspace:prepare}=require(${workspaceModule});
let workspace;
try {
 workspace=prepare(cli,{platform:'opencode',agent:'build',model:'mock/mock',skillExecution:{version:2,mode:'trigger',skills:[
  {name:'test-skill',version:1,files:{'SKILL.md':'---\\nname: test-skill\\ndescription: Only for unrelated tasks\\n---\\nTest'}}
 ]}});
 const config=JSON.parse(fs.readFileSync(workspace.env.OPENCODE_CONFIG,'utf8'));
 assert.equal(config.provider.mock.options.apiKey,'native-test-key');
 assert.equal(config.permission.bash,'deny');
 const result=cp.spawnSync(cli,['run','--format','json','--model','mock/mock','--agent','build','Say OK'],{
   cwd:workspace.cwd,env:{...process.env,...workspace.env},encoding:'utf8',timeout:90000,maxBuffer:8*1024*1024});
 assert.equal(result.status,0, result.stderr);
 assert.ok(result.stdout.includes('OK'),result.stdout);
 console.log('native execution verified');
} finally { workspace?.cleanup(); }
`;
    const result = await run(script, env);
    assert.equal(result.code, 0, result.output);
    assert.ok(requests.length > 0);
    assert.ok(requests.every(req => req.authorization === 'Bearer native-test-key' && req.routing === 'native-test-route'));
    t.diagnostic('1.19.3 原生 debug 已脱敏；真实 run 收到原始测试 Key 与 header；只读隔离权限保留');
    const count = requests.length;
    for (const invalid of [undefined, '***']) {
      const failed = await run(`
const assert=require('node:assert/strict');
const {prepareSkillExperimentWorkspace:prepare}=require(${workspaceModule});
assert.throws(()=>prepare(${JSON.stringify(cli)},{platform:'opencode',agent:'build',model:'mock/mock',skillExecution:{version:1,skill:null}}),
 error=>error.code==='MODEL_UNAVAILABLE' && !error.message.includes('native-test-key'));
console.log('missing key rejected before execution');
`, { ...env, TEST_MODEL_KEY: invalid });
      assert.equal(failed.code, 0, failed.output);
      assert.equal(requests.length, count);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
