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
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';
import { withOpenCodePluginDependencies, writeOpenCodePluginDependencies } from './fixtures/opencode-plugin-dependencies';

test.beforeEach(t => { withOpenCodePluginDependencies(t as TestContext); });

const require = createRequire(import.meta.url);
const { loadOpenCodeConnectionConfig: load, checkOpenCodeModelConfig: checkModel, checkOpenCodeModelConfigAsync: checkModelAsync, parseJsonc } = require('../scripts/opencode-connection-config.cjs');
const { prepareSkillExperimentWorkspace: prepare } = require('../scripts/skill-experiment-workspace.cjs');
const selection = { agent: 'build', model: 'test/model', trigger: true };
const raw = (key: string) => ({ provider: { test: { npm: '@ai-sdk/openai-compatible', options: { apiKey: key, baseURL: 'https://example.test/v1' } } } });
const masked = raw('***');

function fixture(t: TestContext, output: unknown = masked) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-credentials-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), cwd = path.join(root, 'project', 'nested');
  fs.mkdirSync(home); fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(root, 'project', '.git'));
  const env: Record<string, string | undefined> = {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'), OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(root, 'managed'),
    OPENCODE_TEST_HOME: undefined, OPENCODE_CONFIG: undefined, OPENCODE_CONFIG_CONTENT: undefined,
    OPENCODE_CONFIG_DIR: undefined, OPENCODE_DISABLE_PROJECT_CONFIG: undefined, OPENCODE_AUTH_CONTENT: undefined,
  };
  const configFile = path.join(env.XDG_CONFIG_HOME!, 'opencode', 'opencode.json');
  writeOpenCodePluginDependencies(path.dirname(configFile));
  const outputFile = path.join(root, 'output');
  const modelsFile = path.join(root, 'models');
  const callsFile = path.join(root, 'calls');
  const write = (file: string, value: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  };
  write(configFile, raw('local-test-key'));
  write(outputFile, output);
  write(modelsFile, 'test/model\ntest/other\n');
  const executable = path.join(root, 'opencode');
  const changeFile = path.join(root, 'change.cjs');
  write(executable, `#!${process.execPath}
const fs=require('node:fs');
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),offline:process.env.OPENCODE_DISABLE_MODELS_FETCH})+'\\n');
if(process.argv.includes('--version')) console.log(process.env.FIXTURE_VERSION || '1.19.3');
else if(process.argv.includes('db')) console.log(process.env.FIXTURE_DB || '[{"active_orgs":0}]');
else if(process.argv[2]==='models') {
 if(process.env.FIXTURE_MODELS_DELAY) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Number(process.env.FIXTURE_MODELS_DELAY));
 process.stdout.write(fs.readFileSync(${JSON.stringify(modelsFile)}));
}
else {
 if(fs.existsSync(${JSON.stringify(changeFile)})) require(${JSON.stringify(changeFile)});
 process.stdout.write(fs.readFileSync(${JSON.stringify(outputFile)}));
}
process.exit(Number(process.env.FIXTURE_EXIT || 0));
`);
  fs.chmodSync(executable, 0o700);
  const options = { home, cwd, env, platform: 'linux' };
  return { root, home, cwd, env, configFile, outputFile, modelsFile, callsFile, executable, changeFile, write, options,
    run: (sel = selection) => load(executable, sel, options),
    check: (sel = selection) => checkModel(executable, sel, options) };
}

test('v2 共用同步与异步预检，执行前不会回退 v1 配置解析且保留错误分类', async t => {
  const f = fixture(t, { data: [{ providerID: 'test', id: 'model', enabled: true }] });
  f.env.FIXTURE_VERSION = 'opencode v2.1.4';
  assert.deepEqual(f.check(), { model: 'test/model' });
  assert.deepEqual(await checkModelAsync(f.executable, selection, f.options), { model: 'test/model' });
  f.write(f.outputFile, { data: { providerID: 'test', id: 'other', enabled: true } });
  assert.deepEqual(await checkModelAsync(f.executable, { agent: 'build' }, f.options), { model: 'test/other' });
  f.write(f.outputFile, { data: [] });
  await assert.rejects(checkModelAsync(f.executable, selection, f.options), { code: 'MODEL_UNAVAILABLE' });
  f.write(f.outputFile, { data: null });
  await assert.rejects(checkModelAsync(f.executable, { agent: 'build' }, f.options), { code: 'MODEL_CONFIGURATION_MISSING' });
  f.write(f.outputFile, 'private-test-token');
  await assert.rejects(checkModelAsync(f.executable, selection, f.options), (error: any) => {
    assert.equal(error.code, 'MODEL_CONFIGURATION_UNREADABLE');
    assert(!error.message.includes('private-test-token'));
    return true;
  });
  const calls = fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert(calls.every(call => call.args[0] === '--version' || (call.args[0] === 'api' && call.args[1] === '--standalone')));
});

test('公共预检解析原始认证、读取原生模型目录，返回结果和错误不携带凭据', t => {
  const f = fixture(t);
  assert.deepEqual(f.check(), { model: 'test/model' });
  f.write(f.modelsFile, 'plugin ready\n{"level":"info"}\ntest/other\n');
  assert.throws(f.check, (error: any) => error.code === 'MODEL_UNAVAILABLE' && /模型目录/.test(error.message) && !error.message.includes('local-test-key'));
  const calls = fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert(calls.some(call => call.args[0] === 'models' && call.offline === '1' && call.cwd === fs.realpathSync(f.cwd)));
  assert(calls.every(call => !call.args.includes('run') && !call.args.includes('--refresh')));
});

test('1.x 自定义模型未出现在 CLI 目录时仍通过同步和异步检查，不改模型 ID', async t => {
  const config = { provider: { test: { ...raw('custom-key').provider.test, models: { model: { name: '展示名称', options: { baseURL: 'https://custom.test/v1' } } } } } };
  const f = fixture(t, config);
  f.write(f.modelsFile, 'test/other\n');
  assert.deepEqual(f.check(), { model: 'test/model' });
  assert.deepEqual(await checkModelAsync(f.executable, selection, f.options), { model: 'test/model' });
  const calls = fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert(calls.every(call => !['models', 'run', 'api'].includes(call.args[0])));
  assert.throws(() => f.check({ ...selection, model: 'test/missing' }), /模型目录/);
});

test('显式自定义模型仍检查认证、禁用状态与模型黑白名单，拒绝无效声明', t => {
  const f = fixture(t);
  const custom = () => ({ provider: { test: { ...raw('private-key').provider.test, models: { model: {} } } } });
  f.write(f.modelsFile, 'test/other\n');
  const base = custom();
  for (const config of [
    { ...base, disabled_providers: ['test'] }, { ...base, enabled_providers: ['other'] },
    { provider: { test: { ...base.provider.test, blacklist: ['model'] } } },
    { provider: { test: { ...base.provider.test, whitelist: ['other'] } } },
    { provider: { test: { ...base.provider.test, options: { baseURL: 'https://custom.test/v1' } } } },
    { provider: { test: { ...base.provider.test, options: { apiKey: '' } } } },
    { provider: { test: { ...base.provider.test, models: { model: null } } } },
    { provider: { test: { ...base.provider.test, models: { model: { options: { headers: { Authorization: '' } } } } } } },
  ]) {
    f.write(f.outputFile, config);
    assert.throws(f.check, (error: unknown) => error instanceof Error && 'code' in error && error.code === 'MODEL_UNAVAILABLE' && !error.message.includes('private-key'));
  }
  f.write(f.outputFile, { provider: { test: { ...base.provider.test, whitelist: ['model'] } } });
  assert.deepEqual(f.check(), { model: 'test/model' });
});

test('2.x 自定义模型以原生 enabled 目录为准，绝不回退 1.x 声明或 models 命令', async t => {
  const f = fixture(t, { data: [{ providerID: 'test', id: 'model', enabled: true }] });
  f.env.FIXTURE_VERSION = '2.1.4';
  f.write(f.configFile, { provider: { test: { ...raw('private-key').provider.test, models: { model: {} } } } });
  f.write(f.modelsFile, 'test/other\n');
  assert.deepEqual(f.check(), { model: 'test/model' });
  assert.deepEqual(await checkModelAsync(f.executable, selection, f.options), { model: 'test/model' });
  for (const data of [[], [{ providerID: 'test', id: 'model', enabled: false }]]) {
    f.write(f.outputFile, { data });
    assert.throws(f.check, { code: 'MODEL_UNAVAILABLE' });
    await assert.rejects(checkModelAsync(f.executable, selection, f.options), { code: 'MODEL_UNAVAILABLE' });
  }
  const calls = fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert(calls.every(call => call.args[0] === '--version' || (call.args.join(' ') === 'api --standalone model.list')));
});

test('执行前异步检查不阻塞常驻客户端，可取消正在读取的模型目录', { timeout: 10000 }, async t => {
  const f = fixture(t);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 10);
  try {
    assert.deepEqual(await checkModelAsync(f.executable, selection, { cwd: f.cwd, temporaryRoot: f.root, env: { ...process.env, ...f.env, FIXTURE_MODELS_DELAY: '300' } }), { model: 'test/model' });
    assert(ticks > 0);
  } finally { clearInterval(timer); }
  assert(!fs.readdirSync(f.root).some(name => name.startsWith('insight-opencode-model-')));
  f.write(f.callsFile, '');
  const controller = new AbortController();
  const pending = checkModelAsync(f.executable, selection, { cwd: f.cwd, temporaryRoot: f.root, env: { ...process.env, ...f.env, FIXTURE_MODELS_DELAY: '4000' }, signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  try {
    let started = false;
    for (let i = 0; i < 100 && !started; i++) {
      started = fs.readFileSync(f.callsFile, 'utf8').split('\n').some(line => line && JSON.parse(line).args[0] === 'models');
      if (!started) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert(started, '模型目录读取已开始');
  } finally { controller.abort(); await rejected; }
  assert(!fs.readdirSync(f.root).some(name => name.startsWith('insight-opencode-model-')));
});

test('显式模型、Agent 默认模型、全局默认模型按优先级选择，缺失或禁用时拒绝', t => {
  const f = fixture(t, { ...raw('key'), model: 'test/other', agent: { custom: { model: 'test/model' } } });
  assert.equal(f.check().model, 'test/model');
  assert.equal(f.check({ agent: 'custom', model: '', trigger: false }).model, 'test/model');
  assert.equal(f.check({ ...selection, model: '' }).model, 'test/other');
  for (const config of [
    { ...raw('key'), disabled_providers: ['test'] }, { ...raw('key'), enabled_providers: ['other'] },
    { ...raw('key'), agent: { build: { disable: true } } },
  ]) { f.write(f.outputFile, config); assert.throws(f.check, { code: 'MODEL_UNAVAILABLE' }); }
  for (const config of [{ provider: {} }, { ...raw('key'), model: 'invalid' }]) {
    f.write(f.outputFile, config); assert.throws(() => f.check({ ...selection, model: '' }), { code: 'MODEL_UNAVAILABLE' });
  }
  f.write(f.outputFile, raw('key'));
  assert.throws(() => f.check({ ...selection, agent: 'missing' }), /Agent/);
});

test('只验证所选连接，不要求未选 Provider 或 MCP 的脱敏凭据可恢复', t => {
  const f = fixture(t, { ...raw('key'), provider: { test: { ...raw('key').provider.test, models: { unused: { options: { apiKey: '***' } } } }, unused: { options: { apiKey: '***' } } }, mcp: { unused: { headers: { Authorization: '***' } } } });
  assert.equal(f.check().model, 'test/model');
});

test('错误 endpoint、空 Key、未展开引用和无效认证请求头在预检阶段失败且脱敏', t => {
  const f = fixture(t, raw('key'));
  const invalid = [
    { baseURL: 'not-a-url' }, { baseURL: 'file:///secret-path' }, { baseURL: '{env:MISSING}' },
    { baseURL: 'https://user:secret-password@example.test' }, { apiKey: '' }, { apiKey: '{env:MISSING}' },
    { headers: { Authorization: '' } }, { headers: { Authorization: '{file:/secret-path}' } },
  ];
  for (const options of invalid) {
    const config = raw('secret-key'); Object.assign(config.provider.test.options, options); f.write(f.outputFile, config);
    assert.throws(f.check, (error: any) => error.code === 'MODEL_UNAVAILABLE' && !/secret-key|secret-password|secret-path/.test(error.message));
  }
});

test('认证存储、环境变量、认证头及本地免密连接使用同一检查，OAuth 不强制 API Key', t => {
  const config = { provider: { test: { options: { baseURL: 'https://example.test/v1' } } } };
  const f = fixture(t, config);
  assert.throws(f.check, /认证配置/);
  f.env.TEST_API_KEY = 'env-key'; assert.equal(f.check().model, 'test/model'); delete f.env.TEST_API_KEY;
  f.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ test: { type: 'oauth', refresh: 'refresh-token', access: '' } });
  assert.equal(f.check().model, 'test/model');
  f.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ test: { type: 'api', key: '' } }); assert.throws(f.check, /认证记录/);
  delete f.env.OPENCODE_AUTH_CONTENT;
  f.write(f.outputFile, { provider: { test: { options: { baseURL: 'http://[::1]:8000/v1' } } } });
  assert.equal(f.check().model, 'test/model');
  f.write(f.outputFile, { provider: { test: { options: { headers: { 'x-api-key': 'header-key' } } } } });
  assert.equal(f.check().model, 'test/model');
});

test('原生内置 Provider 可由原生目录确认，不要求出现在自定义 provider 配置中', t => {
  const f = fixture(t, { provider: {}, model: 'native/model' });
  f.write(f.modelsFile, 'native/model\n');
  assert.equal(f.check({ ...selection, model: '' }).model, 'native/model');
});

test('普通、Skill 和 Benchmark 的环境适配器复用公共检查；执行前同样拦截无效模型', async t => {
  const f = fixture(t);
  const priorPath = process.env.PATH, priorHome = process.env.AGENT_INSIGHT_HOME;
  process.env.PATH = `${f.root}:${priorPath || ''}`; process.env.AGENT_INSIGHT_HOME = f.root;
  t.after(() => { process.env.PATH = priorPath; if (priorHome === undefined) delete process.env.AGENT_INSIGHT_HOME; else process.env.AGENT_INSIGHT_HOME = priorHome; });
  const { createServices } = require('../services/executor/src/environment/services.cjs');
  const { loadEnvironmentAdapter } = require('../services/executor/src/environment/registry.cjs');
  f.write(path.join(f.root, 'dependencies/xgovernor/setup.json'), { context: { home: '/unused-sandbox-home', XDG_CONFIG_HOME: '/unused-sandbox-config', XDG_DATA_HOME: '/unused-sandbox-data' } });
  const services = createServices({ cfg: { workspaceBase: f.cwd }, env: f.env, client: { probeExperimentRuntime: () => ({ ready: true, canResolveTraceId: true }) } });
  for (const mode of ['generate', 'skill-ab', 'trigger']) {
    const context = { platform: 'opencode', agent: 'build', model: 'test/model', experiment: { mode }, dataset: { adapterKey: 'generic' } };
    assert.deepEqual(await services.checkAgent(context), []);
    f.write(f.outputFile, { provider: { test: { ...raw('private-key').provider.test, models: { model: {} } } } });
    f.write(f.modelsFile, 'test/other\n');
    for (const adapter of ['generic', 'swe-bench', 'zsoft-l1']) {
      const result = await loadEnvironmentAdapter(adapter).checkEnvironment(context, { ...services, executionBinding: () => null, checkZsoftSource: async () => [] });
      assert.deepEqual(result.issues, []);
    }
    f.write(f.outputFile, masked);
    for (const adapter of ['generic', 'swe-bench', 'zsoft-l1']) {
      const result = await loadEnvironmentAdapter(adapter).checkEnvironment(context, { ...services, executionBinding: () => null, checkZsoftSource: async () => [] });
      assert.equal(result.issues[0].code, 'MODEL_UNAVAILABLE');
    }
    f.write(f.modelsFile, 'test/model\n');
  }
  f.write(f.modelsFile, 'test/other\n');
  const client = require('../scripts/reliability-client.cjs');
  const previous = Object.fromEntries(Object.keys(f.env).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(f.env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try {
  for (const skillExecution of [undefined, { version: 1, skill: null }]) {
    await assert.rejects(client.runExperimentCase({ clientId: 'test', workspaceBase: f.cwd }, { platform: 'opencode', agent: 'build', model: 'test/model', input: 'test', skillExecution }), (error: any) => error.code === 'MODEL_UNAVAILABLE' && /模型目录/.test(error.message));
  }
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  assert(fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)).every(call => !call.args.includes('run') || call.args.includes('--help')));
});

test('恢复原始 Key、嵌套 headers 和 URL，保留模型、普通 *** 提示词及隔离权限', t => {
  const f = fixture(t);
  const original = { ...raw('test-key'), agent: { build: { prompt: '***' } } };
  Object.assign(original.provider.test.options, { headers: { Authorization: 'Bearer test-auth', 'x-routing': 'region-a' }, proxy: 'https://user:test-password@example.test' });
  f.write(f.configFile, original);
  f.write(f.outputFile, { ...masked, agent: original.agent, provider: { test: { ...masked.provider.test, options: {
    ...masked.provider.test.options, headers: { Authorization: '***', 'x-routing': '***' }, proxy: '***',
  } } } });
  const config = f.run();
  assert.deepEqual(config.provider, original.provider);
  assert.equal(config.agent.build.prompt, '***');
  const prepared = prepare('unused', { platform: 'opencode', agent: 'build', model: 'test/model',
    skillExecution: { version: 2, mode: 'trigger', skills: [{ name: 'test-skill', version: 1, files: { 'SKILL.md': 'test' } }] } }, config);
  try {
    const saved = JSON.parse(fs.readFileSync(prepared.env.OPENCODE_CONFIG, 'utf8'));
    assert.equal(saved.provider.test.options.apiKey, 'test-key');
    assert.equal(saved.permission.bash, 'deny');
    assert.equal(saved.model, 'test/model');
    assert.notEqual(prepared.env.HOME, f.home);
    assert.equal(prepared.env.OPENCODE_TEST_HOME, prepared.env.HOME);
    if (process.platform !== 'win32') assert.equal(fs.statSync(prepared.env.OPENCODE_CONFIG).mode & 0o777, 0o600);
  } finally { prepared.cleanup(); }
});

test('使用 JSONC，支持注释、尾逗号和含注释符的字符串，拒绝损坏或污染对象', () => {
  assert.deepEqual(parseJsonc('// hi\n{"url":"https://host/a//b/*c*/",/*x*/"items":["x,}",],}'), { url: 'https://host/a//b/*c*/', items: ['x,}'] });
  for (const s of ['{"key":}', '{/*', '{"a":"secret"', '{"__proto__":{"polluted":true}}']) assert.throws(() => parseJsonc(s), /配置|注释/);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test('配置覆盖顺序：global < custom < project < .opencode < config-dir < inline < managed', t => {
  const f = fixture(t);
  const writeKey = (p: string, k: string) => f.write(p, raw(k));
  writeKey(f.configFile + 'c', 'global-jsonc');
  assert.equal(f.run().provider.test.options.apiKey, 'global-jsonc');
  f.env.OPENCODE_CONFIG = path.join(f.root, 'custom.json'); writeKey(f.env.OPENCODE_CONFIG, 'custom');
  assert.equal(f.run().provider.test.options.apiKey, 'custom');
  writeKey(path.join(f.root, 'project', 'opencode.json'), 'parent-project');
  writeKey(path.join(f.cwd, 'opencode.json'), 'project-json'); writeKey(path.join(f.cwd, 'opencode.jsonc'), 'project-jsonc');
  assert.equal(f.run().provider.test.options.apiKey, 'project-jsonc');
  writeKey(path.join(f.cwd, '.opencode', 'opencode.json'), 'local-dot');
  writeKey(path.join(f.root, 'project', '.opencode', 'opencode.json'), 'parent-dot');
  assert.equal(f.run().provider.test.options.apiKey, 'parent-dot');
  writeKey(path.join(f.home, '.opencode', 'opencode.json'), 'home-dot');
  assert.equal(f.run().provider.test.options.apiKey, 'home-dot');
  f.env.OPENCODE_CONFIG_DIR = path.join(f.root, 'custom-dir'); writeKey(path.join(f.env.OPENCODE_CONFIG_DIR, 'opencode.json'), 'config-dir');
  assert.equal(f.run().provider.test.options.apiKey, 'config-dir');
  f.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(raw('inline'));
  assert.equal(f.run().provider.test.options.apiKey, 'inline');
  writeKey(path.join(f.env.OPENCODE_TEST_MANAGED_CONFIG_DIR!, 'opencode.json'), 'managed');
  assert.equal(f.run().provider.test.options.apiKey, 'managed');
});

test('项目搜索不越过 git 边界，禁用项目配置时保留用户 .opencode', t => {
  const f = fixture(t);
  f.write(path.join(f.root, 'opencode.json'), raw('outside-git'));
  assert.equal(f.run().provider.test.options.apiKey, 'local-test-key');
  f.write(path.join(f.cwd, 'opencode.json'), raw('project'));
  f.env.OPENCODE_DISABLE_PROJECT_CONFIG = 'true';
  assert.equal(f.run().provider.test.options.apiKey, 'local-test-key');
  f.write(path.join(f.home, '.opencode', 'opencode.json'), raw('home-dot'));
  assert.equal(f.run().provider.test.options.apiKey, 'home-dot');
});

test('环境与相对文件引用在原始配置目录展开，缺失和空值拒绝且错误不泄漏', t => {
  const f = fixture(t);
  f.env.FIXTURE_SECRET = 'environment-test-value';
  f.write(f.configFile, raw('{env:FIXTURE_SECRET}'));
  assert.equal(f.run().provider.test.options.apiKey, f.env.FIXTURE_SECRET);
  f.write(path.join(path.dirname(f.configFile), 'key.txt'), 'file-test-value\n');
  f.write(f.configFile, raw('{file:key.txt}'));
  assert.equal(f.run().provider.test.options.apiKey, 'file-test-value');
  f.write(path.join(f.home, 'home-key'), 'home-test-value');
  f.write(f.configFile, raw('{file:~/home-key}'));
  assert.equal(f.run().provider.test.options.apiKey, 'home-test-value');
  for (const key of ['{file:missing}', '{env:MISSING_TEST_SECRET}', '***']) {
    f.write(f.configFile, raw(key));
    assert.throws(f.run, (e: any) => e.code === 'MODEL_UNAVAILABLE' && !e.message.includes('environment-test-value'));
  }
});

test('读取期间凭据变化重新读取一次；持续变化拒绝混用快照', t => {
  const f = fixture(t);
  f.write(f.changeFile, `require('node:fs').writeFileSync(${JSON.stringify(f.configFile)}, ${JSON.stringify(JSON.stringify(raw('updated-key')))});`);
  assert.equal(f.run().provider.test.options.apiKey, 'updated-key');
  f.write(f.changeFile, `require('node:fs').writeFileSync(${JSON.stringify(f.configFile)}, JSON.stringify({provider:{test:{options:{apiKey:String(Date.now())}}}}));`);
  assert.throws(f.run, /读取期间配置发生变化/);
});

test('远程组织、未知版本及无法确认的账号状态拒绝凭据恢复', t => {
  const f = fixture(t);
  f.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ 'https://organization.test': { type: 'wellknown', key: 'ENV', token: 'remote-secret' } });
  assert.throws(f.run, /远程组织/);
  delete f.env.OPENCODE_AUTH_CONTENT;
  f.env.FIXTURE_VERSION = '9.0.0'; assert.throws(f.run, /版本/);
  f.env.FIXTURE_VERSION = '1.18.35'; assert.equal(f.run().provider.test.options.apiKey, 'local-test-key');
  f.write(path.join(f.env.XDG_DATA_HOME!, 'opencode', 'opencode.db'), 'fixture');
  f.env.FIXTURE_DB = '[{"active_orgs":1}]'; assert.throws(f.run, /远程账号组织/);
  f.env.FIXTURE_DB = '{}'; assert.throws(f.run, /远程账号组织/);
  f.env.FIXTURE_DB = 'broken'; assert.throws(f.run, /无法确认/);
});

test('端点不一致不能仅按供应商名称恢复 Key，找不到原始字段时拒绝', t => {
  const f = fixture(t);
  f.write(f.configFile, { provider: { test: { options: { apiKey: 'secret-must-not-leak', baseURL: 'https://other.test/v1' } } } });
  assert.throws(f.run, (e: any) => /不一致/.test(e.message) && !e.message.includes('secret-must-not-leak'));
  f.write(f.configFile, { provider: {} }); assert.throws(f.run, /无法恢复脱敏/);
});

test('原本没有显式 Key 时保留原生认证，不从其他来源注入 Key', t => {
  const f = fixture(t, { provider: { test: { options: { baseURL: 'https://example.test/v1' } } } });
  assert.equal(f.run().provider.test.options.apiKey, undefined);
  f.write(f.outputFile, raw('unmasked-test-key'));
  f.env.FIXTURE_VERSION = 'old';
  assert.equal(f.run().provider.test.options.apiKey, 'unmasked-test-key');
});

test('触发分析禁用 MCP；用例分析恢复 MCP 请求头', t => {
  const f = fixture(t, { ...masked, mcp: { service: { type: 'remote', url: 'https://example.test/mcp', headers: { Authorization: '***' } } } });
  f.write(f.configFile, { ...raw('local-test-key'), mcp: { service: { type: 'remote', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer mcp-test-key' } } } });
  assert.deepEqual(f.run().mcp, {});
  assert.equal(f.run({ ...selection, trigger: false }).mcp.service.headers.Authorization, 'Bearer mcp-test-key');
  f.write(f.configFile, { ...raw('local-test-key'), mcp: { service: { type: 'remote', url: 'https://other.test/mcp', headers: { Authorization: 'Bearer mcp-test-key' } } } });
  assert.throws(() => f.run({ ...selection, trigger: false }), /不一致/);
});

test('非法 inline 配置和命令失败均返回安全错误并清理私有输出文件', t => {
  const f = fixture(t);
  for (const value of ['null', '[]', '{"providers":{}}']) {
    f.env.OPENCODE_CONFIG_CONTENT = value;
    assert.throws(f.run, (e: any) => e.code === 'MODEL_UNAVAILABLE');
  }
  delete f.env.OPENCODE_CONFIG_CONTENT;
  const outputPath = path.join(f.root, 'private-output-path');
  if (process.platform === 'linux') f.write(f.changeFile, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(outputPath)},fs.readlinkSync('/proc/self/fd/1'));`);
  f.env.FIXTURE_EXIT = '1';
  assert.throws(f.run, (e: any) => e.code === 'MODEL_UNAVAILABLE' && !e.message.includes('local-test-key'));
  if (process.platform === 'linux') assert.equal(fs.existsSync(path.dirname(fs.readFileSync(outputPath, 'utf8'))), false);
});

test('大输出、前置文本和独立 JSON 日志兼容；损坏输出安全失败', t => {
  const f = fixture(t);
  const config = { ...masked, agent: { build: { prompt: '中文'.repeat(140000) } } };
  f.write(f.outputFile, '[plugin] ready\n{"level":"info"}\n' + JSON.stringify(config));
  assert.equal(f.run().provider.test.options.apiKey, 'local-test-key');
  for (const value of ['{"provider":', JSON.stringify(masked) + '\ntrailing', '[' + JSON.stringify(masked) + ']', JSON.stringify(masked) + JSON.stringify(masked), Buffer.from([0xff])]) {
    f.write(f.outputFile, value);
    assert.throws(f.run, (e: any) => e.code === 'MODEL_UNAVAILABLE' && !e.message.includes('local-test-key'));
  }
  f.write(f.outputFile, 'x'.repeat(8 * 1024 * 1024 + 1)); assert.throws(f.run, /8 MiB/);
});

test('不能向工作区直接注入脱敏配置', () => {
  assert.throws(() => prepare('unused', { platform: 'opencode', agent: 'build', model: 'test/model', skillExecution: { version: 1, skill: null } }, masked), /未恢复/);
});

test('生成的隔离配置真正发送原始测试认证头，恢复失败不发送请求', async t => {
  const f = fixture(t);
  const received: string[] = [];
  const server = createServer((req, res) => { received.push(String(req.headers.authorization)); res.end('{}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const config = f.run();
  config.provider.test.options.baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const prepared = prepare('unused', { platform: 'opencode', agent: 'build', model: 'test/model', skillExecution: { version: 1, skill: null } }, config);
  try {
    const child = spawn(process.execPath, ['-e', `const c=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);fetch(c.provider.test.options.baseURL,{headers:{Authorization:'Bearer '+c.provider.test.options.apiKey}}).then(r=>{if(!r.ok)process.exitCode=1})`], { env: { ...process.env, ...prepared.env }, stdio: 'pipe' });
    assert.equal(await new Promise(resolve => child.on('exit', resolve)), 0);
    assert.deepEqual(received, ['Bearer local-test-key']);
    f.write(f.configFile, raw('***')); assert.throws(f.run);
    assert.equal(received.length, 1);
  } finally { prepared.cleanup(); }
});

test('真实 OpenCode 公共预检使用本地目录，合法与非法模型均不请求模型服务', { skip: !process.env.OPENCODE_MODEL_CHECK_CLI, timeout: 60000 }, async t => {
  const f = fixture(t);
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.end('{}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  f.write(f.configFile, { model: 'test/model', provider: { test: {
    npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` },
    models: { model: { name: 'Local model', limit: { context: 16384, output: 128 } } },
  } } });
  const module = path.resolve('scripts/opencode-connection-config.cjs');
  const script = `const assert=require('node:assert/strict'); const {checkOpenCodeModelConfig:check}=require(${JSON.stringify(module)});
const options=${JSON.stringify({ home: f.home, cwd: f.cwd })};
assert.deepEqual(check(process.env.OPENCODE_MODEL_CHECK_CLI,{agent:'build',model:'test/model'},options),{model:'test/model'});
assert.throws(()=>check(process.env.OPENCODE_MODEL_CHECK_CLI,{agent:'build',model:'test/missing'},options),e=>e.code==='MODEL_UNAVAILABLE');
console.log('native static preflight verified');`;
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { cwd: f.cwd, env: {
      NODE_ENV: 'test', PATH: process.env.PATH, ...f.env, OPENCODE_MODEL_CHECK_CLI: process.env.OPENCODE_MODEL_CHECK_CLI,
      OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('native preflight timeout')); }, 50000);
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve({ code, output }); });
  });
  assert.equal(result.code, 0, result.output);
  assert.equal(requests, 0);
});
