import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {createHash,timingSafeEqual} from 'node:crypto';
function fixture(){
 const events:string[]=[];let stored:Record<string,unknown>|null=null;let response:Record<string,unknown>|null=null;let unavailable=false;let freezes=0;
 const context={actor:{username:'legacy-alice',workspace:'w',principal:'alice'},operationKey:'op',request:new Request('http://localhost/api/skill-workbench/skills/skill/experiments',{method:'POST',body:'{}'}),body:{name:'original'},rpc:async(action:string,body:Record<string,unknown>)=>{
  assert.equal(action,'create');events.push('core');if(unavailable)throw Object.assign(new Error('unavailable'),{status:503});response??={experiment:body.experiment};return structuredClone(response);
 }};
 const task={findFirst:async()=>stored,create:async({data}:{data:Record<string,unknown>})=>{events.push('intent');stored={...data};return stored;},updateMany:async({where,data}:{where:Record<string,unknown>;data:Record<string,unknown>})=>{assert.equal(where.configJson,stored?.configJson);events.push('ready');stored={...stored,...data};return {count:1};}};
 const module={exports:{}};const file='src/lib/storage-core/workbench-handoff.ts';
 assert.ok(readFileSync(file,'utf8').length,'Workbench handoff must have a production implementation');
 vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:(id:string)=>({
  'node:crypto':{createHash,timingSafeEqual},'./controller':{readControllerKey:async()=> 'a'.repeat(64),signControllerPayload:(_key:string,purpose:string,principal:string,workspace:string,body:string)=>createHash('sha256').update(JSON.stringify([purpose,principal,workspace,body])).digest('hex')},'./experiments':{requireCoreExperimentContext:()=>context},'@/lib/storage/prisma':{prismaRaw:{grayscaleTask:task}},'./experiment-assets':{freezeExperimentAssets:async(_context:unknown,data:Record<string,unknown>)=>{freezes++;return {...data,configSnapshotJson:JSON.stringify({...JSON.parse(String(data.configSnapshotJson||'{}')),coreAssets:{releases:{dataset:'release-v1'}}})};}},
 }[id]??{}),JSON,Buffer,URL,structuredClone});
 return {api:module.exports as Record<string,Function>,context,events,get stored(){return stored;},get freezes(){return freezes;},set unavailable(value:boolean){unavailable=value;}};
}
const input={experiment:{name:'original',scope:'skill-workbench',evaluatorIdsJson:'["builtin"]',cases:[]},task:{skillId:'skill',skillName:'skill',skillVersion:1,skillVersionId:'version'},taskConfig:{autoEval:true},snapshot:{datasetId:'dataset',caseIds:['case']}};
test('workbench create persists a recoverable Task intent before core creation and activates only after its receipt',async()=>{
 const f=fixture();const result=await f.api.createCoreWorkbenchHandoff('legacy-alice',input);assert.deepEqual(f.events,['intent','core','ready']);assert.equal(result.experiment.id,JSON.parse(String(f.stored?.configJson)).evalExperimentId);assert.equal(result.grayscaleTask.id,f.stored?.id);assert.equal(JSON.parse(String(f.stored?.configJson)).__storageCoreHandoff.phase,'ready');assert.equal(f.freezes,1);
});
test('an interrupted handoff replays its frozen input without refreezing editable assets',async()=>{
 const f=fixture();f.unavailable=true;await assert.rejects(f.api.createCoreWorkbenchHandoff('legacy-alice',input),(error:unknown)=>(error as {status:number}).status===503);assert.equal(JSON.parse(String(f.stored?.configJson)).__storageCoreHandoff.phase,'prepared');assert.equal(f.events.includes('ready'),false);
 f.unavailable=false;const result=await f.api.resumeCoreWorkbenchHandoff('legacy-alice');assert.ok(result);assert.equal(f.freezes,1);assert.equal(JSON.parse(result.experiment.configSnapshotJson).coreAssets.releases.dataset,'release-v1');assert.equal(f.events.at(-1),'ready');
});
test('handoff retries reject a changed request and a different verified actor',async()=>{
 const f=fixture();await f.api.createCoreWorkbenchHandoff('legacy-alice',input);f.context.body={name:'changed'};await assert.rejects(f.api.resumeCoreWorkbenchHandoff('legacy-alice'),(error:unknown)=>(error as {status:number}).status===409);await assert.rejects(f.api.resumeCoreWorkbenchHandoff('bob'),(error:unknown)=>(error as {status:number}).status===403);
});

test('persisted handoff cannot forge a frozen Experiment by editing legacy Task JSON',async()=>{
 const f=fixture();f.unavailable=true;await assert.rejects(f.api.createCoreWorkbenchHandoff('legacy-alice',input));const config=JSON.parse(String(f.stored?.configJson));config.__storageCoreHandoff.experiment.configSnapshotJson='{"forged":"release"}';f.stored!.configJson=JSON.stringify(config);f.unavailable=false;await assert.rejects(f.api.recoverCoreWorkbenchHandoff('legacy-alice',String(f.stored?.id)),(error:unknown)=>(error as {status:number}).status===403);
});
test('a restarted actor can recover its original durable intent under a different request key',async()=>{
 const f=fixture();f.unavailable=true;await assert.rejects(f.api.createCoreWorkbenchHandoff('legacy-alice',input));f.unavailable=false;f.context.operationKey='background-recovery';f.context.body={name:'unrelated'};const result=await f.api.recoverCoreWorkbenchHandoff('legacy-alice',String(f.stored?.id));assert.ok(result);assert.equal(f.freezes,1);
});
test('runtime configuration is read from the signed handoff rather than mutable Task JSON',async()=>{const f=fixture();await f.api.createCoreWorkbenchHandoff('legacy-alice',input);const config=JSON.parse(String(f.stored?.configJson));config.autoEval=false;f.stored!.configJson=JSON.stringify(config);const runtime=await f.api.readCoreWorkbenchTaskConfiguration('legacy-alice',f.stored);assert.equal(runtime.autoEval,true);config.evalExperimentId='foreign';f.stored!.configJson=JSON.stringify(config);await assert.rejects(f.api.readCoreWorkbenchTaskConfiguration('legacy-alice',f.stored),(e:unknown)=>(e as {status:number}).status===403);});
