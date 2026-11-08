import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { loginAndModel } from '../../shared/browser-setup.mjs';
import { poll, writePrivate } from '../../shared/runtime.mjs';
import { assertSnapshot } from '../../shared/skill-evidence.mjs';
import { assertControlledSnapshot, generationPrompt, assertStaticAssessment } from './skill-contract.mjs';

export async function scenario003(ctx) {
  const { root, project, runId, baseUrl, stage } = ctx;
  const browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1600, height: 1100 } });
  await context.tracing.start({ screenshots: false, snapshots: true, sources: false });
  const page = await context.newPage();page.setDefaultTimeout(45000);page.setDefaultNavigationTimeout(90000);
  const responseFor = (...args) => { const promise = page.waitForResponse(...args);promise.catch(() => {});return promise; };
  const requestFor = (...args) => { const promise = page.waitForRequest(...args);promise.catch(() => {});return promise; };
  const shot = name => page.screenshot({ path: path.join(root, `${name}.png`), fullPage: true, animations: 'disabled', mask: [page.locator('input,textarea')] });
  const uploadedName = `e2e-messages-upload-${runId}`;
  const generatedName = `e2e-messages-generated-${runId}`;
  let upload, generated, baselineVersion;
  try {
    await loginAndModel(ctx, page);
    ctx.clientKinds = ['ordinary'];await ctx.prepareClients(ctx);
    const { api } = ctx;
    const session = id => api(`/api/skill-workbench/sessions/${id}?user=${encodeURIComponent(ctx.account.username)}`);
    const newSession = async () => {
      const created = responseFor(r => r.url().endsWith('/api/skill-workbench/sessions') && r.request().method() === 'POST');
      await page.getByRole('button', { name: '新对话', exact: true }).click();
      const response = await created;assert.equal(response.status(), 201);return (await response.json()).session;
    };
    await stage('upload', '上传会话的 13 个真实文件与原包仅重命名后的快照一致，刷新仍保留', async () => {
      const bundle = JSON.parse(fs.readFileSync(path.join(project, 'src/server/builtin-example/skill-bundle.json')));
      const files = Object.fromEntries(bundle.files.map(file => [file, (file === 'SKILL.md' ? bundle.content : bundle.assets[file]).replaceAll(bundle.name, uploadedName)]));
      const folder = path.join(root, 'upload', uploadedName);
      for (const [file, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });fs.writeFileSync(path.join(folder, file), content); }
      await page.goto(baseUrl + '/skills');upload = await newSession();await page.getByRole('button', { name: '上传已有 Skill', exact: true }).waitFor();
      const result = responseFor(r => r.url().endsWith(`/sessions/${upload.id}/upload`) && r.request().method() === 'POST');
      const chooser = page.waitForEvent('filechooser');chooser.catch(() => {});await page.getByRole('button', { name: '上传已有 Skill', exact: true }).click();await (await chooser).setFiles(folder);
      const response = await result;assert.equal(response.status(), 200);const detail = (await response.json()).session;assert.equal(detail.skillName, uploadedName);assertSnapshot(files, detail.files);
      for (const file of ['SKILL.md', 'scripts/analyze_logs.py', 'references/ssh-bruteforce.md']) { await page.getByRole('button', { name: file, exact: true }).click(); }
      await page.reload();const restored = (await session(upload.id)).session;const hashes = assertSnapshot(files, restored.files);await shot('skill-upload');
      return { sessionId: upload.id, skillName: uploadedName, fileCount: Object.keys(files).length, hashes, persisted: true };
    });
    await stage('generation', '独立生成会话通过模型 API 与实际写文件工具生成命名 Skill 和脚本，禁止产品内置 Mock 和联网', async () => {
      generated = await newSession();assert.notEqual(generated.id, upload.id);
      await page.getByRole('button', { name: '生成一个 Skill', exact: true }).click();
      const attachmentResponse = responseFor(r => r.url().endsWith('/api/skill-generator/attachments') && r.request().method() === 'POST');
      const chooseReference = page.waitForEvent('filechooser');chooseReference.catch(() => {});
      await page.locator('button[title="上传参考资料"]').click();await (await chooseReference).setFiles(path.join(project, 'test/e2e/cases/003-skill-lifecycle/fixtures/count_root_ssh.py'));
      const uploaded = await attachmentResponse;assert.ok(uploaded.ok());const reference = await uploaded.json();assert.equal(reference.accepted.length, 1);assert.equal(reference.errors.length, 0);
      const input = generationPrompt(generatedName, reference.accepted[0].name);
      await page.getByPlaceholder('描述 Skill 的目标、输入和期望输出…', { exact: true }).fill(input);
      await page.locator('select[title="模型"]').selectOption(ctx.modelId);
      const requested = requestFor(r => r.url().endsWith('/api/skill-generator/chat') && r.method() === 'POST');
      await page.locator('form').filter({ has: page.getByPlaceholder('描述 Skill 的目标、输入和期望输出…', { exact: true }) }).locator('button[type=submit]').click();
      const request = (await requested).postDataJSON();assert.equal(request.mock, false);assert.equal(request.webSearchEnabled, false);assert.equal(request.modelId, ctx.modelId);
      writePrivate(path.join(root, 'private/generation-request.json'), request);
      const done = await poll(async () => (await session(generated.id)).session, value => {
        const task = value.tasks.filter(t => t.type === 'generation').at(-1);
        if (task?.status === 'failed') throw new Error(`Skill generation failed: ${task.errorMessage}`);
        return task?.status === 'done' && value.stage === 'ready' && value.files?.['SKILL.md'];
      }, 600000, 2500);
      assert.equal(done.skillName, generatedName);assertControlledSnapshot(done.files, generatedName);
      writePrivate(path.join(root, 'private/generated-snapshot.json'), done);generated = done;
      await page.reload();await page.getByRole('combobox', { name: '选择 Skill', exact: true }).waitFor();await shot('skill-generated');
      return { sessionId: done.id, generatorSessionId: done.generatorSessionId, skillName: done.skillName, version: done.workVersion, hashes: assertSnapshot(done.files, done.files), modelConfigId: ctx.modelId, mock: false };
    });
    await stage('static', '真实静态评估完成并展示分数及意见；生成稿按产品生成分支发布规则处理，质量意见单列', async () => {
      await page.getByRole('button', { name: 'Skill 评估', exact: true }).last().click();
      const started = responseFor(r => r.url().includes('/evaluations') && r.request().method() === 'POST');
      await page.getByRole('button', { name: /^(开始评估|重新评估)$/ }).click();assert.ok((await started).ok());
      const overview = await poll(() => api(`/api/skill-workbench/skills/${generatedName}/versions/${generated.workVersion}/evaluations?user=${encodeURIComponent(ctx.account.username)}&sessionId=${generated.id}`), value => value.gate?.state && !['running','missing','not_started'].includes(value.gate.state), 180000, 2000);
      writePrivate(path.join(root, 'private/static-evaluation.json'), overview);
      const result = assertStaticAssessment(overview);
      await page.getByText('静态质量评估', { exact: true }).waitFor();
      await page.getByText(overview.gate.message, { exact: true }).waitFor();await shot('skill-static');
      return { ...result, publishContract: 'generated snapshot: files available and generation complete; static advice recorded separately', codeOracle: 'two-file contract and exact audited reference script PASS' };
    });
    await stage('baseline-publish', '页面发布生成基线并核对正式版本文件完整一致', async () => {
      await page.getByRole('button', { name: 'Skill 详情', exact: true }).click();
      const result = responseFor(r => r.url().endsWith(`/sessions/${generated.id}/publish`) && r.request().method() === 'POST');
      await page.getByRole('button', { name: /^发布为 v\d+$/ }).click();const response = await result;assert.ok(response.ok());const published = await response.json();baselineVersion = published.version.version;
      const hashes = assertSnapshot(generated.files, published.session.files);writePrivate(path.join(root, 'private/baseline-publish.json'), published);await shot('skill-baseline');return { version: baselineVersion, hashes };
    });
    const { completeSkillLifecycle } = await import('./skill-lifecycle.mjs');
    await completeSkillLifecycle({ ...ctx, page, shot, generated, generatedName, baselineVersion });
  } catch (error) {
    try { await shot('failure'); } catch {}
    throw error;
  } finally {
    const trace = path.join(root, 'private/browser-trace.zip');await context.tracing.stop({ path: trace });fs.chmodSync(trace, 0o600);await browser.close();
  }
}
