import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {createHash} from 'node:crypto';
import ts from 'typescript';

for(const mode of ['live','lost-intent-ack','closed','unknown','model-changed','unsent'])test('Trigger durable runtime '+mode+' preserves the observed physical-call boundary',async()=>{
 let native=0,models=0,aggregates=0,revision=1,lost=false;const events:string[]=[];const receipts=new Map<string,unknown>(),fixtureModule={exports:{}};
 const manifest={version:1,kind:'run',skill:{id:'s',name:'checking',version:0,content:'frozen'},trigger_set:{id:'d',version:1,items:[{id:'q',query:'check',shouldTrigger:true}]},params:{runsPerQuery:1,triggerThreshold:.5,timeoutMs:5000,concurrency:1,maxTimeoutRetries:1},siblings:[],model_selection:{id:'frozen'},workspaceRoot:'/isolated/trigger'};
 const checkpoint:Record<string,unknown>=mode==='closed'?{trigger_runtime_closed:true,trigger_started_at_ms:1000,trigger_finished_at_ms:1500,trigger_samples:{'0:0:0':{request_hash:'a'.repeat(64),state:'observed',response:{triggered:true,sessionId:'actual',endReason:'triggered',latencyMs:1,attempts:1,completionOrder:0}}}}:mode==='unknown'?{trigger_samples:{'0:0:0':{state:'intent',request_hash:'a'.repeat(64)}}}:{};
 const handle={experiment_id:'e',run_id:'r',attempt_id:'a',fence:'2',lease_owner:'worker',checkpoint_revision:'1'},work={handle,checkpoint,runplan:{config:{core_trigger:manifest}},experiment_config:{scope:'skill-trigger-analysis'}};
 const report={items:[{itemId:'q',pass:true}],passRate:1,truePositiveRate:1,falsePositiveRate:0};
 const context={actor:{username:'legacy-alice'},rpc:async(action:string,payload:Record<string,unknown>)=>{if(action==='checkpoint'){assert.equal(payload.expected_revision,String(revision));const next=payload.checkpoint as Record<string,unknown>;Object.assign(checkpoint,next);events.push(next.trigger_runtime_closed?'closed':JSON.stringify(next).includes('observed')?'observed':'intent');const value={...handle,checkpoint_revision:String(++revision)};receipts.set(String(payload.operation_key),value);if(mode==='lost-intent-ack'&&!lost){lost=true;throw Object.assign(new Error('lost'),{status:503});}return value;}if(action==='lookup_operation')return {found:true,result:receipts.get(String(payload.operation_key))};throw Error('Unexpected RPC '+action);}};
 const dependencies:Record<string,unknown>={
  './trigger-derived':{buildCoreTriggerDerived:()=>({version:1,evaluations:[],skillIssues:[]})},
  'node:crypto':{createHash},'./frozen-model':{matchesFrozenModelSelection:()=>mode!=='model-changed'},
  './experiments':{prepareCoreExperimentRuntime:(_context:unknown,_work:unknown,fn:()=>Promise<unknown>)=>fn()},
  '@/lib/engine/skill-generation/evaluator/runners/triggerEval':{
   resolveTriggerModelConfiguration:async()=>{models++;return {id:'frozen',model:'mock'};},
   aggregateTriggerOutcomes:()=>{aggregates++;return report;},
   runTriggerEvalLive:async(args:{coreRuntime:{sample:(id:string,perform:()=>Promise<unknown>)=>Promise<unknown>}})=>{await args.coreRuntime.sample('0:0:0',async()=>{if(mode==='unsent')throw Object.assign(new Error('not submitted'),{code:'CORE_TRIGGER_NOT_SUBMITTED'});native++;events.push('physical-model');return {triggered:true,sessionId:'actual',endReason:'triggered',latencyMs:1,attempts:1};});events.push('physical-exit');return report;},
  },
 };
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/storage-core/trigger-runtime.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:fixtureModule,exports:fixtureModule.exports,require:(name:string)=>dependencies[name],Buffer,Date,Map,Set,structuredClone,console});
 const run=()=> (fixtureModule.exports as {evaluateCoreTriggerWork:(work:unknown,context:unknown,signal?:AbortSignal)=>Promise<Record<string,unknown>>}).evaluateCoreTriggerWork(work,context);
 if(mode==='unsent'){await assert.rejects(run,(error:unknown)=>(error as {code:string}).code==='CORE_TRIGGER_NOT_SUBMITTED'&&!(error as {coreDeliveryUncertain:boolean}).coreDeliveryUncertain);assert.equal(native,0);assert.equal(checkpoint.trigger_runtime_closed,true);return;}
 if(mode==='unknown'||mode==='model-changed'){await assert.rejects(run,(error:unknown)=>(error as {status?:number}).status===503);assert.equal(native,0);assert.equal(models,mode==='unknown'?0:1);return;}
 const result=await run();assert.equal(result.score,100);
 if(mode==='closed'){assert.equal(result.durationMs,500);assert.equal(native,0);assert.equal(models,0);assert.equal(aggregates,1);return;}
 assert.equal(native,1);assert.equal(models,1);assert.ok(events.indexOf('intent')<events.indexOf('physical-model'));assert.ok(events.indexOf('observed')>events.indexOf('physical-model'));assert.ok(events.indexOf('closed')>events.indexOf('physical-exit'));assert.equal(checkpoint.trigger_runtime_closed,true);
});
