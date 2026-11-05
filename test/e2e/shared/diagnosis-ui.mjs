import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {command,poll,writePrivate} from './runtime.mjs';
export async function diagnoseTrace(ctx,page,trace,shot){
 const {baseUrl,api,root,project}=ctx;
 await page.goto(baseUrl+`/trace?taskId=${trace.taskId}`);await page.locator(`a[href="/fault?taskId=${trace.taskId}"]`).first().click();await page.waitForURL(url=>url.pathname==='/fault'&&url.searchParams.get('taskId')===trace.taskId);
 const accepted=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/observe/executions/${trace.taskId}/agent-debug`&&r.request().method()==='POST');accepted.catch(()=>{});await page.getByRole('button',{name:'启动智能诊断',exact:true}).click();assert.ok((await accepted).ok());
 const diagnosis=await poll(async()=>{const d=await api(`/api/observe/executions/${trace.taskId}/agent-debug`);writePrivate(path.join(root,'private/diagnosis.json'),d);return d;},value=>{if(value.row?.status==='failed')throw new Error(`Diagnosis failed: ${value.row.errorMessage}`);return value.row?.status==='done'&&value.report;},480000,2000);
 const report=diagnosis.report;assert.equal(report.executionId,trace.executionId);assert.equal(report.status,'done');assert.equal(report.interactionHash,trace.diagnosticInteractionHash);assert.ok(report.stats.llmCallCount>0);assert.ok(report.stats.stepCount>0);assert.ok(!report.skippedReason);
 const result=await command(process.execPath,['--import','tsx','-e',`const fs=require('node:fs');const {buildFaultPathSteps}=require('./src/lib/engine/observability/fault-path.ts');const trace=JSON.parse(fs.readFileSync(process.argv[1]));console.log(JSON.stringify(buildFaultPathSteps(trace.interactions,'zh').map(s=>({id:s.id,index:s.stepIndex}))));`,path.join(root,'private/baseline-trace.json')],{cwd:project,timeout:30000});assert.equal(result.code,0,'Cannot resolve original Trace anchors');const anchors=JSON.parse(result.output.trim());
 const references=[];const walk=value=>{if(!value||typeof value!=='object')return;if(value.anchorId){assert.ok(anchors.some(a=>a.id===value.anchorId),'Diagnosis references a nonexistent Trace anchor');references.push(value.anchorId);}for(const item of Object.values(value))walk(item);};walk(report);
 for(const step of report.stepRecords||[])assert.ok(Number.isInteger(step.sourceInteractionIndex)&&step.sourceInteractionIndex>=0&&step.sourceInteractionIndex<trace.interactionCount);
 await page.getByRole('region',{name:'诊断任务概况',exact:true}).getByText('报告已返回',{exact:true}).waitFor();let verifiedJumps=0;
 for(const id of [...new Set((report.issues||[]).map(issue=>issue.anchorId).filter(Boolean))]){const index=anchors.find(a=>a.id===id).index;await page.getByRole('button',{name:`Trace #${index}`,exact:true}).first().click();const target=page.locator(`[title="左侧节点 #${index}"]`);await target.waitFor();await poll(()=>target.getAttribute('style'),v=>v?.includes('var(--primary)'),5000,50);verifiedJumps++;}
 const extra=await api(`/api/observe/executions/${trace.taskId}/agent-debug/skills-analysis`);await shot('diagnosis');
 return {reportId:diagnosis.row.id,executionId:report.executionId,interactionHash:report.interactionHash,llmCallCount:report.stats.llmCallCount,issueCount:report.stats.issueCount,validatedAnchors:[...new Set(references)],verifiedJumps,supplementalSkillsStatus:extra.row?.status||null,scope:'Main diagnosis and evidence navigation; all builtin Skill branches are not claimed as verified'};
}
