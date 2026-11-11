import {executionModel} from '../../shared/model-config.mjs';
import {selectFormalSkill} from '../../shared/skill-ui.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import { poll, writePrivate } from '../../shared/runtime.mjs';
import { assertSnapshot, assertSkillAnswer, assertSameTraceSnapshot } from '../../shared/skill-evidence.mjs';
import {createDatasetThroughUi} from '../../shared/dataset-ui.mjs';
import {diagnoseTrace} from '../../shared/diagnosis-ui.mjs';
import {deriveRootSshTruth} from '../../shared/log-truth.mjs';
import {datasetBusinessHash} from '../../shared/dataset-contract.mjs';
import { assertOptimizedSnapshot, optimizationPrompt } from './skill-contract.mjs';
import { readArchivedVerification, readFrozenSkillSnapshot, candidateVerificationDiagnostics } from '../../shared/skill-archive.mjs';

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
  const truth=deriveRootSshTruth(fs.readFileSync(logFile,'utf8'));
  const recipe={input,reference:`root 认证失败 ${truth.rootFailures} 次，次数最多来源 ${truth.topSources[0][0]}，共 ${truth.topSources[0][1]} 次；包含来自指定文件的实际日志证据。`};
  let dataset,datasetHash,diagnosis;const datasetWrites=[];
  const observeDatasetWrites=request=>{const p=new URL(request.url()).pathname;if(p.startsWith('/api/agent-datasets')&&!['GET','HEAD'].includes(request.method()))datasetWrites.push({path:p,method:request.method()});};
  page.on('request',observeDatasetWrites);
  await stage('dataset-ui','页面导入并保存一题私有数据集，参考答案由原日志独立计算，刷新后题目与归属正确',async()=>{
    const created=await createDatasetThroughUi({page,baseUrl:ctx.baseUrl,root,api,username,datasetName,recipe,shot,readOwner:id=>{const db=new DatabaseSync(path.join(root,'app/data/witty_insight.db'),{readOnly:true});try{return db.prepare('SELECT user FROM AgentEvalDataset WHERE id=?').get(id)?.user;}finally{db.close();}}});
    dataset=created.dataset;datasetHash=created.proof.datasetHash;assert.deepEqual(datasetWrites,[{path:'/api/agent-datasets',method:'POST'}]);
    return {datasetId:dataset.id,caseId:dataset.cases[0].id,caseCount:1,businessHash:datasetHash,referenceSource:'Independent JavaScript parser of the original log',createdVia:'UI local JSON import and save',privateOwnerVerified:true};
  });
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
    const rows=await poll(()=>api(`/api/observe/data?user=${encodeURIComponent(username)}&taskId=${encodeURIComponent(item.taskId)}&includeEvaluations=0&skipAutoEvalReady=1`),rows=>rows.length===1&&rows[0].trace_status==='success',120000);
    assert.equal(rows[0].framework,'opencode');
    return { experimentId: id, taskId: item.taskId, executionId:rows[0].upload_id,interactionCount:trace.interactions.length,score, evaluatorId: result.evaluatorId, summary: result.summary, facts: assertSkillAnswer(item.actualOutput, summary), detail };
  };
  const createExperiment = async (version, label) => {
    await page.goto(`${ctx.baseUrl}/skills?sessionId=${generated.id}`);
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
    const runModel=page.getByRole('button', { name: /^运行模型：/ });await runModel.waitFor({timeout:120000});await runModel.click();await page.locator(`[role="option"][title="${executionModel()}"]`).click();
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
  await stage('trace-ui','从 Trace 列表打开本轮数据集实验新链路，展示实际执行节点',async()=>{
    await page.goto(ctx.baseUrl+'/trace');const search=page.getByRole('textbox',{name:'搜索或过滤 trace',exact:true});await search.fill(baseline.taskId);await search.press('Escape');await page.getByRole('button',{name:`Trace ID ${baseline.taskId}`,exact:true}).click();await page.waitForURL(url=>url.searchParams.get('taskId')===baseline.taskId);await page.getByRole('treeitem').first().waitFor();await shot('baseline-trace');return {taskId:baseline.taskId,executionId:baseline.executionId};
  });
  await stage('diagnosis','诊断本轮实验 Trace，核对接收快照、执行归属和界面证据跳转',async()=>{diagnosis=await diagnoseTrace(ctx,page,baseline,shot);return diagnosis;});
  await stage('optimization', '同一生成会话基线发起真实定向优化，保存最终候选、diff 和静态门禁', async () => {
    const feedback = optimizationPrompt;
    await page.goto(`${ctx.baseUrl}/skills?sessionId=${generated.id}`);
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
    }, Math.min(900000, ctx.executionConfig.timeouts.caseMs), 2000);
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
    if (!record.retestExperimentId) throw new Error('No complete final-candidate verification evidence; cannot pass or invent a retest UI entry; proof checks: ' + JSON.stringify(candidateVerificationDiagnostics(path.join(root, 'app/data/witty_insight.db'), username, record, dataset)));
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
  await stage('persistence','新建数据集题目和参考答案、基线 Trace、原日志保持不变，诊断和发布结果可重读',async()=>{
    const restored=await api(`/api/agent-datasets/${dataset.id}?user=${encodeURIComponent(username)}`);assert.equal(datasetBusinessHash(restored),datasetHash);assert.deepEqual(datasetWrites,[{path:'/api/agent-datasets',method:'POST'}]);
    const originalTrace=JSON.parse(fs.readFileSync(path.join(root,'private/baseline-trace.json'),'utf8'));const restoredTrace=await api(`/api/observe/session?taskId=${encodeURIComponent(baseline.taskId)}`);assertSameTraceSnapshot(originalTrace.interactions,restoredTrace.interactions);assert.equal(hash(logFile),logHash);
    const diagnostic=await api(`/api/observe/executions/${baseline.taskId}/agent-debug`);assert.equal(diagnostic.row.id,diagnosis.reportId);assert.equal(diagnostic.row.status,'done');page.off('request',observeDatasetWrites);
    return {datasetId:dataset.id,datasetHash,baselineTaskId:baseline.taskId,reportId:diagnosis.reportId,publishedVersion,originalLogUnchanged:true};
  });
}
