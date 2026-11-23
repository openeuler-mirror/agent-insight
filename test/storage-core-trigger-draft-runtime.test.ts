import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {withCoreFlowModelDelivery,executeCoreFlowModelCall} from '../src/lib/storage-core/flow-model-delivery';

for(const mode of ['live','lost-ack','replay','unknown','model-changed','provider-error','record-error','empty-record','preparation-error'])test('durable direct Trigger draft '+mode+' respects its indexed response boundary',async()=>{
 const events:string[]=[];let calls=0,settings=0,lost=false,revision=1;const receipts=new Map<string,unknown>();
 const manifest={kind:'draft',legacy_owner:'legacy-alice',skill:{id:'skill',name:'checking',version:0},draft_skill:{description:'tested',body:'body',contentHash:'hash'},model_selection:{id:'frozen',model:'mock',provider:'custom'},placeholder:{id:'placeholder'},...(mode==='preparation-error'?{draft_preparation_error:'missing frozen model configuration'}:{})};
 const modelResponse={task_id:'trigger-draft-exp',content:'two valid items',failure:null};const request={systemPrompt:'actual system',userPrompt:'actual user',model_selection:manifest.model_selection};
 const checkpoint:Record<string,unknown>=mode==='replay'?{_flow_model_calls:{'0':{state:'observed',request_hash:createHash('sha256').update(JSON.stringify(request)).digest('hex'),response:modelResponse}}}:mode==='unknown'?{_flow_model_calls:{'0':{state:'intent',request_hash:'a'.repeat(64)}}}:{};
 const handle={experiment_id:'exp',attempt_id:'attempt',run_id:'run',fence:'2',lease_owner:'worker',evaluator_id:'__skill_trigger_draft__',checkpoint_revision:'1'};
 const work={handle,checkpoint,experiment_config:{scope:'skill-trigger-analysis'},runplan:{config:{core_trigger:manifest}}};
 const context={actor:{username:'legacy-alice'},rpc:async(action:string,body:Record<string,unknown>)=>{
  if(action==='checkpoint'){assert.equal(body.expected_revision,String(revision));const value=body.checkpoint as Record<string,unknown>;Object.assign(checkpoint,value);const call=(value._flow_model_calls as Record<string,{state:string}>)['0'];events.push(call.state);if(call.state==='observed')assert.ok(events.includes('indexed'));const result={...handle,checkpoint_revision:String(++revision)};receipts.set(String(body.operation_key),result);if(mode==='lost-ack'&&!lost){lost=true;throw Error('lost ACK');}return result;}
  if(action==='lookup_operation')return {found:true,result:receipts.get(String(body.operation_key))};throw Error('Unexpected RPC '+action);
 }};
 const fixtureModule={exports:{}};const dependencies:Record<string,unknown>={
  'node:crypto':{createHash},'gray-matter':()=>({data:{}}),'./flow-model-delivery':{withCoreFlowModelDelivery,executeCoreFlowModelCall},'./experiments':{prepareCoreExperimentRuntime:async(_c:unknown,_w:unknown,perform:()=>Promise<unknown>)=>perform()},'./frozen-model':{matchesFrozenModelSelection:()=>mode!=='model-changed'},
  '@/lib/engine/skill-generation/evaluator/runners/draftTriggerEvalSet':{resolveDraftModelConfig:async()=>{settings++;return {modelId:'mock',provider:'custom',source:'active'};},draftTriggerEvalSet:async(args:{coreRuntime:{invoke:(request:unknown,perform:()=>Promise<unknown>)=>Promise<unknown>;itemId:(index:number)=>string}})=>{await args.coreRuntime.invoke({systemPrompt:'actual system',userPrompt:'actual user'},async()=>{calls++;events.push('model');if(mode==='provider-error')throw Error('provider unavailable');return {content:'two valid items'};});return {items:[{id:args.coreRuntime.itemId(0),query:'one',shouldTrigger:true,source:'llm-draft'},{id:args.coreRuntime.itemId(1),query:'two',shouldTrigger:false,source:'llm-draft'}],draftedFromSkillHash:'hash',skillDescription:'tested'};}},
  '../../../scripts/agent-run-diagnostics.cjs':{sanitizeAgentDiagnostic:(value:string)=>value},
  '@/lib/engine/evaluation/evaluator-execution-recorder':{recordDirectEvaluatorExecution:async(input:{skillVersion:number;systemPrompt:string})=>{assert.equal(input.skillVersion,0);assert.equal(input.systemPrompt,'actual system');if(mode==='record-error')throw Object.assign(Error('unknown recording'),{code:'CORE_TRACE_RECORDING_FAILED'});if(mode==='empty-record')return 0;events.push('indexed');return 3;}},
 };
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/storage-core/trigger-draft.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,{module:fixtureModule,exports:fixtureModule.exports,require:(name:string)=>dependencies[name],Date,Error,JSON,Number,Object,Array,console});
 const run=()=>(fixtureModule.exports as {evaluateCoreTriggerDraftWork:(work:unknown,context:unknown)=>Promise<Record<string,unknown>>}).evaluateCoreTriggerDraftWork(work,context);
 if(mode==='preparation-error'){await assert.rejects(run,/missing frozen model configuration/);assert.equal(calls,0);assert.equal(settings,0);return;}
 if(mode==='unknown'||mode==='model-changed'||mode==='record-error'||mode==='empty-record'){await assert.rejects(run,(error:unknown)=>(error as {status:number}).status===503);assert.equal(calls,['record-error','empty-record','preparation-error'].includes(mode)?1:0);return;}
 if(mode==='provider-error'){await assert.rejects(run,/provider unavailable/);assert.equal(calls,1);assert.ok(events.includes('observed'));return;}
 const result=await run();assert.equal(result.score,null);assert.equal(((result.evidence as {json:{coreTriggerDraft:{items:unknown[]}}}).json.coreTriggerDraft).items.length,2);assert.equal(calls,mode==='replay'?0:1);assert.equal(settings,mode==='replay'?0:1);if(mode!=='replay')assert.ok(events.indexOf('intent')<events.indexOf('model')&&events.indexOf('indexed')<events.indexOf('observed'));
});
