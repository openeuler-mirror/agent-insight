import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

test('Trigger freezes v0 and only the selected history plus latest competing Skills from the actual legacy actor',async()=>{
 const actor={username:'legacy-alice',principal:'alice',workspace:'w'},calls:unknown[]=[];let loaded=0;const state:{active?:Record<string,unknown>}={};let models=0;
 const rows=[{id:'s',name:'checking',versions:[2,1,0].map(version=>({version,content:'target-'+version}))},{id:'other',name:'competing',versions:Array.from({length:100},(_,index)=>({version:99-index,content:'sibling-'+(99-index)}))}];
 const model={id:'trigger-live-active',provider:'openai-compatible',model:'mock',apiKey:'PRIVATE_KEY',baseUrl:'http://localhost/mock'};
 const context={actor,operationKey:'intent',rpc:async(action:string,body:{running_only?:boolean})=>{assert.equal(action,'trigger_list');return {runs:body.running_only?(state.active?[state.active]:[]):[{id:'history-two',skillVersion:2,status:'done',passRate:.6},{id:'history-one',skillVersion:1,status:'done',passRate:.2}]};}};
 const fixtureModule={exports:{}};const dependencies:Record<string,unknown>={
  'node:crypto':{createHash},'./experiments':{requireCoreExperimentContext:()=>context},
  '@/server/skill_trigger_eval_storage':{findLatestTriggerEvalSet:async(user:string)=>{assert.equal(user,actor.username);return {id:'set',user,skillName:'checking',version:4,items:[{id:'q',query:'check',shouldTrigger:true,source:'user-added'}]};}},
  '@/lib/storage/prisma':{prismaRaw:{skill:{findMany:async(input:{where:{user:string};include:{versions:{take?:number}}})=>{calls.push(input);assert.equal(input.where.user,actor.username);return rows.map(row=>{const versions=row.versions.slice(0,input.include.versions.take);loaded+=versions.length;return {...row,versions};});}},skillVersion:{findFirst:async(input:{where:{skillId:string;version:number}})=>{assert.ok(Number.isSafeInteger(input.where.version),'ORM integer input');const row=rows.find(value=>value.id===input.where.skillId)?.versions.find(value=>value.version===input.where.version);if(row)loaded++;return row;},findMany:async(input:{where:{skillId:string;version:{in:number[]}}})=>{const result=rows.find(value=>value.id===input.where.skillId)!.versions.filter(value=>input.where.version.in.includes(value.version));loaded+=result.length;return result;}}}},
  '@/lib/engine/skill-generation/evaluator/runners/triggerEval':{resolveTriggerModelConfiguration:async()=>{models++;return model;}},
  './frozen-model':{freezeModelSelection:()=>({id:model.id,provider:model.provider,model:model.model})},
  '@/lib/engine/skill-generation/evaluator/runners/triggerEvalRetry':{resolveMaxTimeoutRetries:(raw:string)=>Number(raw)},
  '@/lib/engine/general-agent/workspace':{ensureSessionWorkspace:()=>'/isolated/trigger'},
 };
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/storage-core/trigger.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:fixtureModule,exports:fixtureModule.exports,require:(name:string)=>dependencies[name],Headers,URL,Request,Response,process:{env:{TRIGGER_EVAL_TIMEOUT_RETRIES:'0'}},Number,Set,Map});
 const value=await (fixtureModule.exports as {freezeCoreTriggerRun:(context:unknown,skill:string,body:unknown)=>Promise<Record<string,unknown>>}).freezeCoreTriggerRun(context,'checking',{user:'forged',skillVersion:0});
 assert.equal((value.skill as {version:number}).version,0);assert.deepEqual(JSON.parse(JSON.stringify(value.siblings)),[{name:'competing',version:99,content:'sibling-99'}]);
 assert.deepEqual(JSON.parse(JSON.stringify((value.history as Array<{version:number}>).map(row=>row.version))),[1,2]);assert.equal((value.params as {maxTimeoutRetries:number}).maxTimeoutRetries,0);assert.ok(loaded<=5,'must not load every historical sibling body');assert.ok(!JSON.stringify(value).includes('PRIVATE_KEY'));assert.ok(calls.length>0);
 await assert.rejects(()=>(fixtureModule.exports as {freezeCoreTriggerRun:(context:unknown,skill:string,body:unknown)=>Promise<unknown>}).freezeCoreTriggerRun(context,'checking',{skillVersion:'not-a-version'}),(error:unknown)=>(error as {status?:number}).status===404);
 state.active={id:'existing-running',user:'legacy-alice',skillName:'checking',skillVersion:0,status:'running'};const before=models;
 try{await (fixtureModule.exports as {freezeCoreTriggerRun:(context:unknown,skill:string,body:unknown)=>Promise<unknown>}).freezeCoreTriggerRun(context,'checking',{skillVersion:0});assert.fail('active Run should produce the original 409');}catch(error){const response=(fixtureModule.exports as {coreTriggerFailure:(error:unknown)=>Response}).coreTriggerFailure(error);assert.equal(response.status,409);assert.deepEqual((await response.json()).run,state.active);}
 assert.equal(models,before);
});
