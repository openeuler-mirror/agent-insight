import {openCodeModelConfig,executionModel,contextConfig} from '../../shared/model-config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { command, poll, runtimeEnv, writePrivate } from '../../shared/runtime.mjs';
import { assertTraceEvidence } from './trace-evidence.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export async function scenario002(ctx) {
  const {project, root, runId, baseUrl, stage, secrets} = ctx;
  let account, env, workspace, native, record, session, evidence, browser, context, page;
  const marker = `E2E-${runId}-002`;
  const username = ctx.testUsername || `test_e2e_${runId}_002@example.com`;
  const data = fs.readFileSync(path.join(project, 'public/example/messages'));
  const lines = data.toString().trimEnd().split('\n');
  const expected = { username, marker, file: 'fixtures/messages', firstLine: lines[0], lineCount: lines.length, modelName: contextConfig(ctx).model.modelName };
  let prompt;
  const api = async (route, init = {}, allowMissing = false) => {
    const response = await fetch(baseUrl + route, { signal: AbortSignal.timeout(30000), ...init, headers: { 'content-type': 'application/json', 'x-witty-api-key': account?.apiKey || '', ...init.headers } });
    if (allowMissing && response.status === 404) return null;
    assert.ok(response.ok, `${route.split('?')[0]} returned ${response.status}`);
    return response.json();
  };
  try {
    await stage('fixture', '正式账号、固定日志及 OpenCode 2.1.4 真实采集插件独立就绪；不依赖 RAS', async () => {
      assert.equal(hash(data), '6d50cefa82380651f910df35fda0995a237a3c788b7b2e3d2d37e51fb9debca9');
      account = await api('/api/auth/apikey', { method: 'POST', body: JSON.stringify({ username }) });
      assert.equal(account.username, username);secrets.push(account.apiKey);writePrivate(path.join(root, 'private/account.json'), account);
      const clientRoot = path.join(root, 'ordinary');const bin = path.join(clientRoot, 'bin');fs.mkdirSync(bin, { recursive: true });
      const executable = path.join(project, 'exclude/core-e2e/runtime/v2/node_modules/.bin/opencode');
      fs.symlinkSync(executable, path.join(bin, 'opencode'));fs.symlinkSync(process.execPath, path.join(bin, 'node'));
      env = runtimeEnv(clientRoot, bin);env.OPENCODE_DISABLE_MODELS_FETCH = 'true';env.AGENT_INSIGHT_HOST = baseUrl;env.AGENT_INSIGHT_API_KEY = account.apiKey;
      workspace = path.join(clientRoot, 'workspace');fs.mkdirSync(path.join(workspace, 'fixtures'), { recursive: true });fs.writeFileSync(path.join(workspace, 'fixtures/messages'), data);
      expected.file = path.join(workspace, 'fixtures/messages');expected.workspace=workspace;
      prompt = `${marker}：请用原生 shell 工具检查 ${expected.file}。直接调用 shell，不要在 execute 的 JavaScript 内访问 tools.shell，因为那不是终端工具入口；如尚未显示 shell，先用工具搜索发现它。只执行以下固定只读命令，不使用 cd 或目录扫描：awk 'END{print NR}' ${JSON.stringify(expected.file)}; head -n 1 ${JSON.stringify(expected.file)}。awk 的 NR 也包含没有换行的最后一行。只回复总行数和第一行原文；不要逐页读取整份文件，不搜索或替换其他文件，不修改文件。`;
      const configRoot = path.join(env.XDG_CONFIG_HOME, 'opencode');fs.mkdirSync(path.join(configRoot, 'plugins'), { recursive: true });
      const config = openCodeModelConfig(ctx);
      writePrivate(path.join(configRoot, 'opencode.json'), config);
      writePrivate(path.join(env.AGENT_INSIGHT_HOME, '.env'), `AGENT_INSIGHT_HOST=${baseUrl}\nAGENT_INSIGHT_API_KEY=${account.apiKey}\n`);
      const artifacts = {};
      for (const [route, dest] of [
        ['/api/ingest/setup/opencode?apiVersion=2', path.join(configRoot, 'plugins/Witty-Skill-Insight.ts')],
        ['/api/ingest/setup/opencode-uploader', path.join(env.AGENT_INSIGHT_HOME, 'opencode_uploader_client.js')],
      ]) {
        const response = await fetch(baseUrl + route);assert.ok(response.ok);const body = await response.text();fs.writeFileSync(dest, body);artifacts[route] = hash(body);
      }
      const version = await command('opencode', ['--version'], { env, cwd: workspace, timeout: 15000 });assert.equal(version.code, 0);assert.match(version.output, /2\.1\.4/);
      writePrivate(path.join(root, 'private', 'task.json'), { prompt, workspace, expected });
      return { username, version: version.output.trim(), sourceHash: hash(data), lineCount: expected.lineCount, artifacts, ras: 'not enabled', preparation: 'formal account API and collector distribution endpoints; global service installation outside scope' };
    });
    await stage('native-task', 'OpenCode 真实读取日志并返回正确行数/第一行，记录新原生会话', async () => {
      const log = path.join(root, 'private/native.log');
      const result = await command('opencode', ['run', '--standalone', '--auto', '--agent', 'build', '--model', executionModel(ctx), '--format', 'json', '--title', marker, prompt], { env, cwd: workspace, log, timeout: 300000 });
      assert.equal(result.code, 0, `Native task failed (timeout=${result.expired}); see private/native.log`);
      const events = fs.readFileSync(log, 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const messages = events.filter(e => e.type === 'text' && e.part?.text);
      const last = messages.at(-1);assert.ok(last, 'Native assistant response missing');
      const sessionId = last.sessionID || last.sessionId;assert.ok(sessionId, 'Native session ID missing');expected.sessionId = sessionId;
      assert.ok(last.part.text.includes(expected.firstLine.trimEnd()), 'Native first line differs');assert.match(last.part.text.replace(/,/g, ''), /(?<!\d)2000(?!\d)/);
      assert.equal(hash(fs.readFileSync(path.join(workspace, 'fixtures/messages'))), hash(data), 'Readonly input was modified');
      native = { sessionId, reply: last.part.text, eventCount: events.length, logHash: hash(fs.readFileSync(log)) };
      return native;
    });
    await stage('ingest', '本轮新 Trace 唯一入库、归属正确且包含实际工具输入输出和最终结果', async () => {
      const records = await poll(async () => api(`/api/observe/data?user=${encodeURIComponent(username)}&taskId=${encodeURIComponent(native.sessionId)}&includeEvaluations=0&skipAutoEvalReady=1`), rows => Array.isArray(rows) && rows.length > 0 && rows[0].trace_status === 'success', 120000);
      assert.equal(records.length, 1, 'Duplicate root executions for native session');record = records[0];
      assert.equal(record.framework, 'opencode');assert.ok(record.query.includes(marker));
      session = await poll(async () => api(`/api/observe/session?taskId=${encodeURIComponent(native.sessionId)}`, {}, true), value => {
        if (!value) return false;
        writePrivate(path.join(root, 'private/last-observed-session.json'), value);
        try { assertTraceEvidence(value, expected);return true; } catch { return false; }
      }, 120000);
      evidence = assertTraceEvidence(session, expected);
      writePrivate(path.join(root, 'private/ingested-session.json'), session);
      assert.equal(record.task_id, native.sessionId);
      return { taskId: native.sessionId, executionId: record.upload_id, framework: record.framework, agent: record.agentName || record.agent || 'build', traceStatus: record.trace_status || record.traceStatus, ...evidence };
    });
    browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL || 'chrome', headless: true });context = await browser.newContext({ locale: 'zh-CN' });
    await context.tracing.start({ screenshots: false, snapshots: true, sources: false });page = await context.newPage();page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(90000);
    await stage('trace-ui', '同一账号通过 Trace 列表检索、详情展开和刷新看到本轮输入、工具及正确结果', async () => {
      await page.goto(baseUrl + '/login');await page.locator('input[type=email]').fill(username);
      const logged = page.waitForResponse(r => r.url().endsWith('/api/auth/apikey') && r.request().method() === 'POST');await page.locator('button[type=submit]').click();assert.equal((await logged).status(), 200);
      await page.waitForURL(url => url.pathname !== '/login');await page.getByText(username, { exact: true }).waitFor();
      const search = page.getByRole('textbox', { name: '搜索或过滤 trace', exact: true });await search.fill(marker);
      await search.press('Escape');
      const row = page.getByRole('button', { name: `Trace ID ${native.sessionId}`, exact: true });await row.waitFor();assert.equal(await row.count(), 1, 'Trace page must show exactly this root trace');await row.click();
      await page.waitForURL(url => url.searchParams.get('taskId') === native.sessionId);
      await verifyTraceUi(page, expected, evidence);
      await page.screenshot({ path: path.join(root, 'trace.png'), fullPage: true, mask: [page.locator('input,textarea')] });
      await page.reload();await page.waitForLoadState('domcontentloaded');
      await verifyTraceUi(page, expected, evidence);
      await page.screenshot({ path: path.join(root, 'trace-refreshed.png'), fullPage: true, mask: [page.locator('input,textarea')] });
      return { taskId: native.sessionId, listMatches: 1, refreshedUrl: new URL(page.url()).pathname + new URL(page.url()).search };
    });
    await stage('agent-ui', '从本次 Agent 的页面入口返回相同 Trace，且记录仍唯一', async () => {
      await page.goto(baseUrl + '/agents');
      const agentName = record.agentName || record.agent || 'build';
      const title = page.locator('span[title]').filter({ hasText: new RegExp(`^${agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
      await title.waitFor();
      await page.screenshot({ path: path.join(root, 'agent-overview.png'), fullPage: true, mask: [page.locator('input,textarea')] });
      const card = title.locator('xpath=ancestor::div[.//button[contains(.,"链路") or contains(.,"Trace")]][1]');
      await card.getByRole('button', { name: /链路|Trace/ }).click();
      await page.waitForURL(url => url.pathname === '/trace' && url.searchParams.get('agent') === agentName);
      await page.getByRole('textbox', { name: '搜索或过滤 trace', exact: true }).fill(marker);
      await page.getByRole('textbox', { name: '搜索或过滤 trace', exact: true }).press('Escape');
      const row = page.getByRole('button', { name: `Trace ID ${native.sessionId}`, exact: true });await row.waitFor();assert.equal(await row.count(), 1);await row.click();await page.waitForURL(url => url.searchParams.get('taskId') === native.sessionId);
      await page.screenshot({ path: path.join(root, 'agent.png'), fullPage: true, mask: [page.locator('input,textarea')] });
      return { agent: agentName, taskId: native.sessionId, returnMatches: 1 };
    });
  } catch (error) {
    if (page) try { await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true, mask: [page.locator('input,textarea,code,pre')] }); } catch {}
    throw error;
  } finally {
    if (context) { const file = path.join(root, 'private/browser-trace.zip');await context.tracing.stop({ path: file });fs.chmodSync(file, 0o600); }
    if (browser) await browser.close();
  }
}

export async function verifyTraceUi(page, expected, evidence) {
  await page.waitForFunction(() => document.querySelectorAll('[role="treeitem"]').length > 0);
  const expand = page.getByRole('button', { name: /^(展开|展开全部|全部展开|Expand(?: all)?)$/i, exact: true });
  if (await expand.count() === 1) await expand.click();
  const user = page.getByRole('treeitem').filter({ has: page.getByText('USER', { exact: true }) });
  assert.equal(await user.count(), 1, 'Current user input must be visible once');
  await user.click();await poll(() => user.getAttribute('aria-selected'), value => value === 'true', 5000, 50);
  await page.getByRole('button', { name: '查看全部 ›', exact: true }).click();
  const message = page.getByRole('dialog');await message.locator('.sv-body').waitFor();
  const input = await message.innerText();assert.ok(input.includes(expected.marker) && input.includes(expected.file), 'UI current task input missing');
  await message.press('Escape');await message.waitFor({ state: 'hidden' });
  let sawFile = false, sawFirstLine = false;
  for (const name of evidence.fileToolNames) {
    const escapedName=name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nodes = page.getByRole('treeitem').filter({has:page.getByText('TOOL',{exact:true})}).filter({ has: page.getByText(new RegExp(`^${escapedName}(?:$|\\s|\\()`)) });
    const count = await nodes.count();assert.ok(count>0, `UI tool node missing: ${name}`);
    for (let i = 0; i < count; i++) {
      await nodes.nth(i).click();
      await poll(() => nodes.nth(i).getAttribute('aria-selected'), value => value === 'true', 5000, 50);
      const full = page.getByRole('button', { name: '查看全部 ›', exact: true });
      await full.first().waitFor();
      const sections = await full.count();
      for (let section = 0; section < sections; section++) {
        await full.nth(section).click();
        const dialog = page.getByRole('dialog');await dialog.locator('.sv-body').waitFor();
        const body = await dialog.innerText();
        sawFile ||= evidence.fileArguments.some(argument=>body.includes(argument));
        sawFirstLine ||= body.replace(/\s+/g, ' ').includes(expected.firstLine.trimEnd().replace(/\s+/g, ' '));
        await dialog.press('Escape');await dialog.waitFor({ state: 'hidden' });
      }
    }
  }
  assert.ok(sawFile, 'UI did not show the actual tool file argument');
  assert.ok(sawFirstLine, 'UI did not show the actual tool output');
  const llm = page.getByRole('treeitem').filter({ hasText: 'LLM' });const count = await llm.count();assert.ok(count > 0, 'Model nodes missing from visible trace tree');
  await llm.nth(count - 1).click();
  await poll(() => llm.nth(count - 1).getAttribute('aria-selected'), value => value === 'true', 5000, 50);
  await page.getByText(expected.modelName, { exact: true }).waitFor();
  const output = page.getByRole('button', { name: /^Output\s*1$/i }).locator('..');
  await output.getByRole('button', { name: /^assistant/i }).click();
  await output.getByRole('button', { name: /^Response/i }).click();
  await output.getByText(expected.firstLine.trimEnd(), { exact: false }).waitFor();
  const body = await output.innerText();
  assert.match(body.replace(/,/g, ''), /(?<!\d)2000(?!\d)/, 'UI final result count missing');
  assert.ok(body.replace(/\s+/g, ' ').includes(expected.firstLine.trimEnd().replace(/\s+/g, ' ')), 'UI final first line missing');
}
