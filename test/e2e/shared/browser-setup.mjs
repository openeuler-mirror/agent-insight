import {contextConfig} from './model-config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { writePrivate } from './runtime.mjs';
import {probeModelConnection} from './model-probe.mjs';

export async function loginAndModel(ctx, page) {
  const { baseUrl, runId, root, key, stage, secrets } = ctx;
  const responseFor = (...args) => { const promise = page.waitForResponse(...args);promise.catch(() => {});return promise; };
  const requestFor = (...args) => { const promise = page.waitForRequest(...args);promise.catch(() => {});return promise; };
  const username = ctx.testUsername || `test_e2e_${runId}_${ctx.caseId || "003"}@example.com`;
  let account;
  const api = async (route, init = {}) => {
    const response = await fetch(baseUrl + route, { signal: AbortSignal.timeout(45000), ...init, headers: { 'content-type': 'application/json', 'x-witty-api-key': account.apiKey, ...init.headers } });
    const data = await response.json();
    assert.ok(response.ok, `${route.split('?')[0]} returned ${response.status}`);
    return data;
  };
    await stage('login', '测试邮箱经页面登录，刷新后保持相同身份', async () => {
      await page.goto(baseUrl + '/login');
      await page.locator('input[type=email]').fill(username);
      const loginResponse = responseFor(r => r.url().endsWith('/api/auth/apikey') && r.request().method() === 'POST');
      await page.locator('button[type=submit]').click();
      const response = await loginResponse;
      assert.equal(response.status(), 200);
      account = await response.json();
      assert.equal(account.username, username);
      secrets.push(account.apiKey);
      writePrivate(path.join(root, 'private', 'account.json'), account);
      await page.waitForURL(url => url.pathname !== '/login');
      await page.waitForFunction(expected => localStorage.getItem('user_id') === expected, username);
      const restored = responseFor(r => r.url().endsWith('/api/auth/apikey') && r.request().method() === 'POST');
      await page.reload();
      assert.equal((await restored).status(), 200);
      await page.getByText(username, { exact: true }).waitFor();
      assert.notEqual(new URL(page.url()).pathname, '/login');
      return { username, initialLoginMode: 'standalone', persistedSession: true };
    });
    await stage('model', '页面真实测试并保存 DeepSeek，刷新后配置和默认模型持久化', async () => {
      const modelName = `e2e-model-${runId}`;
      await page.goto(baseUrl + '/modelconfig/registry');
      await page.getByRole('button', { name: /新增模型|New Model/, exact: true }).click();
      const deepseek = page.getByRole('button').filter({ has: page.getByText('DeepSeek (Official)', { exact: true }) });
      await deepseek.click();
      await page.getByPlaceholder(/例如：我的 DeepSeek|e.g. My DeepSeek/).fill(modelName);
      await page.getByPlaceholder('https://api.deepseek.com', { exact: true }).fill(ctx.modelBaseUrl || contextConfig(ctx).model.baseUrl);
      await page.getByPlaceholder('deepseek-v4-flash / gpt-4o / ...', { exact: true }).fill(contextConfig(ctx).model.modelName);
      await page.getByPlaceholder('sk-...', { exact: true }).fill(key);
      const connection=await probeModelConnection(async()=>{
        const connected=responseFor(r=>r.url().endsWith('/api/eval/settings/test')&&r.request().method()==='POST');const saved=responseFor(r=>r.url().endsWith('/api/eval/settings')&&r.request().method()==='POST');
        await page.getByRole('button',{name:/测试连接并保存|Test & Save/,exact:true}).click();const response=await connected;const probe=await response.json();writePrivate(path.join(root,'private/model-probe.json'),probe);return {probe,status:response.status(),saved};
      },{maxAttempts:ctx.caseId==='005'?3:1,onAttempt:attempts=>writePrivate(path.join(root,'private/model-probe-attempts.json'),attempts)});const probe=connection.probe;assert.equal((await connection.saved).status(),200);
      await page.getByRole('article').getByText(modelName, { exact: true }).waitFor();
      const activate=page.getByRole('article').filter({has:page.getByText(modelName,{exact:true})}).getByRole('button',{name:/设为默认|Set default/,exact:true});
      if(await activate.count()){const activated=page.waitForResponse(r=>r.url().endsWith('/api/eval/settings')&&r.request().method()==='POST');await activate.click();assert.equal((await activated).status(),200);}
      await page.reload();
      await page.getByRole('article').getByText(modelName, { exact: true }).waitFor();
      const settings = await api(`/api/eval/settings?user=${encodeURIComponent(username)}`);
      const model = settings.configs.find(c => c.name === modelName);
      assert.equal(model?.model, contextConfig(ctx).model.modelName);
      assert.equal(settings.activeConfigId, model.id);
      assert.ok(!JSON.stringify(settings).includes(key), 'Read API must return masked model key');
      await page.screenshot({ path: path.join(root, 'model.png'), fullPage: true, mask: [page.locator('input'), page.locator('code,pre')] });
      ctx.modelId = model.id;
      return { configId: model.id, model: model.model, activeConfigId: settings.activeConfigId, connection: 'real product probe PASS', elapsedMs: probe.elapsedMs, attempts:connection.attempts, savedAfterReload: true };
    });

  Object.assign(ctx, { account, api, page });
}
