import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {bumpSeverityByPrevalence} from '@/lib/engine/skill-issues/prevalence';
function load(file:string,deps:Record<string,unknown>){const module={exports:{}};vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:(id:string)=>deps[id]||{},Date,Map,Set,JSON,Error,Promise,Request,Response,URL,console});return module.exports as Record<string,Function>;}
const base={skillId:'skill',version:1,user:'owner',evaluationId:'evaluation',severity:'low',summary:'summary',evidence:null,reasoning:null,suggestedFix:'fix',ruleId:'experiment',dimension:'judge',category:'用例评测',resolvedAt:null,resolvedRunId:null,createdAt:new Date('2026-11-14T00:00:00Z'),Evaluation:{type:'dynamic',ranAt:new Date('2026-11-14T00:00:00Z'),runId:'run',executionId:'execution'}};
test('core aggregation preserves static/feedback but replaces old dynamic shadows with authorized typed issues',async()=>{
 const calls:unknown[]=[];const legacy=[{...base,id:'static',source:'static',dedupKey:'static'},{...base,id:'feedback',source:'feedback',dedupKey:'feedback'},{...base,id:'old-shadow',source:'dynamic',dedupKey:'shadow'}];
 const prisma={skillIssue:{findMany:async(query:{where:{source?:{in:string[]}}})=>{calls.push(query);return legacy.filter(row=>!query.where.source||query.where.source.in.includes(row.source));}}};
 const derived=[{...base,id:'new-issue',source:'trajectory',dedupKey:'derived',createdAt:base.createdAt.toISOString()},{...base,id:'resolved-issue',source:'trigger',dedupKey:'resolved',resolvedAt:base.createdAt.toISOString(),createdAt:base.createdAt.toISOString()}];
 const api=load('src/lib/engine/skill-issues/index.ts',{'./prevalence':{bumpSeverityByPrevalence},'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},'@/lib/storage-core/experiments':{requireCoreExperimentContext:()=>({actor:{username:'owner'}})},'@/lib/storage-core/derived-issues':{readCoreDerivedIssues:async(input:unknown)=>{calls.push(input);return derived;}}});
 const value=await api.aggregateSkillIssues({prisma,skillId:'skill',version:1,user:'owner'});
 assert.deepEqual([...value.issues.map((row:{id:string})=>row.id)].sort(),['feedback','new-issue','static']);assert.equal(value.stats.bySource.dynamic,1);assert.equal(value.stats.totalEvaluationsScanned,1);assert.equal(calls.length,2);
 await assert.rejects(api.aggregateSkillIssues({prisma,skillId:'skill',user:'other'}),error=>(error as {status?:number}).status===403);
});
test('core compatibility sync cannot read or materialize legacy Experiment issues',async()=>{
 let reads=0;const legacy=new Proxy({},{get(){reads++;throw Error('Legacy Experiment access');}});
 const api=load('src/lib/engine/experiment/sync-skill-issues.ts',{'@/lib/storage/prisma':{prismaRaw:legacy},'crypto':await import('node:crypto'),'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},'@/lib/storage-core/experiments':{requireCoreExperimentContext:()=>({actor:{username:'owner'}})}});
 const result=await api.syncCompletedSkillExperimentIssues({user:'owner',skillName:'skill',skillVersion:1});assert.equal(result.written,0);assert.equal(reads,0);
});
test('a real empty trigger frontier hides older typed issues without inventing resolution annotations',async()=>{
 const trigger={...base,id:'old-trigger',source:'trigger',dedupKey:'trigger',createdAt:base.createdAt.toISOString(),Evaluation:{...base.Evaluation,id:'older-evaluation',type:'trigger'}};
 const api=load('src/lib/engine/skill-issues/index.ts',{'./prevalence':{bumpSeverityByPrevalence},'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},'@/lib/storage-core/experiments':{requireCoreExperimentContext:()=>({actor:{username:'owner'},rpc:async(action:string)=>{assert.equal(action,'derived_trigger_frontier');return {versions:[{version:1,experiment_id:'new-trigger',evaluation_ids:[],settled_at:'2026-11-14T00:00:01Z'}]};}})},'@/lib/storage-core/derived-issues':{readCoreDerivedIssues:async()=>[trigger]}});
 const prisma={skillIssue:{findMany:async()=>[]}};const current=await api.aggregateSkillIssues({prisma,skillId:'skill',version:1,user:'owner'});assert.equal(current.issues.length,0);
 const history=await api.aggregateSkillIssues({prisma,skillId:'skill',version:1,user:'owner',includeResolved:true});assert.equal(history.issues.length,1);assert.equal(history.issues[0].resolvedAt,null);assert.equal(trigger.resolvedAt,null);
});
for(const [file,method] of [['src/app/api/skill-opt/plan/route.ts','POST'],['src/app/api/skills/by-name/[name]/optimization-points/route.ts','GET']])test(`original ${file} establishes trusted core scope before reading control state`,async()=>{
 let context:unknown;let wrappers=0;
 const api=load(file,{'next/server':{NextResponse:Response},'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},'@/lib/storage-core/experiments':{getCoreExperimentContext:()=>context,coreExperimentFailure:()=>Response.json({error:'scope'},{status:503})},'@/lib/storage-core/workbench':{withCoreWorkbenchRoute:async(request:Request,next:(input:Request)=>Promise<Response>)=>{wrappers++;context={actor:{username:'owner'}};return next(request);}},'@/lib/auth/auth':{resolveUser:async()=>({username:'owner'})},'@/lib/storage/prisma':{db:{findSkills:async()=>[]}}});
 const response=await api[method](new Request('http://localhost/api/skill-opt/plan',{method,...(method==='POST'?{body:'{}',headers:{'content-type':'application/json'}}:{})}),{params:Promise.resolve({name:'skill'})});
 assert.equal(wrappers,1);assert.ok([400,404].includes(response.status));
});
