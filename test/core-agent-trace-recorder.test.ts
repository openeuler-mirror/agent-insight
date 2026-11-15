import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import os from 'node:os';
import path from 'node:path';
import * as trustedContext from '../src/lib/engine/general-agent/trusted-context';

interface ToolCall {output?:unknown;error?:unknown;timing?:unknown;_providerPart?:unknown}
interface TraceItem {role:string;_providerMessageId?:string;_providerMessage?:unknown;tool_calls:ToolCall[];error?:{code?:string;message?:string}}
interface Capture {record:{task_id:string;interactions:TraceItem[];failures:{context:string}[];final_result?:string};rawMessages:unknown[]}
interface FixtureModule {
 recordDirectEvaluatorExecution(input:Record<string,unknown>):Promise<number>;
 isCoreTraceRecordingError(error:unknown):boolean;
 recordEvaluatorExecution(client:{listMessages:()=>Promise<unknown[]>},input:Record<string,unknown>):Promise<number>;
 normalizeEvaluatorExecutionInteractions(messages:unknown[]):TraceItem[];
 runWithTrustedCoreAgentContext<T>(context:Record<string,unknown>,action:()=>T):T;
 runGeneralAgent(input:Record<string,unknown>):Promise<{sessionId:string;workspaceDir:string}>;
}

function compile(file:string,dependencies:Record<string,unknown>) {
 const exports:Record<string,unknown>={};
 const source=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 vm.runInNewContext(source,{exports,require:(name:string)=>{if(!(name in dependencies))throw new Error('Unexpected dependency '+name);return dependencies[name]},process,Date,Error,Promise,AbortSignal,AbortController,setTimeout,clearTimeout,console:{log:()=>{},warn:()=>{}},structuredClone});
 return exports as unknown as FixtureModule;
}
const raw=[{info:{id:'message-user',role:'user',time:{created:1794441600000}},parts:[{type:'text',text:'question'}]},
 {info:{id:'message-assistant',role:'assistant',time:{created:1794441601000,completed:1794441602000},tokens:{input:4,output:2}},parts:[{type:'tool',id:'part-tool',callID:'call-search',tool:'search',state:{status:'completed',input:{q:'x'},output:'found',opaque:{x:1}}},{type:'text',text:'answer'}]}];
function recorder(core=true){let legacy=0;const script=compile('src/lib/engine/evaluation/evaluator-execution-recorder.ts',{
 '@/lib/storage/data-service':{saveExecutionRecord:async()=>{legacy++;return {success:true}}},
 '@/lib/storage-core/mode':{isStorageCoreEnabled:()=>core},
 '@/lib/storage-core/experiments':{getCoreExperimentContext:()=>undefined},
 '@/lib/engine/general-agent/trusted-context':trustedContext,
 '../../../../scripts/agent-run-diagnostics.cjs':{extractStructuredAgentError:({error}:{error:unknown})=>typeof error==='string'?error:JSON.stringify(error),sanitizeAgentDiagnostic:(error:unknown)=>String(error)},
 });return {module:script,legacy:()=>legacy};}

test('trusted core recorder receives standard record plus complete provider snapshot, never Prisma',async()=>{
 const h=recorder();const received:Capture[]=[];
 const count=await h.module.recordEvaluatorExecution({listMessages:async()=>raw},{taskId:'provider-session',agentName:'fault-diagnosis-agent',user:'legacy-user',query:'question',fallbackOutput:'answer',startedAt:'2026-11-12T00:00:00Z',completedAt:'2026-11-12T00:00:02Z',recordCoreTrace:async(value:unknown)=>{received.push(value as Capture)}});
 assert.equal(count,2);assert.equal(h.legacy(),0);assert.deepEqual(JSON.parse(JSON.stringify(received[0].rawMessages)),raw);
 assert.equal(received[0].record.task_id,'provider-session');assert.equal(received[0].record.interactions[1]._providerMessageId,'message-assistant');assert.deepEqual(JSON.parse(JSON.stringify(received[0].record.interactions[1]._providerMessage)),raw[1]);
 assert.equal(received[0].record.interactions[1].tool_calls[0].output,'found');
});

test('core recorder missing callback or failed callback cannot report a successful legacy save',async()=>{
 const h=recorder();const input={taskId:'provider-session',agentName:'fault-diagnosis-agent'};
 await assert.rejects(h.module.recordEvaluatorExecution({listMessages:async()=>raw},input),/trusted|core/i);
 await assert.rejects(h.module.recordEvaluatorExecution({listMessages:async()=>raw},{...input,recordCoreTrace:async()=>{throw new Error('core unavailable')}}),error=>h.module.isCoreTraceRecordingError(error) && String((error as {cause?:unknown}).cause).includes('core unavailable'));
 assert.equal(h.legacy(),0);
});

test('failed Agent run is recorded through the same callback with its actual failure and provider data',async()=>{
 const h=recorder();let captured:Capture|undefined;
 await h.module.recordEvaluatorExecution({listMessages:async()=>raw},{taskId:'provider-session',agentName:'fault-diagnosis-agent',failure:{code:'MODEL_ERROR',message:'actual failure'},startedAt:'2026-11-12T00:00:00Z',completedAt:'2026-11-12T00:00:02Z',recordCoreTrace:async(value:unknown)=>{captured=value as Capture}});
 assert.ok(captured);assert.equal(h.legacy(),0);assert.equal(captured.record.failures[0].context,'MODEL_ERROR');assert.equal(captured.record.interactions.at(-1)?.error?.message,'actual failure');assert.equal(captured.record.final_result,undefined);
});

test('legacy recorder retains saveExecutionRecord behavior when core mode is off',async()=>{
 const h=recorder(false);await h.module.recordEvaluatorExecution({listMessages:async()=>raw},{taskId:'provider-session',agentName:'fault-diagnosis-agent'});assert.equal(h.legacy(),1);
});

function runner(){
 const calls={workspace:0,model:0,chat:[] as {model:{modelID:string}}[]};const client={createSession:async()=>({id:'provider-session'}),listMessages:async()=>raw,chat:async(_id:string,payload:{model:{modelID:string}})=>{calls.chat.push(payload);return {text:'answer',transcriptText:'answer',stats:{eventCount:1}}},abortSession:async()=>{}};
 class Client {constructor(){return client}}
 const rec=recorder().module;
 const script=compile('src/lib/engine/general-agent/runner.ts',{
  './trusted-context':trustedContext,'node:fs':fs,'node:path':path,'node:crypto':{randomUUID:()=>crypto.randomUUID()},
  './session-cancellation':{withSessionCancellation:async(_signal:unknown,_abort:unknown,action:()=>unknown)=>action()},
  '../../../../scripts/agent-run-diagnostics.cjs':{createAgentRunError:(code:string,message:string,runFacts:unknown)=>Object.assign(new Error(message),{code,runFacts}),sanitizeAgentDiagnostic:(error:unknown)=>String(error)},
  undici:{Agent:class{},setGlobalDispatcher:()=>{}},
  '@/lib/engine/skill-generation/opencode-agent-cli/opencode-client':{AgentInsight:Client},
  '@/lib/engine/skill-generation/opencode-agent-cli/opencode-manager':{ensureOpencodeServer:async()=> 'http://fixture',runWithEphemeralOpencodeServer:async(_opts:unknown,action:(url:string)=>unknown)=>action('http://fixture')},
  './skill-resolver':{resolveSkill:async()=>null},'./expand-home':{expandHomePathsInText:(x:string)=>x},
  './server-model-config':{loadServerModelForUser:async()=>{calls.model++;return {providerID:'changed',modelID:'changed',baseURL:'http://changed'}}},
  './workspace':{buildPermissionsForWorkspace:()=>[],ensureUserWorkspace:()=>{calls.workspace++},ensureSessionWorkspace:()=>{calls.workspace++;return '/legacy'}},
  './skill-workspace-deployer':{deploySkillToWorkspace:()=>{}},'@/lib/internal-agent-tag':{tagOpencodeSession:()=>{}},
  '@/lib/system-agents':{findSystemAgentDefinition:()=>undefined,getSystemAgentId:async()=>''},
  '@/lib/engine/observability/opencode-derived-metrics':{deriveOpencodeExecutionFields:()=>({input_tokens:4,output_tokens:2})},
  '@/lib/engine/experiment/cancellation-context':{experimentSignal:()=>undefined},
  '@/lib/engine/evaluation/evaluator-execution-recorder':rec,
  '@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},
 });return {module:script,calls,client};
}

test('trusted async context reaches nested Agent recording and freezes workspace/model',async()=>{
 const h=runner();const dir=fs.mkdtempSync(path.join(os.tmpdir(),'trusted-agent-'));const captures:Capture[]=[];
 try{
  const model={providerID:'frozen',modelID:'frozen-model',baseURL:'http://frozen',apiKey:'private'};
  const result=await h.module.runWithTrustedCoreAgentContext({trustedWorkspaceDir:dir,trustedModel:model,recordCoreTrace:async(payload:unknown)=>{captures.push(payload as unknown as Capture)}},()=>h.module.runGeneralAgent({user:'legacy-user',query:'question',recordTraceAs:'fault-diagnosis-agent',model:{modelID:'untrusted-later'}}));
  assert.equal(result.sessionId,'provider-session');assert.equal(result.workspaceDir,fs.realpathSync(dir));assert.equal(h.calls.workspace,0);assert.equal(h.calls.model,0);assert.equal(h.calls.chat[0].model.modelID,'frozen-model');assert.equal(captures.length,1);
  await assert.rejects(h.module.runWithTrustedCoreAgentContext({trustedWorkspaceDir:dir,trustedModel:model,recordCoreTrace:async()=>{throw new Error('record unavailable')}},()=>h.module.runGeneralAgent({user:'legacy-user',query:'question',recordTraceAs:'fault-diagnosis-agent'})),error=>recorder().module.isCoreTraceRecordingError(error));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('core provider tool errors/timing are complete while legacy normalization stays lightweight',async()=>{
 const h=recorder();const source=structuredClone(raw);const part=source[1].parts[0] as {state:unknown};part.state={status:'error',input:{q:'x'},error:{message:'actual tool failure'},time:{start:1794441601100,end:1794441601900}};
 let payload:Capture|undefined;
 await h.module.recordEvaluatorExecution({listMessages:async()=>source},{taskId:'provider-session',agentName:'fault-diagnosis-agent',recordCoreTrace:async(value:unknown)=>{payload=value as Capture}});
 assert.ok(payload);const call=payload.record.interactions[1].tool_calls[0];assert.deepEqual(JSON.parse(JSON.stringify(call.error)),{message:'actual tool failure'});assert.deepEqual(JSON.parse(JSON.stringify(call.timing)),{started_at:1794441601100,completed_at:1794441601900});assert.deepEqual(JSON.parse(JSON.stringify(call._providerPart)),part);
 const legacy=h.module.normalizeEvaluatorExecutionInteractions(source);assert.equal('_providerMessage' in legacy[1],false);assert.equal('_providerPart' in legacy[1].tool_calls[0],false);
});

test('failed runner calls await the trusted recorder and never turn recording failure into success',async()=>{
 const h=runner();const dir=fs.mkdtempSync(path.join(os.tmpdir(),'trusted-failure-'));const captured:Capture[]=[];
 try {
  const model={providerID:'p',modelID:'m',baseURL:'http://fixture'};
  const bad=Object.assign(new Error('actual model failure'),{code:'MODEL_ERROR'});
  h.client.chat=async()=>{throw bad};
  await assert.rejects(h.module.runWithTrustedCoreAgentContext({trustedWorkspaceDir:dir,trustedModel:model,recordCoreTrace:async(value:unknown)=>{captured.push(value as Capture)}},()=>h.module.runGeneralAgent({user:'legacy-user',query:'question',recordTraceAs:'fault-diagnosis-agent'})),/actual model failure/);
  assert.equal(captured.length,1);assert.equal(captured[0].record.failures[0].context,'MODEL_ERROR');assert.equal(captured[0].record.interactions.at(-1)?.error?.code,'MODEL_ERROR');assert.equal(h.calls.workspace,0);
  await assert.rejects(h.module.runWithTrustedCoreAgentContext({trustedWorkspaceDir:dir,trustedModel:model,recordCoreTrace:async()=>{throw new Error('storage unavailable')}},()=>h.module.runGeneralAgent({user:'legacy-user',query:'question',recordTraceAs:'fault-diagnosis-agent'})),error=>recorder().module.isCoreTraceRecordingError(error));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('direct recorder inherits the same trusted async callback without caller plumbing',async()=>{
 const h=recorder();const captured:Capture[]=[];
 await trustedContext.runWithTrustedCoreAgentContext({trustedWorkspaceDir:'/private',trustedModel:{providerID:'p',modelID:'m',baseURL:'http://fixture'},recordCoreTrace:async(payload)=>{captured.push(payload as unknown as Capture)}},()=>h.module.recordEvaluatorExecution({listMessages:async()=>raw},{taskId:'provider-session',agentName:'skill-suggestion-agent'}));
 assert.equal(captured.length,1);assert.equal(captured[0].record.interactions[1]._providerMessageId,'message-assistant');assert.equal(h.legacy(),0);
});

test('trusted cancellation cannot be replaced by a nested caller signal',async()=>{
 const h=runner();const dir=fs.mkdtempSync(path.join(os.tmpdir(),'trusted-cancel-'));const controller=new AbortController();controller.abort(new Error('trusted operation cancelled'));
 try {
  await assert.rejects(trustedContext.runWithTrustedCoreAgentContext({trustedWorkspaceDir:dir,trustedModel:{providerID:'p',modelID:'m',baseURL:'http://fixture'},recordCoreTrace:async()=>{},cancelSignal:controller.signal},()=>h.module.runGeneralAgent({user:'legacy-user',query:'question',recordTraceAs:'fault-diagnosis-agent',cancelSignal:new AbortController().signal})),/trusted operation cancelled/);
  assert.equal(h.calls.chat.length,0);assert.equal(h.calls.workspace,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('direct model failure records actual partial response and explicitly direct provider provenance',async()=>{
 const h=recorder();let payload:Capture|undefined;
 await h.module.recordDirectEvaluatorExecution({taskId:'direct-request',agentName:'trajectory-evaluator',systemPrompt:'actual rubric',userMessage:'actual full input',assistantOutput:'partial response',usage:{input:4},modelID:'actual-model',startedAtISO:'2026-11-12T00:00:00Z',completedAtISO:'2026-11-12T00:00:01Z',failure:{code:'PARSE_FAILED',message:'actual parse error'},recordCoreTrace:async(value:unknown)=>{payload=value as Capture}});
 assert.ok(payload);assert.equal(payload.record.final_result,undefined);assert.equal(payload.record.failures[0].context,'PARSE_FAILED');
 const assistant=payload.record.interactions.find(item=>item.role==='assistant');assert.ok(assistant);assert.equal(assistant.error?.code,'PARSE_FAILED');
 assert.equal(payload.rawMessages.length,3);assert.ok(payload.rawMessages.every(item=>!!item&&typeof item==='object'&&'source'in item&&item.source==='direct-llm'));assert.equal(h.legacy(),0);
});
