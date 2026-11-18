import {openCodeModelConfig,executionModel} from './model-config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { command, poll, runtimeEnv, writePrivate } from './runtime.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
export async function prepareClients(ctx) {
  const {project, root, api, account, baseUrl, page, secrets, stage} = ctx;
  ctx.children ||= [];
  for (const [kind, version, executable] of [
    ['ordinary', '2.1.4', path.join(project, 'exclude/core-e2e/runtime/v2/node_modules/.bin/opencode')],
    ['ras', '1.14.39', path.join(project, 'node_modules/.bin/opencode')],
  ]) {
    if (ctx.clientKinds && !ctx.clientKinds.includes(kind)) continue;
    await stage(kind === 'ras' ? 'ras-client' : 'ordinary-client', `隔离 OpenCode ${version} 原生组件安装、真实在线归属及模型/任务能力${kind === 'ras' ? '，RAS/FI/ras-judge 预检' : ''}`, async () => {
      const clientRoot = path.join(root, kind);
      const bin = path.join(clientRoot, 'bin');fs.mkdirSync(bin, { recursive: true });
      assert.ok(fs.existsSync(executable), `Required OpenCode ${version} is not installed`);
      fs.symlinkSync(executable, path.join(bin, 'opencode'));
      fs.symlinkSync(process.execPath, path.join(bin, 'node'));
      fs.symlinkSync(process.env.E2E_PYTHON || '/opt/homebrew/bin/python3', path.join(bin, 'python3'));
      const env = runtimeEnv(clientRoot, bin);
      if(process.env.E2E_PYTHON)env.RAS_PYTHON=process.env.E2E_PYTHON;
      if(process.env.E2E_NPM_OFFLINE==='1'){env.npm_config_offline='true';env.npm_config_cache=path.join(project,'exclude/core-e2e/cache/npm');}
      env.AGENT_INSIGHT_HOST = baseUrl;env.AGENT_INSIGHT_API_KEY = account.apiKey;
      env.AGENT_INSIGHT_CLIENT_SOURCE = 'local';
      env.PIP_CACHE_DIR = path.join(project, 'exclude/core-e2e/cache/pip');
      env.OPENCODE_DISABLE_MODELS_FETCH = 'true';
      if(ctx.selectedCase==='005')env.AGENT_INSIGHT_FI_CWD=ctx.agentWorkspaceRoot;
      if(kind==='ras'){
        const configured=await command('npm',['config','get','registry'],{cwd:project,timeout:15000});assert.equal(configured.code,0);
        const registry=new URL(process.env.E2E_NPM_REGISTRY||configured.output.trim());assert.equal(registry.protocol,'https:');assert.ok(!registry.username&&!registry.password,'Registry credentials must not enter runtime metadata');
        ctx.npmRegistry=registry.href;env.npm_config_registry=ctx.npmRegistry;env.npm_config_cache=path.join(project,'exclude/core-e2e/cache/npm');
      }
      const log = path.join(root, 'private', `${kind}-install.log`);
      const versionProbe = await command('opencode', ['--version'], { env, timeout: 15000 });
      assert.equal(versionProbe.code, 0);assert.ok(versionProbe.output.includes(version));
      await page.goto(baseUrl + '/accessconfig/install');
      const code = page.locator('code').filter({ hasText: /^curl -sSf/ });
      await code.waitFor();
      const installCommand = await code.textContent();
      const urlMatch = installCommand.match(/curl -sSf "([^"]+)" \| bash/);
      assert.ok(urlMatch, 'Install page did not produce a supported command');
      const setupUrl = new URL(urlMatch[1]);
      assert.equal(setupUrl.origin, baseUrl);assert.equal(setupUrl.searchParams.get('key'), account.apiKey);assert.equal(setupUrl.searchParams.get('frameworks'), 'opencode');
      const response = await fetch(setupUrl);assert.ok(response.ok);
      const setup = await response.text();
      assert.ok(setup.includes('install_agent_insight_client'));
      const configRoot = path.join(env.XDG_CONFIG_HOME, 'opencode');
      fs.mkdirSync(path.join(configRoot, 'plugins'), { recursive: true });
      fs.mkdirSync(path.join(configRoot, 'commands'), { recursive: true });
      const artifacts = {};
      for (const [route, dest] of [
        [`/api/ingest/setup/opencode${kind === 'ordinary' ? '?apiVersion=2' : ''}`, path.join(configRoot, 'plugins/Witty-Skill-Insight.ts')],
        ['/api/ingest/setup/opencode-uploader', path.join(env.AGENT_INSIGHT_HOME, 'opencode_uploader_client.js')],
        ['/api/ingest/setup/opencode-commands/si-optimizer', path.join(configRoot, 'commands/si-optimizer.md')],
      ]) {
        const r = await fetch(baseUrl + route, { headers: { 'x-witty-api-key': account.apiKey } });assert.ok(r.ok, `Component ${route} unavailable`);
        const data = await r.text();fs.writeFileSync(dest, data);artifacts[route] = sha(data);
      }
      writePrivate(path.join(env.AGENT_INSIGHT_HOME, '.env'), `AGENT_INSIGHT_HOST=${baseUrl}\nAGENT_INSIGHT_API_KEY=${account.apiKey}\n`);
      const model=executionModel(ctx),modelConfig=openCodeModelConfig(ctx);
      modelConfig.agent={'ras-judge':{mode:'subagent',hidden:true,model,description:'Dedicated RAS judge using configured test model'}};
      writePrivate(path.join(configRoot, 'opencode.json'), modelConfig);
      const install = await command(process.execPath, ['-e', `const i=require('./scripts/install-ras-client.js');i.installRuntime();if(!i.installFaultInjection())process.exit(1);`], { env, cwd: project, log, timeout: 300000 });
      assert.equal(install.code, 0, `Native client/FI installation failed; see private/${kind}-install.log`);
      if(kind==='ras'){
        const prepared=process.env.E2E_PREPARED_PLUGIN_DIR;
        if(prepared){for(const name of ['package.json','package-lock.json','node_modules'])fs.cpSync(path.join(prepared,name),path.join(configRoot,name),{recursive:true,verbatimSymlinks:true});}
        const dependencies=prepared?{code:0}:await command('npm',['install','--prefix',configRoot,`@opencode-ai/plugin@${version}`,'--save-exact','--ignore-scripts','--no-audit','--no-fund'],{env:{...env,PATH:bin+path.delimiter+process.env.PATH},cwd:clientRoot,log:path.join(root,'private/ras-plugin-dependencies.log'),timeout:180000});
        assert.equal(dependencies.code,0,'OpenCode plugin runtime dependencies failed to install');
        assert.equal(JSON.parse(fs.readFileSync(path.join(configRoot,'node_modules/@opencode-ai/plugin/package.json'))).version,version);
      }
      let rasCheck = null;
      let ffi = null;
      if (kind === 'ras') {
        const ras = await command(process.execPath, ['-e', `const i=require('./scripts/install-ras.js');const r=i.installRas({platforms:['opencode']});console.log(JSON.stringify(r));if(!['ready','installed'].includes(r.status))process.exit(1)`], { env, cwd: project, log, timeout: 300000 });
        assert.equal(ras.code, 0, 'RAS component installation failed; see private/ras-install.log');
        const check = await command(process.execPath, ['-e', `console.log(JSON.stringify(require('./scripts/install-ras.js').checkRasInstallation({platforms:['opencode']})))`], { env, cwd: project, timeout: 30000 });
        rasCheck = JSON.parse(check.output.trim());
        assert.ok(['ready', 'already current'].includes(rasCheck.status), 'RAS installation is not current');
        const conf = JSON.parse(fs.readFileSync(path.join(configRoot, 'opencode.json')));
        assert.equal(conf.agent['ras-judge'].model, model);
        assert.ok(conf.plugin.includes('./plugins/agent-insight-ras.js'));
        const probe = await command('opencode', [path.join(project, 'test/e2e/shared/ras-probe.mjs')], { env: { ...env, BUN_BE_BUN: '1' }, cwd: clientRoot, log, timeout: 30000 });
        assert.equal(probe.code, 0, 'Real embedded Python/RAS hello probe failed');
        ffi = probe.output.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).find(x => x.inProcessPython);
        assert.ok(ffi?.hello, 'Missing RAS bridge handshake');
      }
      const token = await api('/api/reliability/install-tokens', { method: 'POST', body: JSON.stringify({ expiresInSeconds: 600 }) });
      secrets.push(token.installToken);
      const registered = await api('/api/reliability/client/v1/register', { method: 'POST', body: JSON.stringify({ installToken: token.installToken, client: { name: `e2e-${ctx.runId}-${kind}`, hostname: `e2e-${kind}`, os: process.platform, arch: process.arch, agentVersion: '1.0.0', supervisor: 'manual', machineId: sha(clientRoot) }, capabilities: { platforms: [], actions: [] } }) });
      assert.ok(registered.clientId && registered.deviceCredential);
      secrets.push(registered.deviceCredential);
      const configFile = path.join(env.AGENT_INSIGHT_HOME, 'client/config.json');
      const config = JSON.parse(fs.readFileSync(configFile));
      writePrivate(configFile, { ...config, ...(ctx.selectedCase==='005'?{fiCwd:ctx.agentWorkspaceRoot,workspaceBase:ctx.agentWorkspaceRoot}:{}), insightBaseUrl: baseUrl, user: account.username, clientId: registered.clientId, deviceCredential: registered.deviceCredential, websocketUrl: registered.control?.websocketUrl || '', pollUrl: registered.control?.pollUrl || '', maxParallelFi: 1 });
      const fd = fs.openSync(path.join(root, 'private', `${kind}-client.log`), 'a', 0o600);
      const child = spawn(process.execPath, [path.join(env.AGENT_INSIGHT_HOME, 'client/runtime/reliability-client.cjs')], { env, cwd: clientRoot, detached: true, stdio: ['ignore', fd, fd] });fs.closeSync(fd);
      ctx.children.push(child);
      const online = await poll(async () => (await api(`/api/reliability/clients?user=${encodeURIComponent(account.username)}`)).items.find(c => c.id === registered.clientId), c => c?.status === 'online' && c.platforms?.some(p => p.id === 'opencode' && p.runExperimentCase?.ready && p.models?.includes(model)), 300000);
      const capability = online.platforms.find(p => p.id === 'opencode');
      assert.equal(capability.version, version);
      assert.equal(online.faultInjection?.ready, true);
      const marker = `CLIENT-READY-${ctx.runId}-${kind}`;
      const args = ['run', ...(kind === 'ordinary' ? ['--standalone', '--auto'] : []), '--model', model, '--agent', 'build', '--format', 'json', '--title', `E2E preparation ${kind}`, `请只回复 ${marker}`];
      const native = await command('opencode', args, { env: { ...env, RAS_DEBUG: kind === 'ras' ? '1' : '0' }, cwd: ctx.selectedCase==='005'?ctx.agentWorkspaceRoot:clientRoot, log: path.join(root, 'private', `${kind}-native.log`), timeout: 180000 });
      assert.equal(native.code, 0, `OpenCode ${version} could not finish the real model probe`);
      const events = native.output.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const answered = events.find(e => e.type === 'text' && e.part?.text?.includes(marker));
      assert.ok(answered, 'Native model probe did not return the required assistant text');
      const nativeSessionId = answered.sessionID || answered.sessionId;
      assert.ok(nativeSessionId, 'Native probe did not expose a session ID');
      await page.goto(baseUrl + '/accessconfig/client');
      await page.getByPlaceholder(/搜索 IP \/ 主机名|Search IP \/ hostname/).fill(registered.clientId);
      await page.getByText(new RegExp(`^${registered.clientId} ·`)).waitFor({ timeout: 45000 });
      await page.reload();
      await page.getByPlaceholder(/搜索 IP \/ 主机名|Search IP \/ hostname/).fill(registered.clientId);
      await page.getByText(new RegExp(`^${registered.clientId} ·`)).waitFor();
      await page.screenshot({ path: path.join(root, `${kind}-client.png`), fullPage: true, mask: [page.locator('input,textarea,code,pre')] });
      const result = { clientId: registered.clientId, version, model, status: online.status, capability, faultInjection: online.faultInjection, nativeSessionId, nativeModelProbe: 'PASS', ras: rasCheck ? { status: rasCheck.status, platforms: rasCheck.platforms, ffi } : 'not enabled on v2', setupHash: sha(setup), artifacts, configurationHash: sha(fs.readFileSync(path.join(configRoot, 'opencode.json'))), home: clientRoot, supervision: 'real foreground client; global launchd/systemd registration excluded' };
      ctx.clients ||= [];ctx.clients.push(result);return result;
    });
  }
}

export async function prepareFixtures(ctx) {
  await ctx.stage('fixtures', '后续四例的测试账号与日志文件、003 的内置参考资源就绪，不执行业务场景', async () => {
    const data = fs.readFileSync(path.join(ctx.project, 'public/example/messages'));
    assert.equal(sha(data), '6d50cefa82380651f910df35fda0995a237a3c788b7b2e3d2d37e51fb9debca9');
    const resources = [];
    for (let i = 2; i <= 5; i++) {
      const username = ctx.testUsername || `test_e2e_${ctx.runId}_00${i}@example.com`;
      const r = await fetch(ctx.baseUrl + '/api/auth/apikey', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username }) });assert.ok(r.ok);
      const account = await r.json();ctx.secrets.push(account.apiKey);
      writePrivate(path.join(ctx.root, 'private', `account-00${i}.json`), account);
      const root = path.join(ctx.root, `fixture-00${i}`);fs.mkdirSync(path.join(root, 'fixtures'), { recursive: true });
      fs.writeFileSync(path.join(root, 'fixtures/messages'), data);
      let builtin = null;
      if (i === 3) {
        const response = await fetch(ctx.baseUrl + `/api/agent-datasets?user=${encodeURIComponent(username)}`, { headers: { 'x-witty-api-key': account.apiKey } });assert.ok(response.ok);
        const datasets = await response.json();const selected = datasets.find(d => d.name === 'messages 日志分析（内置示例）');assert.ok(selected, 'Builtin dataset missing');
        const cases = typeof selected.casesJson === 'string' ? JSON.parse(selected.casesJson) : selected.cases;
        const fixed = cases.find(c => c.id === '951e0e4b-3eed-4d24-b1e6-83b0fb782be4');assert.ok(fixed, 'Builtin case missing');
        assert.equal(fixed.input, '请分析如下 messages 日志：~/.agent-insight/example/messages。针对 root 账户的 SSH 爆破有多严重？都来自哪些来源 IP？');
        const dest = path.join(root, 'host/.agent-insight/example/messages');fs.mkdirSync(path.dirname(dest), { recursive: true });fs.writeFileSync(dest, data);
        const skillsResponse = await fetch(ctx.baseUrl + `/api/skills?user=${encodeURIComponent(username)}`, { headers: { 'x-witty-api-key': account.apiKey } });assert.ok(skillsResponse.ok);
        const skills = await skillsResponse.json();const skill = skills.find(s => s.name === 'linux-messages-auth-triage-demo');assert.ok(skill?.versions?.some(v => v.version === 0), 'Builtin Skill v0 missing');
        builtin = { datasetId: selected.id, caseId: fixed.id, caseHash: sha(JSON.stringify(fixed)), skill: skill.name, skillVersion: 0, executionPath: dest };
      }
      resources.push({ caseId: `00${i}`, username, sourceHash: sha(data), builtin });
    }
    return resources;
  });
}
