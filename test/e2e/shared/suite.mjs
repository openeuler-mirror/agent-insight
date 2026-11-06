import { cases } from './catalog.mjs';
import { scenarioResult, redact } from './core.mjs';

export function parseUtResult(log, execution) {
  const counts = {};
  const failures = [];const fileTimeouts=[];
  let failedFile;
  for (const line of log.replace(/\x1b\[[0-9;]*m/g,'').split('\n')) {
    const deadline=line.match(/^E2E_UT_FILE_TIMEOUT (\{.*\}) test file timeout$/);if(deadline){try{const value=JSON.parse(deadline[1]);if(typeof value.file==='string'&&Number.isSafeInteger(value.timeoutMs))fileTimeouts.push(value);}catch{}}
    const match = line.match(/^(?:#|ℹ) (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/);
    if (match) counts[match[1]] = Number(match[2]);
    const location=line.match(/^test at (test\/[^\r\n]+)$/);if(location)failedFile=location[1];
    const failed=line.match(/^\s*✖ (.+?)(?: \([\d.]+ms\))?$/);
    if(failedFile&&failed&&failures.length<200){failures.push({file:failedFile,title:redact(failed[1])});failedFile=undefined;}
  }
  const runnerInterrupted = !!(execution.expired || execution.signal || execution.code === null);
  const interrupted=runnerInterrupted||fileTimeouts.length>0;
  const hasSummary = ['tests','pass','fail','cancelled','skipped','todo'].every(key => Number.isSafeInteger(counts[key]));
  const consistent = hasSummary && counts.tests > 0 && counts.tests === counts.pass+counts.fail+counts.cancelled+counts.skipped+counts.todo;
  const runnerCompleted=consistent&&!runnerInterrupted;
  const fullSuiteComplete = runnerCompleted && !fileTimeouts.length;
  return { status: fileTimeouts.length ? 'FAIL' : !fullSuiteComplete || (counts.pass === 0 && counts.fail === 0 && counts.cancelled === 0) ? 'BLOCKED' : execution.code === 0 && counts.fail === 0 && counts.cancelled === 0 ? 'PASS' : 'FAIL',
    exitCode: execution.code, interrupted, runnerCompleted, fullSuiteComplete, countsAreLowerBound: !fullSuiteComplete,
    observedSummary: hasSummary ? counts : null, failures, fileTimeouts,
    reason: fileTimeouts.length ? '测试文件进程超时中断，汇总计数仅为观测下限，不能声称全套测试执行完整' : interrupted ? '测试进程中断，不能给出完整通过结论' : !consistent ? '缺少有效的全套尾部汇总' : counts.fail ? '失败尚未逐项归因；不能将环境依赖失败直接认定为产品缺陷' : counts.pass === 0 ? '没有实际通过的用例，不能将全部跳过记为通过' : '' };
}

export async function executeSuite({ mode, caseModes = {}, selected = cases.filter(c=>!c.mergedInto).map(c=>c.id), runCase, runMockCase, runUt, runBuild, isCancelled=()=>false, onUpdate = async()=>{} }) {
  if (!['real','mock','mixed'].includes(mode)) throw Error('Mode must be real, mock or mixed');
  if(selected.some(id=>!['real','mock'].includes(caseModes[id]||(mode==='mixed'?undefined:mode))))throw Error('Missing or invalid case mode');
  if(selected.includes('005'))throw Error('Scenario 005 is retired and merged into 003');
  if (!selected.length || selected.some(id=>!cases.some(c=>c.id===id))) throw Error('Unknown scenario');
  const report = { mode, startedAt: new Date().toISOString(), selected,
    scenarios: cases.map(c=>({id:c.id,title:c.title,status:'NOT_RUN',...(selected.includes(c.id)?{mode:caseModes[c.id]||mode}:{reason:c.mergedInto?'已并入 '+c.mergedInto+'，本轮不重复执行':'按本轮范围配置未执行'}),stages:[]})), npmTest:{status:'NOT_RUN'}, status:'RUNNING' };
  if(runBuild){
    report.productionBuild={status:'RUNNING'};await onUpdate(report);
    try{report.productionBuild=await runBuild();}catch{report.productionBuild={status:'FAIL',reason:'生产编译失败，查看受限编译日志'};}
    if(report.productionBuild.status!=='PASS'){
      report.status=report.productionBuild.status==='FAIL'?'FAIL':'BLOCKED';report.endedAt=new Date().toISOString();
      for(const row of report.scenarios.filter(row=>selected.includes(row.id)))row.reason='生产编译未通过，未执行后续 UT/E2E';await onUpdate(report);return report;
    }
  }
  if (runUt) {
    report.npmTest={status:'RUNNING',fullSuiteComplete:false};await onUpdate(report);
    const utStartedAt=new Date().toISOString();
    try { report.npmTest = await runUt(); }
    catch { report.npmTest = {status:'BLOCKED',fullSuiteComplete:false,reason:'UT 执行器异常，详见受限日志'}; }
    Object.assign(report.npmTest,{startedAt:utStartedAt,endedAt:new Date().toISOString(),durationMs:Date.now()-Date.parse(utStartedAt)});
    await onUpdate(report);
  }
  report.e2eStartedAt=new Date().toISOString();
  for (const row of report.scenarios.filter(row=>selected.includes(row.id))) {
    if(isCancelled())break;
    if (row.mode === 'mock' && !runMockCase) Object.assign(row,{status:'BLOCKED',reason:'该场景的外部依赖 Mock 适配尚未完成；没有执行真实模型调用'});
    else {
      row.status='RUNNING'; await onUpdate(report);
      try {
        const result = await (row.mode==='mock'?runMockCase:runCase)(row.id,row.mode);
        Object.assign(row, result, {id:row.id,title:row.title});
        if (result.status === 'PASS') Object.assign(row, scenarioResult(result.stages || [], row.id));
      } catch { Object.assign(row,{status:'FAIL',reason:'场景执行器异常，详见本轮受限日志'}); }
    }
    await onUpdate(report);
  }
  report.e2eEndedAt=new Date().toISOString();report.e2eDurationMs=Date.parse(report.e2eEndedAt)-Date.parse(report.e2eStartedAt);
  const results=[...report.scenarios.filter(row=>selected.includes(row.id)),...(runUt?[report.npmTest]:[])];
  if(isCancelled())report.interrupted=true;
  report.status=isCancelled()?'BLOCKED':results.some(r=>r.status==='FAIL')?'FAIL':results.every(r=>r.status==='PASS')?'PASS':'BLOCKED';
  report.endedAt=new Date().toISOString();await onUpdate(report);
  return report;
}

export function renderSummary(report) {
  const esc = x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const label={PASS:'通过',FAIL:'失败',BLOCKED:'阻塞',PARTIAL:'不完整',NOT_RUN:'未执行',RUNNING:'执行中'};
  const duration=ms=>Number.isFinite(ms)?(ms/1000).toFixed(1)+' 秒':'—';
  const rows=report.scenarios.map(row=>[row.id+' '+row.title,row.mode||'—',label[row.status]||row.status,row.reason||(()=>{const failed=row.stages?.find(s=>['FAIL','BLOCKED'].includes(s.status));return failed?`${failed.id}：${String(failed.actual||failed.status).slice(0,300)}`:row.firstProblem||'—';})(),duration(row.durationMs)]);
  const build=report.productionBuild;const buildText=`生产编译：${label[build?.status]||'未执行'}；耗时：${duration(build?.durationMs)}；BUILD_ID：${build?.buildId||'—'}；${build?.reason||''}${build?.log?'；日志：'+build.log:''}`;
  const ut=report.npmTest, c=ut?.observedSummary;
  const utText=`UT：${label[ut?.status]||'未执行'}；`+(c?`总数${ut.countsAreLowerBound?'（观测下限）':''} ${c.tests}，通过 ${c.pass}，失败 ${c.fail}，跳过 ${c.skipped}，取消 ${c.cancelled}，TODO ${c.todo??0}；`:'计数未知；')+`运行器结束：${(ut?.runnerCompleted??ut?.fullSuiteComplete)?'是':'否'}；执行完整：${ut?.fullSuiteComplete?'是':'否'}；中断：${ut?.interrupted?'是':'否'}；文件进程超时 ${ut?.fileTimeouts?.length||0} 项。`;
  const clean = x=>redact(String(x)).replace(/\|/g,'／').replace(/[\r\n]+/g,' ');
  const dirty=report.dirtyWorkingTree?'（本地未提交改动，不能视为该提交的 PR 检查）':'';
  const origin=({'server-isolated-source-snapshot':'服务器源码快照验证（非 Webhook PR 检查）','isolated-pr-merge':'PR 合并提交隔离验证','local-working-tree':'本地工作树验证'})[report.executionOrigin]||'未标记来源';
  const configText=report.configuration?`配置：${report.configuration.settings.profile}；SHA256 ${report.configuration.hash}；模型 ${report.configuration.settings.model.modelName}；Base URL ${report.configuration.settings.model.baseUrl}`:'';
  const provenance=`来源：${origin}；运行：${report.runId||'—'}`;
  const timing=`E2E 耗时：${duration(report.e2eDurationMs)}；UT 耗时：${duration(ut?.durationMs)}`;
  const identity=report.account?`账号：${report.account}；通道：${report.lane||'manual'}`:'';
  const oomKills=Number(String(report.resources?.['memory.events']||'').match(/^oom_kill\s+(\d+)$/m)?.[1]||0);
  const resourceNote=oomKills>0?`本轮容器发生 OOM，终止进程 ${oomKills} 次；相关失败需结合运行日志归因，不能直接视为产品缺陷。`:'';
  const scope=report.selected?`本轮范围：${report.selected.join('、')}；其余场景未执行。`:'';
  const markdown=[`模式：${report.mode}；结果：${label[report.status]||report.status}`,provenance,identity,scope,configText,timing,`运行：${report.runId||'—'}；提交：${report.testedSha||'—'}${dirty}`,'',buildText,utText,ut?.reason||'',resourceNote,'','| 场景 | 模式 | 结果 | 原因 | 耗时 |','|---|---|---|---|---|',...rows.map(r=>'| '+r.map(clean).join(' | ')+' |'),'','未执行、阻塞和不完整不计为通过。'+(report.mode!=='real'?'Mock场景不验证真实模型的回答质量和服务可用性。':'')].join('\n');
  const html=`<!doctype html><html lang="zh"><meta charset="utf-8"><title>E2E 报告</title><style>body{font:16px system-ui;max-width:1000px;margin:32px auto;padding:16px}table{border-collapse:collapse;width:100%}td,th{padding:10px;border:1px solid #ddd;text-align:left}pre{white-space:pre-wrap}</style><h1>生产编译、UT 与 E2E</h1><p>${esc(buildText)}</p><p>${esc(scope)}</p><p>模式：${esc(report.mode)}；结果：${esc(label[report.status]||report.status)}；提交：${esc(report.testedSha)}</p><p>${esc(utText)}</p><p>${esc(timing)}</p><table><tr><th>场景</th><th>模式</th><th>结果</th><th>原因</th><th>耗时</th></tr>${rows.map(r=>'<tr>'+r.map(v=>`<td>${esc(redact(v))}</td>`).join('')+'</tr>').join('')}</table><p>报告由代码生成；未执行、阻塞和不完整不计通过。${report.mode!=='real'?'Mock场景不证明真实模型依赖可用。':''}</p></html>`;
  const failureDetails=ut?.failures?.length?`<details><summary>UT 失败用例（${ut.failures.length} 项，归因待核实）</summary><ul>${ut.failures.map(f=>`<li>${esc(f.title)} — ${esc(f.file)}</li>`).join('')}</ul></details>`:'';
  const traces=report.scenarios.flatMap(s=>(s.traces||[]).map(t=>({caseId:s.id,...t})));
  const stageDetails=report.scenarios.filter(s=>s.stages?.length).map(s=>`<details><summary>${esc(s.id)} 阶段结果</summary><ul>${s.stages.map(t=>`<li>${esc(t.id)}：${esc(label[t.status]||t.status)}${['FAIL','BLOCKED'].includes(t.status)?' — '+esc(redact(String(t.actual||''))):''}</li>`).join('')}</ul></details>`).join('');
  const traceDetails=traces.length?`<details><summary>本轮 Trace 清单（${traces.length}）</summary><ul>${traces.map(t=>`<li>${esc(t.caseId)} — ${esc(t.taskId)}</li>`).join('')}</ul></details>`:'';
  return {markdown,html:html.replace('</html>',`<p>${esc(provenance)}</p><p>${esc(configText)}</p><p>${esc(identity)}</p><p>${esc(dirty)}</p><p>${esc(ut?.reason||'')}</p><p>${esc(resourceNote)}</p>${failureDetails}${stageDetails}${traceDetails}</html>`)};
}
