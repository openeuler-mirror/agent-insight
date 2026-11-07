import assert from 'node:assert/strict';
import { poll } from '../../shared/runtime.mjs';

export async function verifyOptimizationReopen(page, baseUrl, sessionId, skillName, contentHash) {
  await page.goto(`${baseUrl}/skills?sessionId=${encodeURIComponent(sessionId)}`);
  const selected = page.getByRole('combobox', { name: '选择 Skill', exact: true });
  await selected.waitFor();
  await poll(() => selected.inputValue(), value => value === skillName, 30000, 100);
  await page.reload();
  await selected.waitFor();
  await poll(() => selected.inputValue(), value => value === skillName, 30000, 100);
  await page.getByRole('button', { name: '优化记录', exact: true }).last().click();
  const article = page.getByRole('article').filter({ has: page.getByRole('heading', { name: /^优化报告/ }) });
  await article.getByText(`快照：${contentHash}`, { exact: true }).waitFor();
  await article.getByText('静态通过，待完整复测', { exact: true }).waitFor();
  await article.getByRole('button', { name: /^SKILL\.md/ }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('sessionId'), sessionId);
  return { sessionId, skillName, candidateContentHash: contentHash, view: '优化记录', uiLoaded: true };
}

export async function reopenTraceExperiment(page, baseUrl, item) {
  await page.goto(baseUrl + item.url);
  await page.getByText('任务完成度（无标准答案）', { exact: false }).first().waitFor();
  await page.reload();
  await page.getByText('任务完成度（无标准答案）', { exact: false }).first().waitFor();
}
