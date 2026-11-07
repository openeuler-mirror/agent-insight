import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {command} from '../shared/runtime.mjs';
import {cases} from '../shared/catalog.mjs';

function metadata(job,startedAt){
 assert.equal(job.mode,'probe');
 return {kind:'pipeline-probe',mode:'probe',runId:'probe-'+job.id,executionOrigin:'webhook-pipeline-probe',executionHost:os.hostname(),runnerLabel:process.env.E2E_RUNNER_LABEL||os.hostname(),startedAt,headSha:job.headSha,baseSha:job.baseSha,businessTestsExecuted:false,sourceCodeExecuted:false,npmTest:{status:'NOT_RUN',fullSuiteComplete:false},scenarios:cases.map(c=>({id:c.id,title:c.title,status:'NOT_RUN'}))};
}
export function failedProbe(job,executionStarted=false){
 const at=new Date().toISOString();return {...metadata(job,at),status:'FAIL',endedAt:at,reason:executionStarted?'探针未完成，查看受限执行日志':'PR 状态核对失败，探针未执行',process:{executed:executionStarted?null:false,exitCode:null,expired:false,proof:null}};
}
export async function executeProbe(job,work){
 const base=metadata(job,new Date().toISOString());
 const script="import assert from 'node:assert/strict';assert.equal(process.env.ATOMGIT_TOKEN,undefined);assert.equal(process.env.DEEPSEEK_API_KEY,undefined);console.log(JSON.stringify({jobId:process.argv[1],ok:true,pid:process.pid}));";
 const execution=await command(process.execPath,['--input-type=module','-e',script,job.id],{cwd:work,env:{PATH:process.env.PATH},log:path.join(work,'probe-process.log'),timeout:10000});
 let proof;try{proof=JSON.parse(execution.output.trim());}catch{}
 const status=execution.code===0&&!execution.expired&&proof?.ok===true&&proof.jobId===job.id?'PASS':'FAIL';
 return {...base,status,endedAt:new Date().toISOString(),process:{executed:true,exitCode:execution.code,expired:execution.expired,proof}};
}
export function assertProbeReport(report,job){
 assert.equal(job.mode,'probe');assert.equal(report.kind,'pipeline-probe');assert.equal(report.mode,'probe');
 assert.equal(report.runId,'probe-'+job.id);assert.equal(report.executionOrigin,'webhook-pipeline-probe');
 assert.equal(report.headSha,job.headSha);assert.equal(report.baseSha,job.baseSha);assert.ok(report.endedAt);
 assert.equal(report.businessTestsExecuted,false);assert.equal(report.sourceCodeExecuted,false);assert.equal(report.npmTest?.status,'NOT_RUN');
 assert.equal(report.scenarios?.length,cases.length);assert.ok(cases.every(c=>report.scenarios.filter(s=>s.id===c.id&&s.status==='NOT_RUN').length===1));
 assert.ok(['PASS','FAIL'].includes(report.status));
 if(report.status==='PASS'){assert.equal(report.process?.executed,true);assert.equal(report.process?.exitCode,0);assert.equal(report.process.expired,false);assert.equal(report.process.proof?.ok,true);assert.equal(report.process.proof.jobId,job.id);assert.ok(Number.isSafeInteger(report.process.proof.pid)&&report.process.proof.pid>0);}
}
export function renderProbe(report,job){
 assertProbeReport(report,job);
 const markdown=[report.status==='PASS'?'固定子进程探针通过':'固定子进程探针失败',`仓库：${job.repository}；PR：!${job.pr}`,`源提交：${job.headSha}`,`目标提交：${job.baseSha}`,`任务：${job.id}`,`执行节点：${report.runnerLabel||report.executionHost||'未记录'}`,report.process.executed===true?`固定 Node 子进程退出码：${report.process.exitCode}；超时：${report.process.expired?'是':'否'}`:`固定 Node 子进程：${report.process.executed===false?'未执行':'未确认'}；${report.reason||''}`,'本报告根据当前控制流程状态生成，覆盖 Webhook 验签、平台 PR/提交核对、队列与固定探针结果。评论发布与正文读回是后续步骤，以独立的 delivery.json 确认记录为准。','UT：未执行；五个业务用例：未执行；源码拉取/合并及 PR 代码执行：未执行；模型调用：未执行。','本结果仅验证控制流程，不代表业务测试通过。'].join('\n\n');
 const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 return {markdown,html:`<!doctype html><html lang="zh"><meta charset="utf-8"><title>Webhook 流程探针</title><body><pre style="white-space:pre-wrap;font:16px system-ui">${esc(markdown)}</pre></body></html>`};
}
