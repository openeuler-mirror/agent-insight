import {executionModel} from '../../shared/model-config.mjs';
import {selectFormalSkill} from '../../shared/skill-ui.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { poll, writePrivate } from '../../shared/runtime.mjs';
import { assertSnapshot, assertSkillAnswer } from '../../shared/skill-evidence.mjs';
import { assertOptimizedSnapshot, optimizationPrompt } from './skill-contract.mjs';
import { readArchivedVerification, readFrozenSkillSnapshot } from '../../shared/skill-archive.mjs';

export async function completeSkillLifecycle(ctx) {
  const { project, root, runId, api, page, stage, shot, generated, generatedName, baselineVersion } = ctx;
  const responseFor = (...args) => { const promise = page.waitForResponse(...args);promise.catch(() => {});return promise; };
  const requestFor = (...args) => { const promise = page.waitForRequest(...args);promise.catch(() => {});return promise; };
  const username = ctx.account.username;
  const marker = `E2E-${runId}-003`;
  const logFile = path.join(root, 'ordinary/workspace/fixtures/messages');fs.mkdirSync(path.dirname(logFile), { recursive: true });fs.copyFileSync(path.join(project, 'public/example/messages'), logFile);
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const logHash = hash(logFile);assert.equal(logHash, '6d50cefa82380651f910df35fda0995a237a3c788b7b2e3d2d37e51fb9debca9');
  const input = `${marker}：使用 ${generatedName} 分析 ${logFile}。\n请统计 root 账户认证失败的次数，找出次数最多的来源及其次数，并给出日志证据。\n只分析提供的离线日志，不连接远程主机，不读取当前机器的 /var/log，不修改文件。`;
  const datasetName = `e2e-behavior-${runId}-003`;
  const createdDataset = await api('/api/agent-datasets', { method: 'POST', body: JSON.stringify({ user: username, name: datasetName, targetSkill: generatedName, targetAgent: 'build', datasetKind: 'ideal_output', cases: [{ input, expectedOutput: 'root 认证失败 351 次，次数最多来源 150.183.249.110，共 80 次；包含来自指定文件的实际日志证据。' }] }) });
  const dataset = createdDataset.dataset;assert.equal(dataset.cases.length, 1);
  writePrivate(path.join(root, 'private/behavior-dataset.json'), dataset);
  const experimentUrl = id => `/api/experiments/${id}?user=${encodeURIComponent(username)}`;
  const waitExperiment = async (id, label, summary, archived = null) => {
    const detail = await poll(async () => {
      const data = archived || await api(experimentUrl(id));writePrivate(path.join(root, `private/${label}-experiment.json`), data);return data;
    }, value => {
      if (['failed', 'partial', 'cancelled'].includes(value.status)) throw new Error(`${label} experiment ${value.status}; see private/${label}-experiment.json`);
      return value.status === 'done';
    }, 300000, 2000);
    assert.equal(detail.cases.length, 1, 'Only the selected behavior case may run');
    const item = detail.cases[0];assert.ok(item.taskId, 'New native Trace missing');assert.ok(item.input.includes(marker));
    assertSkillAnswer(item.actualOutput, summary);
    const results = detail.results.filter(r => r.caseId === item.id);assert.equal(results.length, 1);const result = results[0];
    assert.equal(result.evaluatorId, 'preset-agent-task-completion');assert.equal(result.status, 'done');assert.ok(typeof result.score === 'number');
    const score = result.score <= 1 ? result.score * 100 : result.score;assert.ok(score >= 80, `Completion score ${score} is below 80`);assert.ok(result.summary?.trim(), 'Evaluation reasoning is empty');
    const trace = await poll(() => api(`/api/observe/session?taskId=${encodeURIComponent(item.taskId)}`), value => value.interactions?.some(m => m.role === 'assistant' && String(m.content).includes('351')), 120000);
    assert.equal(trace.user, username);const tools = trace.interactions.flatMap(m => m.tool_calls || []);assert.ok(tools.length > 0, 'No actual tool calls');
    assert.ok(JSON.stringify(tools).includes(generatedName), 'Actual tools did not load or execute the selected Skill');assert.ok(JSON.stringify(tools).includes(logFile), 'Actual tools did not access the selected log file');
    const files = label === 'baseline' ? generated.files : record.candidateFiles;
    const body = files['SKILL.md'].replace(/^---\s*\n[\s\S]*?\n---/, '').trim();
    assert.ok(tools.some(tool => String(tool.output || '').replaceAll('\\n', '\n').replaceAll('\\"', '"').includes(body)), 'Actually loaded SKILL.md differs from selected snapshot');
    if (!archived) {
      const frozen = readFrozenSkillSnapshot(path.join(root, 'app/data/witty_insight.db'), username, detail.configSnapshot.grayscaleTaskId);
      assert.equal(frozen.name, generatedName);assert.equal(frozen.version, detail.skillVersion);assertSnapshot(files, frozen.files);
    }
    assert.equal(hash(logFile), logHash, 'Readonly input was modified');
    writePrivate(path.join(root, `private/${label}-trace.json`), trace);
    await page.getByText(label === 'candidate' ? (record.status === 'retest_failed' ? /行为验证未通过/ : /行为验证通过/) : /任务完成度/).first().waitFor();await shot(`skill-${label}`);
    return { experimentId: id, taskId: item.taskId, score, evaluatorId: result.evaluatorId, summary: result.summary, facts: assertSkillAnswer(item.actualOutput, summary), detail };
  };
  const createExperiment = async (version, label) => {
    await selectFormalSkill(page,generatedName,version);
    await page.getByRole('button', { name: 'Skill 实验', exact: true }).last().click();
    const create = page.getByRole('button', { name: /用例分析.*新建用例实验/ });
    const back = page.getByRole('button', { name: '‹ 返回', exact: true });
    await create.or(back).first().waitFor();
    if (await back.isVisible()) await back.click();
    await create.click();
    await page.getByPlaceholder('如：客服 Agent 回答质量基线', { exact: true }).fill(`e2e-${label}-${runId}`);
    const agent = page.locator('select').filter({ has: page.locator('option[value="build"]') });await agent.selectOption('build');
    await page.getByRole('button', { name: '评测数据集', exact: true }).click();await page.getByRole('menuitemradio', { name: new RegExp(`^${datasetName}`) }).click();
    await page.getByRole('button', { name: '下一步：Trace 来源 →', exact: true }).click();
    await page.getByRole('button', { name: '生成 Trace', exact: true }).click();
    await page.getByRole('button', { name: /^运行模型：/ }).click();await page.locator(`[role="option"][title="${executionModel()}"]`).click();
    await page.locator('label').filter({ hasText: marker }).getByRole('checkbox').check();
    await page.getByRole('button', { name: '下一步：预期答案 →', exact: true }).click();
    await page.getByRole('button', { name: '下一步：评估器与执行 →', exact: true }).click();
    await page.getByText('Agent 任务完成度', { exact: true }).click();
    const pending = responseFor(r => r.url().includes(`/api/skill-workbench/skills/${generatedName}/experiments`) && r.request().method() === 'POST');
    await page.getByRole('button', { name: '🚀 开始实验', exact: true }).click();
    const response = await pending;const sent = response.request().postDataJSON();writePrivate(path.join(root, `private/${label}-experiment-request.json`), sent);
    assert.deepEqual(sent.evaluatorIds, ['preset-agent-task-completion']);assert.equal(sent.datasetId, dataset.id);assert.equal(sent.version, version);assert.equal(sent.executionTarget.workerId, ctx.clients[0].clientId);assert.equal(sent.executionTarget.model, executionModel());assert.deepEqual(sent.caseIds, [dataset.cases[0].id]);
    const created = await response.json();assert.ok(response.ok(), created.error);assert.ok(created.experiment.id);
    return waitExperiment(created.experiment.id, label, label !== 'baseline');
  };
  let baseline, record, candidate, publishedVersion;
  await stage('baseline', '页面正式用例实验生成本轮 Trace，实际加载基线并得到三项事实、日志证据及完成度 ≥80', async () => {
    baseline = await createExperiment(baselineVersion, 'baseline');return { ...baseline, detail: undefined, datasetId: dataset.id, caseId: dataset.cases[0].id, version: baselineVersion };
  });
  await stage('optimization', '同一生成会话基线发起真实定向优化，保存最终候选、diff 和静态门禁', async () => {
    const feedback = optimizationPrompt;
    await selectFormalSkill(page,generatedName,baselineVersion);
    await page.getByPlaceholder('描述 Skill 的目标、输入和期望输出…', { exact: true }).fill(feedback);
    const request = requestFor(r => r.url().endsWith('/api/skill-opt/chat') && r.method() === 'POST');
    await page.locator('[aria-label="Skill 快捷操作"]').getByRole('button', { name: 'Skill 优化', exact: true }).click();
    const sent = (await request).postDataJSON();assert.equal(sent.mock, false);assert.equal(sent.userFeedback, feedback);assert.equal(sent.baseVersion, baselineVersion);writePrivate(path.join(root, 'private/optimization-request.json'), sent);
    const complete = await poll(async () => {
      const data = await api(`/api/skill-workbench/sessions/${generated.id}?user=${encodeURIComponent(username)}`);writePrivate(path.join(root, 'private/optimization-session.json'), data);return data.session;
    }, value => {
      const latest = value.optimizations[0];const task = value.tasks.filter(t => t.type === 'optimization').at(-1);
      if (task?.status === 'failed' || latest?.status === 'optimization_failed') throw new Error('Optimization failed; see private/optimization-session.json');
      return latest && task?.status === 'done' && !['optimizing'].includes(latest.status);
    }, 480000, 2000);
    record = complete.optimizations[0];const scriptReplay=assertOptimizedSnapshot(record.candidateFiles,generatedName,logFile);writePrivate(path.join(root,'private/candidate-script-replay.json'),scriptReplay);assert.notDeepEqual(record.candidateFiles, generated.files);assert.ok(record.diff.length > 0);assert.ok(record.staticEvaluationId);writePrivate(path.join(root, 'private/candidate.json'), record);
    await shot('skill-optimization');return { recordId: record.id, baseVersion: record.baseVersion, status: record.status, candidateContentHash: record.candidateContentHash, staticEvaluationId: record.staticEvaluationId, diffFiles: record.diff.map(d => d.path || d.file),scriptReplay };
  });
  await stage('candidate', '最终候选对相同 Case 真实复测，原事实与新增三字段 JSON 均正确，评分 ≥80', async () => {
    const archivedRef = record.sourceRefs.find(ref => ref.type === 'verification-result' && ref.experimentDeleted && ref.fullCoverage);
    if (archivedRef) {
      const canonical = await api(`/api/agent-datasets/${dataset.id}?user=${encodeURIComponent(username)}`);
      assert.equal(canonical.cases[0].input, dataset.cases[0].input);assert.equal(canonical.cases[0].expectedOutput, dataset.cases[0].expectedOutput);
      const archived = readArchivedVerification(path.join(root, 'app/data/witty_insight.db'), username, record, canonical);
      candidate = await waitExperiment(archived.id, 'candidate', true, archived);
      assert.notEqual(candidate.taskId, baseline.taskId);
      return { ...candidate, detail: undefined, recordId: record.id, candidateContentHash: record.candidateContentHash, verificationSource: 'read-only archived experiment, immutable proof hashes and actual Trace', platformVerification: { status: record.status, relativeScorePassed: archivedRef.passed, baseScore: archivedRef.sourceScore, candidateScore: archivedRef.candidateScore, message: record.errorMessage } };
    }
    assert.ok(record.retestExperimentId, 'No complete final-candidate verification evidence; cannot pass or invent a retest UI entry');
    candidate = await waitExperiment(record.retestExperimentId, 'candidate', true);assert.notEqual(candidate.taskId, baseline.taskId);return { ...candidate, detail: undefined, recordId: record.id, candidateContentHash: record.candidateContentHash };
  });
  await stage('publish', '页面发布候选，基线保留且正式新版文件逐文件等于最终候选', async () => {
    const result = responseFor(r => r.url().endsWith(`/optimizations/${record.id}/publish`) && r.request().method() === 'POST');
    await page.getByRole('button', { name: /^发布为 v\d+$/ }).click();await page.getByRole('dialog', { name: '发布优化候选', exact: true }).getByRole('button', { name: '确认发布', exact: true }).click();
    const response = await result;const data = await response.json();assert.ok(response.ok(), data.error);publishedVersion = data.version.version;assert.ok(publishedVersion > baselineVersion);assertSnapshot(record.candidateFiles, data.session.files);writePrivate(path.join(root, 'private/candidate-publish.json'), data);await shot('skill-published');return { version: publishedVersion, baselineVersion, candidateHashes: assertSnapshot(record.candidateFiles, data.session.files) };
  });
  await stage('published-run', '发布版重跑同一 Case、刷新重开结果，旧版全部文件和结果保持', async () => {
    const result = await createExperiment(publishedVersion, 'published');assert.notEqual(result.taskId, candidate.taskId);assert.notEqual(result.taskId, baseline.taskId);
    const skillId = JSON.parse(fs.readFileSync(path.join(root, 'private/baseline-publish.json'))).skill.id;
    const baselineMetadata = await api(`/api/skills/${skillId}/versions/${baselineVersion}?user=${encodeURIComponent(username)}`);
    assert.deepEqual(JSON.parse(baselineMetadata.files).sort(), Object.keys(generated.files).sort());
    const preserved = {};
    for (const file of Object.keys(generated.files)) preserved[file] = (await api(`/api/skills/${skillId}/versions/${baselineVersion}/files/${file}?user=${encodeURIComponent(username)}`)).content;
    const baselineHashes = assertSnapshot(generated.files, preserved);
    const original = await api(experimentUrl(baseline.experimentId));assert.equal(original.cases[0].taskId, baseline.taskId);assertSkillAnswer(original.cases[0].actualOutput, false);
    await page.reload();await page.getByRole('combobox', { name: '选择 Skill 版本', exact: true }).waitFor();
    await poll(() => page.getByRole('combobox', { name: '选择 Skill 版本', exact: true }).inputValue(), value => value === String(publishedVersion), 10000, 100);
    await page.getByRole('button', { name: 'Skill 实验', exact: true }).last().click();
    await page.getByText(result.experimentId, { exact: true }).click();await page.getByText(/任务完成度/).first().waitFor();
    const restored = await api(experimentUrl(result.experimentId));assert.equal(restored.cases[0].taskId, result.taskId);assertSkillAnswer(restored.cases[0].actualOutput, true);
    await shot('skill-published-refreshed');return { ...result, detail: undefined, version: publishedVersion, baselineHashes, reopenedAfterReload: true };
  });
}
