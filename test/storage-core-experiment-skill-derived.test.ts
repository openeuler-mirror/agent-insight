import {writeFileSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {createIsolatedDatabase} from './helpers/isolated-database';
const database=createIsolatedDatabase();
process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=path.join(database.home,'controller');writeFileSync(process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE,'a'.repeat(64),{mode:0o600});
import {prismaRaw as prisma} from '@/lib/storage/prisma';
import {withCoreWorkbenchRoute} from '@/lib/storage-core/workbench';
import {GET as getPoints} from '@/app/api/skills/by-name/[name]/optimization-points/route';
import {POST as createPlan} from '@/app/api/skill-opt/plan/route';
import {GET as getEvaluation} from '@/app/api/evaluation/[id]/route';
import {attachExperimentSkillDerived} from '@/lib/storage-core/experiment-skill-derived';
import type {FrozenExperimentWork} from '@/lib/storage-core/experiment-worker';
import type {CoreExperimentContext} from '@/lib/storage-core/experiments';
import {prepareCoreExperimentStart} from '@/lib/storage-core/experiment-assets';
import {validateControllerSkillScope} from '@/lib/storage-core/controller';
test.after(async()=>{await prisma.$disconnect();database.dispose();});

test('the score conversion is pure, preserves original points and machine zero, and leaves direct derived untouched',()=>{
 const work={handle:{attempt_id:'attempt',evaluator_id:'judge',experiment_id:'exp',result_id:'slot'},experiment_config:{preset:'use-case'},runplan:{config:{experiment_skill_scope:{skill_id:'skill',version:1,source:'dynamic'}}},frozen_trace_evidence:null} as unknown as FrozenExperimentWork;
 const result={score:0,points:[{label:'problem',suggestion:'fix',skillAttributable:true,status:'partial'},{label:'problem',suggestion:'fix',skillAttributable:true,status:'failed'},{label:'not attributable',suggestion:'ignore'}],evidence:{json:{keep:true}}};const before=JSON.stringify(result);
 const converted=attachExperimentSkillDerived(work,result);assert.equal(JSON.stringify(result),before);assert.equal(converted.score,0);
 const envelope=(converted.evidence as any).json.experimentSkillDerived;assert.equal(envelope.skillIssues.length,1);assert.equal(envelope.skillIssues[0].pointIndex,1);assert.equal(envelope.skillIssues[0].severity,'high');assert.equal(envelope.evaluations[0].executionId,null);
 const direct={...result,evidence:{json:{directTrajectoryDerived:{evaluations:[],skillIssues:[]}}}};assert.equal(attachExperimentSkillDerived(work,direct),direct);
});

test('real TypeScript conversion and native machine receipt reach the original optimization points, plan and nullable Evaluation detail',async()=>{
 const conversion="const fs=require('node:fs');const {attachExperimentSkillDerived}=require('./src/lib/storage-core/experiment-skill-derived.ts');const input=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(attachExperimentSkillDerived(input.work,input.result)));";
 const script=`import json,subprocess
from services.storage.tests import test_experiments as fixture
from services.storage.experiments import ExperimentStore
x=fixture.ExperimentTests();x.setUp()
try:
 store=ExperimentStore(x.control,frozen_assets_verifier=lambda *_:True)
 value=fixture.experiment();value.update(scope='skill-workbench',preset='use-case',skillName='checking',skillVersion=1)
 store.dispatch('create',x.token,'w',{'experiment':value,'operation_key':'create'})
 scope={'skill_id':'skill','skill_name':'checking','version':1,'source':'dynamic','preset':'use-case','scope':'skill-workbench'}
 store.dispatch('start',x.token,'w',{'experiment_id':'exp','config':{'derived_skill_ids':['skill'],'derived_skill_versions':{'skill':[1]},'experiment_skill_scope':scope},'frozen_evaluators':{'judge':{'id':'judge'}},'operation_key':'start'})
 handle=store.dispatch('claim',x.token,'w',{'experiment_id':'exp','worker_id':'worker'})
 work=store.dispatch('load_work',x.token,'w',x.handle(handle))
 points=[{'label':'Actual point','is_skill_attributable':True,'improvement_suggestion':'Fix it','status':'warn','evidence':{'md':'machine evidence'}},{'label':'not skill','suggestion':'skip'},{'label':'Actual point','skillAttributable':True,'suggestion':'Fix it','score':0,'evidence':{'opaque':False}},{'label':'Prompt rule','isSkillAttributable':True,'improvementSuggestion':'Add check','score':None},{'label':'Unicode score','skillAttributable':True,'suggestion':'Retain old numeric rules','score':'１２'},{'label':'Nested array score','skillAttributable':True,'suggestion':'Retain array numeric rules','score':[[]]}]
 result=json.loads(subprocess.check_output([${JSON.stringify(process.execPath)},'--disable-warning=MODULE_TYPELESS_PACKAGE_JSON','-e',${JSON.stringify(conversion)}],input=json.dumps({'work':work,'result':{'score':0,'summary':'actual machine summary','points':points}}).encode()))
 store.dispatch('complete',x.token,'w',x.handle(handle)|{'result':result,'operation_key':'complete'})
 issues=store.dispatch('derived_list',x.token,'w',{'kind':'issue','skill_id':'skill','owned_only':True});evaluations=store.dispatch('derived_list',x.token,'w',{'kind':'evaluation','skill_id':'skill'})
 print(json.dumps({'issues':issues,'evaluations':evaluations,'detail':store.dispatch('derived_detail',x.token,'w',{'id':evaluations[0]['id']}),'snapshot':store.dispatch('read',x.token,'w',{'experiment_id':'exp'}),'result':result}))
finally:x.doCleanups()
`;
 const actual=JSON.parse(execFileSync(process.env.PYTHON||'python3',['-c',script],{encoding:'utf8',timeout:30000}));
 assert.equal(actual.issues.length,4);assert.equal(actual.detail.execution,null);assert.equal(actual.detail.skill.name,'checking');assert.equal(actual.snapshot.experiment.cases[0].results[0].score,0);
 await prisma.skill.create({data:{id:'skill',name:'checking',user:'alice',versions:{create:{version:1,content:'# checking'}}}});
 const staticEval=await prisma.evaluation.create({data:{id:'static-eval',type:'static',skillId:'skill',version:1,user:'alice',status:'ok'}});
 await prisma.skillIssue.create({data:{id:'static-issue',evaluationId:staticEval.id,source:'static',skillId:'skill',version:1,user:'alice',dedupKey:'static',severity:'low',summary:'static problem'}});
 const shadowEval=await prisma.evaluation.create({data:{id:'old-shadow-eval',type:'dynamic',skillId:'skill',version:1,user:'alice',status:'ok'}});
 await prisma.skillIssue.create({data:{id:'old-shadow',evaluationId:shadowEval.id,source:'dynamic',skillId:'skill',version:1,user:'alice',dedupKey:'shadow',severity:'high',summary:'stale old problem'}});
 await prisma.skill.create({data:{id:'public-skill',name:'public-checking',user:'bob',visibility:'public'}});
 await prisma.skillVersion.create({data:{skillId:'public-skill',version:1,content:'# public-checking'}});
 await prisma.skill.create({data:{id:'private-skill',name:'private-checking',user:'bob'}});
 for(const [id,skillId,user] of [['global-static','public-skill',null],['foreign-static','public-skill','bob'],['private-skill-static','private-skill',null]] as const)await prisma.evaluation.create({data:{id,skillId,user,type:'static',version:1,status:'ok'}});
 const session=await prisma.skillOptSession.create({data:{user:'alice',skillName:'checking',baseVersion:1}});const plan=await prisma.skillOptPlan.create({data:{sessionId:session.id,skillId:'skill',baseVersion:1,status:'draft'}});
 const previous=process.env.AGENT_INSIGHT_TRACE_STORAGE;process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';
 const calls:string[]=[];const fetcher:typeof fetch=async(url,options)=>{
  const path=new URL(String(url)).pathname;
  if(path==='/v1/auth/me')return Response.json({principal_id:'alice',username:'alice',workspace_id:'w',workspaces:[{workspace_id:'w'}]});
  const body=JSON.parse(String(options?.body));if(path==='/v1/compat/platform-control'&&body.action==='scope')return Response.json({value:{authorized:true}});assert.equal(path,'/v1/compat/experiments');calls.push(body.action);
  if(body.action==='derived_list'){assert.equal(body.owned_only,true);return Response.json({value:actual.issues});}
  if(body.action==='derived_lookup')return Response.json({value:actual.evaluations.find((row:{id:string})=>row.id===body.id)});
  if(body.action==='derived_detail')return body.id===actual.evaluations[0].id?Response.json({value:actual.detail}):Response.json({error:'not found'},{status:404});
  throw Error('Unexpected RPC '+body.action);
 };
 const headers={authorization:'Bearer api_'+'T'.repeat(43),'content-type':'application/json'};
 try{
  const {withCoreControlRequest}=await import('@/lib/storage-core/control-context');
  const prepared=await withCoreControlRequest(new Request('http://localhost/prepare',{headers}),()=>prepareCoreExperimentStart({actor:{username:'alice'},operationKey:'public-scope',rpc:async()=>({revision:'1',experiment:{id:'public-exp',skillName:'public-checking',skillVersion:1,preset:'use-case',scope:'skill-workbench',configSnapshotJson:JSON.stringify({coreAssets:{evaluators:{judge:{card:{id:'judge'}}},releases:{}}})}})} as unknown as CoreExperimentContext,'public-exp'),{fetcher});
  const publicScope=prepared.payload.config as Record<string,unknown>;assert.equal(publicScope.derived_public_business_skill_id,'public-skill');assert.deepEqual(publicScope.derived_skill_ids,['public-skill']);await validateControllerSkillScope('alice',publicScope);
  const points=await withCoreWorkbenchRoute(new Request('http://localhost/api/skills/by-name/checking/optimization-points?version=1&user=forged',{headers}),input=>getPoints(input,{params:Promise.resolve({name:'checking'})}),{fetcher});
  assert.equal(points.status,200,await points.clone().text());const dto=await points.json();assert.equal(dto.issues.length,5);assert.equal(dto.issues.some((row:{id:string})=>row.id==='old-shadow'),false);assert.equal(dto.stats.bySource.dynamic,4);assert.equal(dto.stats.bySource.static,1);
  const planned=await withCoreWorkbenchRoute(new Request('http://localhost/api/skill-opt/plan',{method:'POST',headers,body:JSON.stringify({user:'forged',skillName:'checking',baseVersion:1,sessionId:session.id})}),createPlan,{fetcher});
  assert.equal(planned.status,200,await planned.clone().text());assert.equal((await planned.json()).plan.id,plan.id);assert.ok(calls.filter(action=>action==='derived_list').length>=2);
  const detail=await withCoreWorkbenchRoute(new Request('http://localhost/api/evaluation/'+actual.evaluations[0].id,{headers}),input=>getEvaluation(input,{params:Promise.resolve({id:actual.evaluations[0].id})}),{fetcher});
  assert.equal(detail.status,200,await detail.clone().text());const view=await detail.json();assert.equal(view.execution,null);assert.equal(view.evaluation.executionId,null);assert.equal(view.issues.length,4);
  const previousDerivedCalls=calls.filter(action=>action==='derived_detail').length;
  const staticDetail=await withCoreWorkbenchRoute(new Request('http://localhost/api/evaluation/static-eval',{headers}),input=>getEvaluation(input,{params:Promise.resolve({id:'static-eval'})}),{fetcher});
  assert.equal(staticDetail.status,200,await staticDetail.clone().text());assert.equal((await staticDetail.json()).evaluation.type,'static');assert.equal(calls.filter(action=>action==='derived_detail').length,previousDerivedCalls);
  const oldDynamic=await withCoreWorkbenchRoute(new Request('http://localhost/api/evaluation/old-shadow-eval',{headers}),input=>getEvaluation(input,{params:Promise.resolve({id:'old-shadow-eval'})}),{fetcher});
  assert.equal(oldDynamic.status,404);assert.equal(calls.filter(action=>action==='derived_detail').length,previousDerivedCalls+1);
  for(const [id,status] of [['global-static',200],['foreign-static',404],['private-skill-static',404]] as const){
   const checked=await withCoreWorkbenchRoute(new Request('http://localhost/api/evaluation/'+id+'?user=bob',{headers}),input=>getEvaluation(input,{params:Promise.resolve({id})}),{fetcher});assert.equal(checked.status,status,id);
   if(status===200){const staticView=await checked.json();assert.equal(staticView.evaluation.type,'static');assert.equal(staticView.execution,null);}
  }
  assert.equal(await prisma.experiment.count(),0);assert.equal(await prisma.experimentEvalResult.count(),0);assert.equal(await prisma.skillIssue.count(),2);
 }finally{if(previous===undefined)delete process.env.AGENT_INSIGHT_TRACE_STORAGE;else process.env.AGENT_INSIGHT_TRACE_STORAGE=previous;}
});
