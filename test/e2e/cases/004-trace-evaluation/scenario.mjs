import {executionModel} from '../../shared/model-config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import { loginAndModel } from '../../shared/browser-setup.mjs';
import { command, poll, runtimeEnv, writePrivate } from '../../shared/runtime.mjs';
import { assertSnapshot, assertSkillAnswer, toolJsonObjects, semanticTraceHash, assertSameTraceSnapshot, assertDiagnosticBinding } from '../../shared/skill-evidence.mjs';
import { traceBaselineFiles } from './trace-only-contract.mjs';
import { verifyOptimizationReopen, reopenTraceExperiment } from './trace-only-reopen.mjs';
import { businessTraceAudit, assertFactComparison, assertNativeSkillBinding, assertSkillVerification, assertTraceOnlyRequest, assertTraceOnlyResult, assertFourFieldSummary, assertLoadedSkill, decodeTraceInput, assertDatasetFreeVerification, interactionProof } from './trace-only-evidence.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
export async function scenario004(ctx) {
  const { root, project, runId, baseUrl, stage } = ctx;
  ctx.caseId = '004';
  const browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1600, height: 1100 } });
  await context.tracing.start({ screenshots: false, snapshots: true, sources: false });
  const page = await context.newPage();page.setDefaultTimeout(45000);page.setDefaultNavigationTimeout(90000);
  const responseFor = (...args) => { const promise = page.waitForResponse(...args);promise.catch(() => {});return promise; };
  const requestFor = (...args) => { const promise = page.waitForRequest(...args);promise.catch(() => {});return promise; };
  const shot = label => page.screenshot({ path: path.join(root, `trace-only-${label}.png`), fullPage: true, animations: 'disabled', mask: [page.locator('input,textarea')] });
  const datasetRequests = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (/^\/api\/(agent-datasets|datasets)(\/|$)/.test(url.pathname)) datasetRequests.push({ path: url.pathname, view: url.searchParams.get('view'), method: request.method() });
  });
  const traceSnapshots={};
  let files, skill, version, env, workspace, skillDir, logFile, prompt, baseline, candidate, firstExperiment, secondExperiment, diagnosis, workSession, record, datasetSnapshot;
  const name = `e2e-messages-trace-${runId}`, marker = `E2E-${runId}-004`;
  const database = path.join(root, 'app/data/witty_insight.db');
  const read = fn => { const db = new DatabaseSync(database, { readOnly: true });try { return fn(db); } finally { db.close(); } };
  const datasets = () => read(db => db.prepare('SELECT id, user, name, targetSkill, casesJson, referenceCasesJson, caseCount FROM AgentEvalDataset WHERE user=? ORDER BY id').all(ctx.account.username));
  const traceAudit=()=>read(db=>businessTraceAudit(db.prepare('SELECT taskId, query, agentName FROM Execution WHERE user=? ORDER BY taskId').all(ctx.account.username),prompt));
  const businessIds=()=>traceAudit().businessTraceIds;
  const installFiles = snapshot => {
    for (const [file, content] of Object.entries(snapshot)) { assert.ok(!file.startsWith('/') && !file.split('/').includes('..'));const dest = path.join(skillDir, file);fs.mkdirSync(path.dirname(dest), { recursive: true });fs.writeFileSync(dest, content); }
    const actual = Object.fromEntries(Object.keys(snapshot).map(file => [file, fs.readFileSync(path.join(skillDir, file), 'utf8')]));return assertSnapshot(snapshot, actual);
  };
  try {
    await loginAndModel(ctx, page);ctx.clientKinds = ['ordinary'];await ctx.prepareClients(ctx);
    const { api } = ctx;const username = ctx.account.username;
    const sessionApi = id => `/api/skill-workbench/sessions/${id}?user=${encodeURIComponent(username)}`;
    const nativeRun = async (label, snapshot, summary) => {
      const input=path.join(root,`private/${label}-workspace-request.json`),manifest=path.join(root,`private/${label}-workspace.json`);
      writePrivate(input,{executable:path.join(root,'ordinary/bin/opencode'),clientId:ctx.clients[0].clientId,skill:{name,version,files:snapshot}});
      const prepared=await command(process.execPath,[path.join(project,'test/e2e/shared/native-skill-workspace.mjs'),input,manifest],{env,cwd:project,log:path.join(root,`private/${label}-workspace.log`),timeout:90000});assert.equal(prepared.code,0,'Native Skill workspace preparation failed; see private workspace log');
      const native=JSON.parse(fs.readFileSync(manifest));workspace=native.cwd;skillDir=path.join(workspace,'.opencode/skills',name);
      const hashes = assertSnapshot(snapshot,Object.fromEntries(Object.keys(snapshot).map(file=>[file,fs.readFileSync(path.join(skillDir,file),'utf8')]))), log = path.join(root, `private/${label}-native.log`);
      const result = await command('opencode', ['run', '--standalone', '--auto', '--agent', 'build', '--model', executionModel(), '--format', 'json', '--title', `${marker}-${label}`, prompt], { env:{...env,...native.env}, cwd: workspace, log, timeout: 300000 });
      assert.equal(result.code, 0, `${label} native task failed (timeout=${result.expired}); see private/${label}-native.log`);
      const events = fs.readFileSync(log, 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const final = events.filter(e => e.type === 'text' && e.part?.text).at(-1);assert.ok(final);const taskId = final.sessionID || final.sessionId;assert.ok(taskId);
      const rows = await poll(() => api(`/api/observe/data?user=${encodeURIComponent(username)}&taskId=${taskId}&includeEvaluations=0&skipAutoEvalReady=1`), rows => rows.length === 1 && rows[0].trace_status === 'success', 120000);
      const session = await poll(() => api(`/api/observe/session?taskId=${taskId}`), value => value.interactions?.some(m => m.role === 'assistant' && String(m.content).includes('351')), 120000);
      assert.equal(session.user, username);const output = session.interactions.filter(m => m.role === 'assistant' && String(m.content).trim()).at(-1).content;
      if (summary) assertFourFieldSummary(output);else assertSkillAnswer(output, false);
      writePrivate(path.join(root, `private/${label}-trace.json`), session);
      const tools = session.interactions.flatMap(m => m.tool_calls || []);
      const binding=assertNativeSkillBinding(rows[0],tools,{name,version});
      const loaded = assertLoadedSkill(tools, path.join(skillDir, 'SKILL.md'), snapshot['SKILL.md']);
      assert.ok(tools.some(t => {const args = String(t.function?.arguments || t.arguments || '');return args.includes(logFile) && args.includes('analyze_logs.py');}), 'Actual analysis script invocation missing');
      const scriptResult=tools.filter(t=>String(t.function?.arguments||'').includes('analyze_logs.py')&&String(t.function?.arguments||'').includes(logFile)).flatMap(t=>toolJsonObjects(t.output)).find(value=>value?.root_ssh_failures===351&&value?.total_lines===2000&&value?.top_source==='150.183.249.110'&&value?.top_source_failures===80);
      assert.ok(scriptResult?.evidence?.length,'Actual script JSON evidence missing');for(const line of scriptResult.evidence)assert.ok(fs.readFileSync(logFile,'utf8').includes(line),'Script cited fabricated log evidence');
      assertFactComparison(output,scriptResult);
      assert.equal(sha(fs.readFileSync(logFile)), '6d50cefa82380651f910df35fda0995a237a3c788b7b2e3d2d37e51fb9debca9');
      for (const [file, content] of Object.entries(snapshot)) assert.equal(fs.readFileSync(path.join(skillDir, file), 'utf8'), content, 'Native Agent modified installed Skill');
      writePrivate(path.join(root, `private/${label}-trace.json`), session);
      assert.equal(decodeTraceInput(rows[0].query), prompt, 'Collected Trace task differs from original task');
      traceSnapshots[label]=session.interactions;
      const persisted=read(db=>db.prepare('SELECT interactions FROM Session WHERE taskId=?').get(taskId));const traceProof=interactionProof(session.interactions,JSON.parse(persisted.interactions));
      return { taskId, executionId: rows[0].upload_id, input: rows[0].query, output, hashes, loaded, binding, scriptResult, snapshotPublished: !summary, interactionHash: semanticTraceHash(session.interactions), diagnosticInteractionHash: traceProof.storedHash, interactionCount: session.interactions.length };
    };
    const evaluate = async (trace, label) => {
      const before = businessIds();
      await page.goto(baseUrl + '/experiments');await page.getByRole('button', { name: '新建实验', exact: true }).first().click();
      await page.getByPlaceholder('如：客服 Agent 回答质量基线', { exact: true }).fill(`e2e-no-dataset-${label}-${runId}`);
      await page.locator('select').filter({ has: page.locator('option[value="build"]') }).selectOption('build');
      await page.getByRole('button', { name: '下一步：Trace 来源 →', exact: true }).click();
      await page.getByPlaceholder('模糊搜索 Trace ID 或任务输入…', { exact: true }).fill(trace.taskId);
      await page.getByPlaceholder('模糊搜索 Trace ID 或任务输入…', { exact: true }).press('Enter');
      const row = page.locator('tbody tr').filter({ has: page.getByRole('checkbox') });await poll(()=>row.count(), n=>n===1,15000,100);await row.click();
      await page.getByRole('button', { name: '下一步：预期答案 →', exact: true }).click();
      await page.getByRole('button', { name: '下一步：评估器与执行 →', exact: true }).click();
      await page.getByRole('searchbox', { name: '搜索评估器', exact: true }).fill('任务完成度（无标准答案）');
      await page.getByText('任务完成度（无标准答案）', { exact: true }).click();
      const created = responseFor(r => new URL(r.url()).pathname === '/api/experiments' && r.request().method() === 'POST');
      await page.getByRole('button', { name: '🚀 开始实验', exact: true }).click();
      const response = await created, payload = response.request().postDataJSON();writePrivate(path.join(root, `private/${label}-experiment-request.json`), payload);assertTraceOnlyRequest(payload, trace);
      const result = await response.json();assert.ok(response.ok(), result.error);assert.ok(result.id);
      const detail = await poll(async()=>{const data=await api(`/api/experiments/${result.id}?user=${encodeURIComponent(username)}`);writePrivate(path.join(root,`private/${label}-experiment.json`),data);return data;},value=>{if(['failed','partial','cancelled'].includes(value.status))throw new Error(`${label} evaluation ${value.status}`);return value.status==='done';},300000,2000);
      const checked = assertTraceOnlyResult(detail, trace);assert.deepEqual(businessIds(), before, 'Existing Trace evaluation reran the business Agent');
      await page.getByText('任务完成度（无标准答案）', { exact: false }).first().waitFor();await shot(`${label}-evaluation`);
      return { ...checked, noBusinessRerun: true, url: new URL(page.url()).pathname, config: detail.configSnapshot, evaluatorConfigs: payload.evaluatorConfigs, evaluatorExecutionConfig: payload.evaluatorExecutionConfig };
    };
    await stage('trace-fixture', '上传两文件私有基线 B、保留完整真实日志，无目标 Skill 数据集', async () => {
      files = traceBaselineFiles(name);
      const form = new FormData();form.set('user', username);for (const [file, content] of Object.entries(files)) {form.append('files', new Blob([content]), path.basename(file));form.append('paths', `${name}/${file}`);}
      const response = await fetch(baseUrl + '/api/skills/upload', { method: 'POST', headers: { 'x-witty-api-key': ctx.account.apiKey }, body: form });const data = await response.json();assert.ok(response.ok, data.error);skill = data.skill;version = data.version.version;
      assert.equal(skill.name, name);assert.equal(skill.user, username);assert.equal(skill.visibility, 'private');
      const clientRoot = path.join(root,'ordinary');env = runtimeEnv(clientRoot, path.join(clientRoot, 'bin'));env.OPENCODE_DISABLE_MODELS_FETCH = 'true';env.AGENT_INSIGHT_HOST = baseUrl;env.AGENT_INSIGHT_API_KEY = ctx.account.apiKey;
      workspace = path.join(clientRoot, 'workspace');skillDir = path.join(workspace, '.opencode/skills', name);logFile = path.join(workspace, 'fixtures/messages');fs.mkdirSync(path.dirname(logFile),{recursive:true});fs.copyFileSync(path.join(project,'public/example/messages'),logFile);
      const hashes = assertSnapshot(files,files);datasetSnapshot = datasets();assert.ok(!datasetSnapshot.some(d => d.targetSkill === name));
      writePrivate(path.join(root,'private/baseline-files.json'),files);
      prompt = `${marker}：使用 ${name} 分析 ${logFile}。请先通过原生 skill 工具加载 ${name}，遵守其步骤。请统计 root 账户认证失败的次数，找出次数最多的来源及其次数，并给出日志证据。只分析提供的离线日志，不连接远程主机，不读取当前机器的 /var/log，不修改文件。`;
      writePrivate(path.join(root,'private/original-task.json'),{prompt,logFile,skillDir});return {skillName:name,version,skillId:skill.id,fileCount:Object.keys(files).length,hashes,datasetId:null,targetSkillDatasetCount:0};
    });
    await stage('baseline-run', '正式采集真实 OpenCode 基线任务，事实正确且保存原任务和实际加载证据', async () => {baseline = await nativeRun('baseline',files,false);return baseline;});
    await stage('skill-binding','原生 Skill 加载内容与正式上传基线一致，Trace 关联正确名称及版本',async()=>{assert.ok(baseline.loaded.nativeLoad);return {...baseline.binding,hashes:baseline.hashes};});
    await stage('trace-ui','从列表打开本轮已有 Trace，确认实际输入和结果',async()=>{
      await page.goto(baseUrl+'/trace');const search=page.getByRole('textbox',{name:'搜索或过滤 trace',exact:true});await search.fill(baseline.taskId);await search.press('Escape');await page.getByRole('button',{name:`Trace ID ${baseline.taskId}`,exact:true}).click();await page.waitForURL(url=>url.searchParams.get('taskId')===baseline.taskId);await page.getByRole('treeitem').first().waitFor();await shot('baseline-trace');return {taskId:baseline.taskId,executionId:baseline.executionId};
    });
    await stage('baseline-evaluation','页面新建已有 Trace 实验，无数据集、答案或上下文，唯一评估器完成度 ≥80',async()=>{firstExperiment=await evaluate(baseline,'baseline');return firstExperiment;});
    await stage('diagnosis','从原 Trace 进入真实智能诊断，报告及锚点对应原链路',async()=>{
      await page.goto(baseUrl+`/trace?taskId=${baseline.taskId}`);
      const link=page.locator(`a[href="/fault?taskId=${baseline.taskId}"]`);await link.first().click();await page.waitForURL(url=>url.pathname==='/fault' && url.searchParams.get('taskId')===baseline.taskId);
      const accepted=responseFor(r=>new URL(r.url()).pathname===`/api/observe/executions/${baseline.taskId}/agent-debug` && r.request().method()==='POST');await page.getByRole('button',{name:'启动智能诊断',exact:true}).click();const acceptedResponse=await accepted;assert.ok(acceptedResponse.ok());const acceptedSnapshot=await acceptedResponse.json();writePrivate(path.join(root,'private/diagnosis-accepted.json'),acceptedSnapshot);
      diagnosis=await poll(async()=>{const data=await api(`/api/observe/executions/${baseline.taskId}/agent-debug`);writePrivate(path.join(root,'private/diagnosis.json'),data);return data;},value=>{if(value.row?.status==='failed')throw new Error(`Diagnosis failed: ${value.row.errorMessage}`);return value.row?.status==='done' && value.report;},480000,2000);
      const report=diagnosis.report;assert.equal(report.executionId,baseline.executionId);assert.equal(report.status,'done');baseline.diagnosticInteractionHash=assertDiagnosticBinding(acceptedSnapshot,diagnosis,baseline.executionId);assertSameTraceSnapshot(traceSnapshots.baseline,JSON.parse(read(db=>db.prepare('SELECT interactions FROM Session WHERE taskId=?').get(baseline.taskId)).interactions));assert.ok(report.stats.llmCallCount>0,'Diagnosis must actually call model');assert.ok(report.stats.stepCount>0);assert.ok(!report.skippedReason);
      const anchorsResult=await command(process.execPath,['--import','tsx','-e',`const fs=require('node:fs');const {buildFaultPathSteps}=require('./src/lib/engine/observability/fault-path.ts');const trace=JSON.parse(fs.readFileSync(process.argv[1]));console.log(JSON.stringify(buildFaultPathSteps(trace.interactions,'zh').map(s=>({id:s.id,index:s.stepIndex,interaction:s.interactionIndex}))));`,path.join(root,'private/baseline-trace.json')],{cwd:project,timeout:30000});assert.equal(anchorsResult.code,0,'Cannot resolve original Trace anchors');const anchors=JSON.parse(anchorsResult.output.trim());
      const references=[];const walk=value=>{if(!value || typeof value!=='object')return;if(value.anchorId){assert.ok(anchors.some(a=>a.id===value.anchorId),'Diagnosis references a nonexistent Trace anchor');references.push(value.anchorId);}for(const item of Object.values(value))walk(item);};walk(report);
      for(const step of report.stepRecords||[]){assert.ok(Number.isInteger(step.sourceInteractionIndex) && step.sourceInteractionIndex>=0 && step.sourceInteractionIndex<baseline.interactionCount);}
      await page.getByRole('region',{name:'诊断任务概况',exact:true}).getByText('报告已返回',{exact:true}).waitFor();
      let verifiedJumps=0;const issueAnchors=[...new Set((report.issues||[]).map(issue=>issue.anchorId).filter(Boolean))];
      for(const id of issueAnchors){const index=anchors.find(a=>a.id===id).index;await page.getByRole('button',{name:`Trace #${index}`,exact:true}).first().click();const target=page.locator(`[title="左侧节点 #${index}"]`);await target.waitFor();await poll(()=>target.getAttribute('style'),value=>value?.includes('var(--primary)'),5000,50);verifiedJumps++;}
      await shot('diagnosis');return {reportId:diagnosis.row.id,executionId:report.executionId,interactionHash:report.interactionHash,modelLabel:report.modelLabel,llmCallCount:report.stats.llmCallCount,issueCount:report.stats.issueCount,validatedAnchors:[...new Set(references)],verifiedJumps};
    });
    await stage('skill-verification','真实 Skills 步骤核验完成，本例全部核心动作均有覆盖证据',async()=>{
      const data=await poll(async()=>{const value=await api(`/api/observe/executions/${baseline.taskId}/agent-debug/skills-analysis`);writePrivate(path.join(root,'private/skills-verification.json'),value);return value;},value=>{if(value.row?.status==='failed')throw new Error(`Skills verification failed: ${value.row.errorMessage}`);return value.row?.status==='done';},480000,2000);
      const parsed=read(db=>db.prepare('SELECT flowJson FROM ParsedFlow WHERE skillId=? AND version=? AND user=?').get(skill.id,version,username));assert.ok(parsed?.flowJson);const flow=JSON.parse(parsed.flowJson);writePrivate(path.join(root,'private/skill-reference-flow.json'),flow);
      const proof=assertSkillVerification(data,baseline.diagnosticInteractionHash,{flow,scriptResult:baseline.scriptResult});
      const section=page.getByRole('button',{name:/Skills 步骤核验/}).filter({hasText:'已有结果'});await section.waitFor();if(await section.getAttribute('aria-expanded')!=='true')await section.click();await section.scrollIntoViewIfNeeded();await shot('skill-verification');return proof;
    });
    await stage('optimization','从管理中心选择本例基线，真实优化四字段摘要，记录无行为用例跳过，不创建数据集',async()=>{
      await page.goto(baseUrl+'/skills');await page.getByRole('button',{name:'新对话',exact:true}).click();await page.getByRole('button',{name:'从 Skill 管理中心选择',exact:true}).click();const picker=page.getByRole('dialog',{name:'选择 Skill',exact:true});await picker.getByPlaceholder('搜索 Skill 名称或描述').fill(name);await picker.getByPlaceholder('搜索 Skill 名称或描述').press('Enter');const card=picker.locator('article').filter({has:page.getByText(name,{exact:true})});await card.getByRole('button',{name:'选择',exact:true}).click();
      await poll(()=>page.getByRole('combobox',{name:'选择 Skill',exact:true}).inputValue(),value=>value===name,15000,100);
      const boundSessions=await api(`/api/skill-workbench/sessions?user=${encodeURIComponent(username)}`);workSession=boundSessions.sessions.find(s=>s.skillName===name);assert.ok(workSession);
      const initialized=await api(`/api/skill-workbench/sessions/${workSession.id}/optimization`,{method:'POST',body:JSON.stringify({user:username})});assert.ok(initialized.session.optSessionId);await page.reload();
      const feedback=`这是追加输出格式的单一需求。必须保留 SKILL.md 现有全部字符和章节，不修改、删除或重排任何原有内容；所有脚本逐字不变，禁止新增文件、功能、依赖或数据集。只在文件末尾追加一个 Step 3：完成原有中文分析和日志证据后，在回答末尾追加一行 E2E-SUMMARY，后接 JSON 对象，严格只含 total_lines、root_ssh_failures、top_source、top_source_failures 四字段，四个值全部直接取 Step 1 有效 JSON 的同名顶层字段，并在输出前逐项核对一致，不硬编码路径、IP 或数字。不要更改脚本输入契约。来源为 Trace ${baseline.taskId}、实验 ${firstExperiment.experimentId}、诊断 ${diagnosis.row.id}。`;
      await page.getByPlaceholder('填写本轮定向诉求；留空则优化当前问题…',{exact:true}).fill(feedback);
      const request=requestFor(r=>new URL(r.url()).pathname==='/api/skill-opt/chat' && r.method()==='POST');await page.locator('[aria-label="Skill 快捷操作"]').getByRole('button',{name:'Skill 优化',exact:true}).click();const sent=(await request).postDataJSON();assert.equal(sent.mock,false);assert.equal(sent.skillName,name);assert.equal(sent.baseVersion,version);writePrivate(path.join(root,'private/optimization-request.json'),sent);
      const sessions=await api(`/api/skill-workbench/sessions?user=${encodeURIComponent(username)}`);const items=sessions.sessions||sessions;workSession=items.find(s=>s.skillName===name);assert.ok(workSession);
      const complete=await poll(async()=>{const data=await api(sessionApi(workSession.id));writePrivate(path.join(root,'private/optimization-session.json'),data);return data.session;},value=>{const latest=value.optimizations[0],task=value.tasks.filter(t=>t.type==='optimization').at(-1);if(task?.status==='failed'||latest?.status==='optimization_failed')throw new Error('Optimization failed; see private/optimization-session.json');return latest && task?.status==='done' && latest.status!=='optimizing';},Math.min(900000,ctx.executionConfig.timeouts.caseMs),2000);
      record=complete.optimizations[0];assert.ok(record.diff.length);assert.deepEqual(Object.keys(record.candidateFiles).sort(),Object.keys(files).sort());for(const file of Object.keys(files).filter(f=>f!=='SKILL.md'))assert.equal(record.candidateFiles[file],files[file],`Unexpected change: ${file}`);assert.notEqual(record.candidateFiles['SKILL.md'],files['SKILL.md']);assert.ok(record.candidateFiles['SKILL.md'].startsWith(files['SKILL.md']),'Candidate changed existing Skill instructions rather than appending');assert.ok(record.candidateFiles['SKILL.md'].includes('E2E-SUMMARY'));assert.ok(record.staticEvaluationId);
      assert.equal(record.blockingIssues.length,0,'Candidate static quality gate failed');
      const blocks=read(db=>db.prepare('SELECT blocks FROM SkillOptMessage WHERE sessionId=? ORDER BY createdAt').all(complete.optSessionId)).flatMap(row=>JSON.parse(row.blocks));
      const verification=blocks.filter(b=>b.kind==='verification').at(-1);const skip=assertDatasetFreeVerification(verification?.detail);
      writePrivate(path.join(root,'private/verification.json'),verification);
      writePrivate(path.join(root,'private/candidate-files.json'),record.candidateFiles);writePrivate(path.join(root,'private/candidate.json'),record);assert.ok(!record.retestExperimentId,'Unexpected dataset-driven retest');assert.deepEqual(datasets(),datasetSnapshot);
      await shot('optimization');return {recordId:record.id,status:record.status,sessionPreparation:'formal optimization initialization API only; real targeted request submitted via UI',candidateContentHash:record.candidateContentHash,staticEvaluationId:record.staticEvaluationId,sourceRefs:record.sourceRefs,behavioralVerification:skip,candidateHashes:assertSnapshot(record.candidateFiles,record.candidateFiles)};
    });
    await stage('candidate-run','隔离安装最终候选，以完全相同原任务直接运行，实际读取日志并生成正确四字段摘要',async()=>{candidate=await nativeRun('candidate',record.candidateFiles,true);assert.notEqual(candidate.taskId,baseline.taskId);return {...candidate,summary:assertFourFieldSummary(candidate.output)};});
    await stage('candidate-evaluation','页面对新 Trace 再建无数据集实验，配置与评估器一致，完成度 ≥80',async()=>{secondExperiment=await evaluate(candidate,'candidate');assert.deepEqual(secondExperiment.evaluatorConfigs,firstExperiment.evaluatorConfigs);assert.deepEqual(secondExperiment.evaluatorExecutionConfig,firstExperiment.evaluatorExecutionConfig);return secondExperiment;});
    await stage('persistence','刷新重开实验与优化结果，旧版/旧 Trace 不变，数据集内容和引用无新增',async()=>{
      for(const item of [firstExperiment,secondExperiment]){await reopenTraceExperiment(page,baseUrl,item);const detail=await api(`/api/experiments/${item.experimentId}?user=${encodeURIComponent(username)}`);assertTraceOnlyResult(detail,item===firstExperiment?baseline:candidate);}
      const preserved={};for(const file of Object.keys(files))preserved[file]=(await api(`/api/skills/${skill.id}/versions/${version}/files/${file}?user=${encodeURIComponent(username)}`)).content;assertSnapshot(files,preserved);
      const original=await api(`/api/observe/session?taskId=${baseline.taskId}`);assert.equal(semanticTraceHash(original.interactions),baseline.interactionHash);assert.deepEqual(datasets(),datasetSnapshot);assert.deepEqual(businessIds(),[baseline.taskId,candidate.taskId].sort());
      for(const request of datasetRequests)assert.ok(request.path==='/api/agent-datasets' && request.method==='GET' && request.view==='summary',`Unexpected dataset access ${request.method} ${request.path} (${request.view})`);
      const ui=await verifyOptimizationReopen(page,baseUrl,workSession.id,name,record.candidateContentHash);const restored=(await api(sessionApi(workSession.id))).session.optimizations.find(o=>o.id===record.id);assert.ok(restored);assertSnapshot(record.candidateFiles,restored.candidateFiles);await shot('persisted');writePrivate(path.join(root,'private/dependency-audit.json'),{datasetRequests,unchangedDatasetIds:datasetSnapshot.map(d=>d.id),...traceAudit()});return {oldVersionPreserved:true,oldTracePreserved:true,experimentsReopened:true,candidatePreserved:true,optimizationUi:ui,datasetContentUnchanged:true,newDatasets:0,datasetRequests,...traceAudit()};
    });
  } catch(error) {
    try { await page.screenshot({path:path.join(root,'failure.png'),fullPage:true,mask:[page.locator('input,textarea,code,pre')]});writePrivate(path.join(root,'private/failure-ui.txt'),await page.locator('body').innerText()); } catch {}
    throw error;
  } finally {
    const file=path.join(root,'private/browser-trace.zip');await context.tracing.stop({path:file});fs.chmodSync(file,0o600);await browser.close();
  }
}
