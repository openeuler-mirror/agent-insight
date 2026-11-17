import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {createIsolatedDatabase} from './helpers/isolated-database';
const database=createIsolatedDatabase();
import {prismaRaw as prisma} from '@/lib/storage/prisma';
import {withCoreWorkbenchRoute} from '@/lib/storage-core/workbench';
import {GET as getPoints} from '@/app/api/skills/by-name/[name]/optimization-points/route';
import {GET as getEvaluation} from '@/app/api/evaluation/[id]/route';
test.after(async()=>{await prisma.$disconnect();database.dispose();});

test('original optimization HTTP reads actual aggregate receipts, resolves history, and keeps legitimate static/feedback separate',async()=>{
 const conversion="console.log=(...args)=>console.error(...args);const fs=require('node:fs');const {buildCoreTriggerDerived}=require('./src/lib/storage-core/trigger-derived.ts');const input=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(buildCoreTriggerDerived(input.work,input.manifest,input.report)));";
 const script=`import json,subprocess
from services.storage.tests.test_trigger_derived import TriggerDerivedTests
x=TriggerDerivedTests();x.setUp()
try:
 stages=[]
 for key,hit,competitor in [('miss',False,False),('clean',True,False),('competing',True,True)]:
  value,handle,result,_=x.prepared(key,hit=hit,competitor=competitor)
  work=x.invoke('load_work',**handle)
  derived=json.loads(subprocess.check_output([${JSON.stringify(process.execPath)},'--import','tsx','-e',${JSON.stringify(conversion)}],input=json.dumps({'work':work,'manifest':work['runplan']['config']['core_trigger'],'report':result['evidence']['json']['coreTriggerResult']}).encode()))
  result['evidence']['json']['coreTriggerDerived']=derived
  x.complete(handle,result,key+':complete')
  issues=x.invoke('derived_list',kind='issue',skill_id='skill-a',owned_only=True)
  evaluations=x.invoke('derived_list',kind='evaluation',skill_id='skill-a',owned_only=True)
  stages.append({'issues':issues,'evaluations':evaluations,'frontier':x.invoke('derived_trigger_frontier',skill_id='skill-a'),'details':{row['id']:x.invoke('derived_detail',id=row['id']) for row in evaluations},'run':value['run']['id']})
  x.now+=10
 print(json.dumps(stages))
finally:x.doCleanups()
`;
 const stages=JSON.parse(execFileSync(process.env.PYTHON||'python3',['-c',script],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024}));
 await prisma.skill.create({data:{id:'skill-a',name:'checking',user:'legacy-alice',versions:{create:{version:0,content:'LATEST CONTENT MUST NOT REPLACE TESTED DESCRIPTION'}}}});
 for(const source of ['static','feedback','trigger'] as const){const evaluation=await prisma.evaluation.create({data:{id:'old-'+source,type:source,skillId:'skill-a',version:0,user:'legacy-alice',status:'ok'}});await prisma.skillIssue.create({data:{id:'old-'+source+'-issue',evaluationId:evaluation.id,source,skillId:'skill-a',version:0,user:'legacy-alice',dedupKey:'old-'+source,severity:'low',summary:'old '+source,suggestedFix:'retain legitimate '+source}});}
 const before={mode:process.env.AGENT_INSIGHT_TRACE_STORAGE,url:process.env.AGENT_INSIGHT_STORAGE_CORE_URL};process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';let stage=0;
 const fetcher:typeof fetch=async(url,options)=>{
  if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json({principal_id:'alice',username:'legacy-alice',workspace_id:'w',workspaces:[{workspace_id:'w'}]});
  const body=JSON.parse(String(options?.body)),current=stages[stage];
  if(body.action==='derived_list')return Response.json({value:body.kind==='issue'?current.issues:current.evaluations});
  if(body.action==='derived_lookup')return Response.json({value:current.evaluations.find((row:{id:string})=>row.id===body.id)});
  if(body.action==='derived_trigger_frontier')return Response.json({value:current.frontier});
  if(body.action==='derived_detail')return current.details[body.id]?Response.json({value:current.details[body.id]}):Response.json({error:'not found'},{status:404});
  throw Error('Unexpected RPC '+body.action);
 };
 const headers={authorization:'Bearer api_'+'T'.repeat(43)};
 const points=async(includeResolved=false)=>{const response=await withCoreWorkbenchRoute(new Request('http://localhost/api/skills/by-name/checking/optimization-points?version=0&user=forged'+(includeResolved?'&includeResolved=1':''),{headers}),request=>getPoints(request,{params:Promise.resolve({name:'checking'})}),{fetcher});assert.equal(response.status,200,await response.clone().text());return response.json();};
 try{
  let dto=await points();assert.equal(dto.issues.length,3);let trigger=dto.issues.find((row:{dedupKey:string})=>row.dedupKey==='trigger:checking');assert.ok(trigger.improvementSuggestion.includes('【当前 description】\ncheck'));assert.ok(!trigger.improvementSuggestion.includes('LATEST CONTENT'));assert.equal(trigger.source.url,'/skill-eval/trigger/checking?runId='+stages[0].run);
  const detail=await withCoreWorkbenchRoute(new Request('http://localhost/api/evaluation/'+trigger.id.replace('trigger-issue-','trigger-evaluation-'),{headers}),request=>getEvaluation(request,{params:Promise.resolve({id:stages[0].evaluations[0].id})}),{fetcher});assert.equal(detail.status,200,await detail.clone().text());assert.equal((await detail.json()).evaluation.generator,'trigger-evaluator@1.0');assert.ok(stages[0].details[stages[0].evaluations[0].id].skill.content.includes('description: check'));
  stage=1;dto=await points();assert.equal(dto.issues.length,2);assert.ok(dto.issues.every((row:{dedupKey:string})=>row.dedupKey!=='trigger:checking'));const history=await points(true);assert.equal(history.issues.length,3);assert.ok(history.issues.find((row:{dedupKey:string})=>row.dedupKey==='trigger:checking').resolvedAt);
  stage=2;dto=await points();trigger=dto.issues.find((row:{dedupKey:string})=>row.dedupKey==='trigger:checking');assert.equal(dto.issues.length,3);assert.equal(trigger.severity,'low');assert.ok(trigger.summary.includes('抢路由 1'));assert.ok(!dto.issues.some((row:{id:string})=>row.id==='old-trigger-issue'));
  assert.equal(await prisma.skillIssue.count(),3);assert.equal(await prisma.evaluation.count(),3);assert.equal(await prisma.skillTriggerEvalRun.count(),0);
 }finally{if(before.mode===undefined)delete process.env.AGENT_INSIGHT_TRACE_STORAGE;else process.env.AGENT_INSIGHT_TRACE_STORAGE=before.mode;if(before.url===undefined)delete process.env.AGENT_INSIGHT_STORAGE_CORE_URL;else process.env.AGENT_INSIGHT_STORAGE_CORE_URL=before.url;}
});
