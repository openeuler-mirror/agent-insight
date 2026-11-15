import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {createHash} from 'node:crypto';

function fixture(race=false,freezeUnavailable=false,lookupExisting=false){
 let legacy=0;const calls:Array<{action:string;payload:Record<string,unknown>}>=[];const starts:Array<Record<string,unknown>>=[];let activations=0;
 const experiment={id:'exp',user:'alice',status:'draft',evaluatorIdsJson:'["first","second"]',cases:[] as Array<Record<string,unknown>>};
 const context={actor:{workspace:'w',principal:'p',username:'alice'},operationKey:'request',rpc:async(action:string,payload:Record<string,unknown>)=>{
  calls.push({action,payload});if(action==='read')return {experiment:structuredClone(experiment),revision:'1'};
  if(action==='ensure_lookup')return lookupExisting?{experiment:structuredClone(experiment)}:null;
  if(action==='ensure')return {experiment:{id:'exp'}};
  if(action==='case_upsert'){if(race){race=false;experiment.cases.push({id:'concurrent-case',taskId:'task',input:'other writer',actualOutput:'answer',referenceOutput:'gold'});}const value=payload.case as Record<string,unknown>;const existing=experiment.cases.find(row=>row.id===value.id||row.taskId&&row.taskId===value.taskId);if(existing){if(!payload.only_if_new)Object.assign(existing,value);return {experiment,case_id:existing.id,reused:true};}experiment.cases.push(value);return {experiment,case_id:value.id,reused:false};}
  throw Error('Unexpected command '+action);
 }};
 const module={exports:{}};const source=ts.transpileModule(readFileSync('src/lib/engine/experiment/run-experiment.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const dependencies:Record<string,unknown>={
  '@/lib/storage/prisma':{prisma:new Proxy({},{get(){legacy++;throw Error('Legacy ORM access is forbidden');}})},
  '@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},
  '@/lib/storage-core/experiments':{requireCoreExperimentContext:()=>context},
  '@/lib/storage-core/experiment-assets':{freezeExperimentAssets:async(_ctx:unknown,value:unknown)=>{if(freezeUnavailable)throw Error('Latest evaluator is unavailable');return value;},startCoreExperiment:async(_ctx:unknown,id:string,options:Record<string,unknown>)=>{starts.push({id,...options});}},
  '@/lib/storage-core/experiment-worker':{activateExperimentWork:async()=>{activations++;for(const row of experiment.cases)row.results=[{evaluatorId:'first',status:'done',score:0,pointsJson:null,evidenceJson:null,errorMessage:null},{evaluatorId:'second',status:'done',score:null,verdict:'unscored',pointsJson:null,evidenceJson:null,errorMessage:null}];}},
  '@/lib/evaluators/evaluator-case-context':{normalizeEvaluatorCaseContext:(x:unknown)=>x},
  './dataset-case-binding':{withExperimentDatasetCaseBinding:(value:unknown,binding:unknown)=>({...value as object,datasetCaseBinding:binding})},
  './cancellation-context':{assertExperimentActive:async()=>{}},
  'node:crypto':{createHash,randomUUID:()=> 'new-case'},
 };
 vm.runInNewContext(source,{module,exports:module.exports,require:(name:string)=>dependencies[name]||{},console,Buffer,URL,setTimeout,clearTimeout,setInterval,clearInterval});
 return {api:module.exports as Record<string,Function>,context,experiment,calls,starts,get legacy(){return legacy;},get activations(){return activations;}};
}

test('core producer ensure uses actor-owned typed command and stable semantic receipt',async()=>{
 const f=fixture();const params={user:'alice',name:'session',evaluatorIds:['first'],scope:'skill',skillName:'name',skillVersion:2};
 assert.equal(await f.api.ensureEvalExperiment(params),'exp');assert.equal(await f.api.ensureEvalExperiment(params),'exp');
 assert.equal(f.legacy,0);const writes=f.calls.filter(call=>call.action==='ensure');assert.equal(writes.length,2);assert.equal(writes[0].payload.operation_key,writes[1].payload.operation_key);
 const dto=writes[0].payload.experiment as Record<string,unknown>;assert.equal(dto.user,'alice');assert.equal(dto.status,'draft');assert.equal(dto.skillVersion,2);
 await assert.rejects(f.api.ensureEvalExperiment({...params,user:'mallory'}),error=>(error as {status:number}).status===403);
});

test('core producer add preserves case identity, nonempty metadata backfill and onlyIfNew',async()=>{
 const f=fixture();const id=await f.api.addEvalExperimentCase('exp',{taskId:'task',input:'initial',actualOutput:'answer',referenceOutput:'gold'});
 assert.equal(await f.api.addEvalExperimentCase('exp',{taskId:'task',input:'changed',actualOutput:'changed',referenceOutput:''}),id);
 assert.equal(f.experiment.cases[0].input,'initial');assert.equal(f.experiment.cases[0].referenceOutput,'gold');
 assert.equal(await f.api.addEvalExperimentCase('exp',{taskId:'task',input:'x',actualOutput:'x'},{onlyIfNew:true}),null);assert.equal(f.legacy,0);
});

test('core producer starts only requested cases and returns worker completion',async()=>{
 const f=fixture();const run=await f.api.startEvalExperimentCases('exp',['case','case'],'alice');await run.completion;
 assert.deepEqual(JSON.parse(JSON.stringify(f.starts)),[{id:'exp',caseIds:['case']}]);assert.equal(f.activations,1);assert.equal(f.legacy,0);
});

test('core synchronous producer reads selected immutable results and preserves null versus zero',async()=>{
 const f=fixture();f.experiment.cases.push({id:'case'});
 const rows=await f.api.evaluateEvalExperimentCase('exp','case','alice',{evaluatorIds:['first','second'],settleExperiment:false});
 assert.equal(rows[0].score,0);assert.equal(rows[1].score,null);assert.equal(rows[1].verdict,'unscored');
 assert.deepEqual(JSON.parse(JSON.stringify(f.starts)),[{id:'exp',caseIds:['case'],evaluatorIds:['first','second']}]);assert.equal(f.legacy,0);
});


test('concurrent producer add cannot overwrite existing input or gold with create defaults',async()=>{
 const f=fixture(true);const id=await f.api.addEvalExperimentCase('exp',{taskId:'task',input:'new default',actualOutput:'new default'});assert.equal(id,'concurrent-case');assert.equal(f.experiment.cases[0].input,'other writer');assert.equal(f.experiment.cases[0].referenceOutput,'gold');
});


test('producer reuses existing sealed experiment after latest evaluator is unavailable',async()=>{
 for(const existingId of ['exp',undefined]){const f=fixture(false,true,true);assert.equal(await f.api.ensureEvalExperiment({user:'alice',name:'session',evaluatorIds:['deleted-custom'],existingId}),'exp');assert.equal(f.calls.some(call=>call.action==='ensure'),false);}
});
