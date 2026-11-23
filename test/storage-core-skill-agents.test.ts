import * as modelConnection from '../src/lib/shared/model-connection';
import { getModelClientConfig } from '../src/lib/server/model-client';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import ts from 'typescript';
import * as context from '@/lib/engine/general-agent/trusted-context';

const nativeRequire=createRequire(import.meta.url);
const judgment=JSON.stringify({overall:{score:1,reason:'complete'},dimension_scores:{completeness:1,tool_choice:1,redundancy:1},key_action_results:[{action_id:'a',action_content:'do',coverage:'covered',severity:'low',trace_comparison_analysis:'real evidence'}],reason_text:'verified'});
const suggestions=JSON.stringify({suggestions:[{category:'指令缺失',severity:'medium',summary:'Add check',evidence:'actual tool output',improvementSuggestion:'Validate input'}]});
const input={caseId:'case',caseInput:'task',taskId:'source',executionId:'source',actualInteractions:[{role:'assistant',content:'real'}],comparisonMode:'skill_key_actions',referenceKeyActions:[{id:'a',content:'do'}],actualExtractedSteps:[]};
class CoreRecordingFailure extends Error {coreTraceRecordingFailed=true;}

function harness(t:test.TestContext,options:{force?:boolean;directError?:boolean;chatError?:boolean;recordError?:boolean;abortDuringCall?:boolean;directText?:string;cancel?:AbortController;core?:boolean}={}){
 const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'core-skill-agents-'));t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));
 const controller=options.cancel??new AbortController();const records:any[]=[];const modelOptions:any[]=[];const calls={chat:0,direct:0,legacyConfig:0,legacyWorkspace:0,opts:[] as any[],sessions:[] as any[],payloads:[] as any[]};
 const raw=[{info:{id:'provider-user',role:'user'},parts:[{type:'text',text:'real request'}]},{info:{id:'provider-answer',role:'assistant'},parts:[{type:'tool',callID:'real-call',tool:'read',state:{input:{path:'manifest.json'},output:'actual body'}}]}];
 const trusted={trustedWorkspaceDir:workspace,trustedModel:{providerID:'frozen-provider',modelID:'frozen-model',apiKey:'fixture-key',baseURL:'https://fixture.invalid'},cancelSignal:controller.signal,recordCoreTrace:async(value:any)=>{if(options.recordError)throw new CoreRecordingFailure('recording unavailable');records.push(value);}};
 const client={createSession:async(value:any)=>{calls.sessions.push(value);return{id:'provider-session'};},listMessages:async()=>raw,abortSession:async()=>{},chat:async(_id:string,payload:any,_handlers:any,chatOptions:any)=>{
  calls.chat++;calls.payloads.push(payload);if(options.core!==false){assert.equal(calls.sessions.at(-1).directory,workspace);assert.equal(payload.model.modelID,'frozen-model');assert.ok(chatOptions.signal);assert.equal(chatOptions.signal.aborted,false);}
  if(fs.existsSync(path.join(workspace,'manifest.json')))assert.equal(fs.readFileSync(path.join(workspace,'manifest.json'),'utf8'),'full trace');
  if(options.abortDuringCall)controller.abort(Error('cancelled'));
  if(options.chatError)throw Error('provider actual failure');
  return{text:payload.agent==='plan'?suggestions:judgment,transcriptText:payload.agent==='plan'?suggestions:judgment};
 }};
 class Client {constructor(){return client;}}
 class ChatModel {constructor(value:any){modelOptions.push(value);}async invoke(_messages:any,opts:any){calls.direct++;if(options.core!==false)assert.ok(opts.signal);if(options.abortDuringCall)controller.abort(Error('cancelled'));if(options.directError)throw Error('provider unavailable');return{content:options.directText??judgment,usage_metadata:{input_tokens:2,output_tokens:1}};}}
 const record=async(value:any,rawMessages:unknown[])=>{const current=context.getTrustedCoreAgentContext();if(!current){assert.equal(options.core,false);records.push({legacy:true,record:value,rawMessages});return;}await current.recordCoreTrace({record:value,rawMessages} as any);};
 const deps:Record<string,any>={
  '@/lib/engine/general-agent/trusted-context':context,
  '@/lib/storage-core/mode':{isStorageCoreEnabled:()=>options.core!==false},
  '@/lib/evaluators/model-configuration-error':{MISSING_EVALUATION_MODEL_MESSAGE:'missing model'},
  '@/lib/engine/general-agent/concurrency-limiter':{withBackgroundOpencodeSlot:async(action:()=>unknown)=>action()},
  '@/lib/storage/server-config':{getActiveConfig:async()=>{calls.legacyConfig++;return{id:'old',name:'old',model:'old-model',apiKey:'old',baseUrl:'https://old.invalid'};}},
  '@/lib/engine/general-agent/server-model-config':{loadServerModelForUser:async()=>{calls.legacyConfig++;return{providerID:'old',modelID:'old-model'};},inferProviderFromBaseUrl:()=> 'fixture',normalizeProviderID:(v:unknown)=>v},
  '@langchain/openai':{ChatOpenAI:ChatModel},'@/lib/server/model-fetch':{getModelFetch:()=>fetch},
  '../experiment/evaluator-execution-policy':{hasEvaluatorExecutionPolicy:()=>false,runConfiguredEvaluationStage:async(fn:()=>unknown)=>fn()},
  '../experiment/evaluation-attempt':{remainingEvaluationTimeMs:()=>undefined,trackEvaluationRequest:async(fn:()=>unknown)=>fn()},
  '../experiment/cancellation-context':{experimentSignal:()=>undefined},
  '@/lib/engine/experiment/cancellation-context':{experimentSignal:()=>undefined},
  '@/lib/evaluators/judge-assembly':{JudgeOutputParseError:class extends Error{}},
  '@langchain/core/messages':{HumanMessage:class{constructor(readonly content:any){}},SystemMessage:class{constructor(readonly content:any){}}},
  './evaluator-execution-recorder':{recordDirectEvaluatorExecution:async(value:any)=>record(value,[]),recordEvaluatorExecution:async(c:any,value:any)=>record(value,await c.listMessages(value.taskId)),shouldForceOpencodeEvalTransport:()=>!!options.force,isCoreTraceRecordingError:(e:any)=>e?.coreTraceRecordingFailed===true},
  '@/lib/shared/interaction-content':{stringifyClaudeContent:(v:unknown)=>String(v)},
  './agent-trajectory-facts':nativeRequire('../src/lib/engine/evaluation/agent-trajectory-facts.ts'),
  '@/lib/internal-agent-tag':{tagOpencodeSession:()=>{}},
  '@/lib/system-agents':{getSystemAgentId:async()=> 'system',findSystemAgentDefinition:()=>({traceSkill:'fixture'})},
  './trajectory-evaluator':nativeRequire('../src/lib/engine/evaluation/trajectory-evaluator.ts'),
  '@/lib/engine/skill-generation/opencode-agent-cli/opencode-client':{AgentInsight:Client},
  '@/lib/engine/skill-generation/opencode-agent-cli/opencode-manager':{runWithEphemeralOpencodeServer:async(opts:any,fn:any)=>{calls.opts.push(opts);opts.signal?.throwIfAborted();return fn('http://fixture.invalid');}},
  '@/lib/engine/general-agent':{ensureSessionWorkspace:()=>{calls.legacyWorkspace++;return workspace;},buildPermissionsForWorkspace:()=>[]},
  '@/lib/engine/observability/trace-bundle':{ensureTraceBundle:(args:any)=>{fs.writeFileSync(path.join(args.workspaceDir,'manifest.json'),'full trace');return{manifestRelPath:'manifest.json',indexRelPath:'index.json',bundleRelDir:'.',nodeCount:1,artifactCount:0};}},
  jsonrepair:{jsonrepair:(v:unknown)=>v},
 };
 function load(file:string){
  const exports:Record<string,any>={};const output=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  vm.runInNewContext(output,{exports,require:(name:string)=>{if(name==='@/lib/shared/model-connection')return modelConnection;if(name==='@/lib/server/model-client')return {getModelClientConfig};if(name in deps)return deps[name];if(name.startsWith('node:'))return nativeRequire(name);throw Error('Unexpected dependency '+name);},process,Date,Error,Promise,AbortSignal,AbortController,structuredClone,setTimeout,clearTimeout,Buffer,fetch,console:{log:()=>{},warn:()=>{}}});
  return exports;
 }
 const trajectory=load('src/lib/engine/evaluation/opencode-trajectory-evaluator.ts');const suggestion=load('src/lib/engine/evaluation/skill-suggestion-agent.ts');
 const run=<T>(action:()=>T)=>context.runWithTrustedCoreAgentContext(trusted,action);
 return {calls,records,workspace,modelOptions,controller,run,trajectory:()=>trajectory.evaluateTrajectoryViaOpencode(input,'alice'),suggestion:()=>suggestion.runSkillSuggestionAgent({user:'alice',skillName:'skill',executionId:'source',interactions:input.actualInteractions,keyActionResults:[],maxAttempts:1}),raw};
}

test('core direct trajectory keeps direct transport and frozen model, recording exact prompt/output',async t=>{
 const h=harness(t);await h.run(h.trajectory);assert.equal(h.calls.direct,1);assert.equal(h.calls.chat,0);assert.equal(h.calls.legacyConfig,0);assert.equal(h.modelOptions[0].model,'frozen-model');assert.equal(h.records.length,1);assert.equal(h.records[0].record.assistantOutput,judgment);assert.ok(h.records[0].record.systemPrompt);assert.ok(h.records[0].record.userMessage);
});
test('core OpenCode trajectory uses frozen directory/model/cancellation and full provider messages',async t=>{
 const h=harness(t,{force:true});await h.run(h.trajectory);assert.equal(h.calls.direct,0);assert.equal(h.calls.chat,1);assert.equal(h.calls.legacyConfig,0);assert.equal(h.calls.opts[0].signal.aborted,false);assert.equal(h.calls.opts[0].captureMode,'core-recorded');assert.equal(h.calls.opts[0].frozenModel.modelID,'frozen-model');assert.equal(h.calls.opts[0].frozenModel.apiKey,'fixture-key');assert.deepEqual(h.records[0].rawMessages,h.raw);
});
test('core suggestion writes and reads its full bundle in the same trusted directory',async t=>{
 const h=harness(t);const value=await h.run(h.suggestion);assert.equal(value.length,1);assert.equal(h.calls.legacyWorkspace,0);assert.equal(h.calls.legacyConfig,0);assert.equal(h.calls.chat,1);assert.equal(h.calls.opts[0].captureMode,'core-recorded');assert.equal(h.calls.opts[0].frozenModel.modelID,'frozen-model');assert.equal(h.calls.opts[0].frozenModel.apiKey,'fixture-key');assert.deepEqual(h.records[0].rawMessages,h.raw);
});
test('failed direct model records the failure before preserving OpenCode fallback',async t=>{
 const h=harness(t,{directError:true});await h.run(h.trajectory);assert.equal(h.calls.direct,1);assert.equal(h.calls.chat,1);assert.equal(h.records.length,2);assert.ok(h.records[0].record.failure);assert.ok(h.records[0].record.systemPrompt);
});
test('core recorder errors are fatal and do not trigger another model transport or empty success',async t=>{
 for(const kind of ['direct','opencode','suggestion']){
  const h=harness(t,{force:kind==='opencode',recordError:true});await assert.rejects(h.run(kind==='suggestion'?h.suggestion:h.trajectory),/recording/);assert.equal(h.calls.direct+h.calls.chat,1);
 }
});
test('core failed suggestion preserves actual failure trace and throws rather than silently returning empty',async t=>{
 const h=harness(t,{chatError:true});await assert.rejects(h.run(h.suggestion),/provider actual failure/);assert.equal(h.records.length,1);assert.ok(h.records[0].record.failure);assert.deepEqual(h.records[0].rawMessages,h.raw);
});
test('pre-cancelled core job starts no model and writes no bundle',async t=>{
 for(const kind of ['direct','opencode','suggestion']){
  const controller=new AbortController();controller.abort(Error('cancelled'));const h=harness(t,{force:kind==='opencode',cancel:controller});await assert.rejects(h.run(kind==='suggestion'?h.suggestion:h.trajectory),/cancelled/);assert.equal(h.calls.direct+h.calls.chat,0);assert.equal(fs.existsSync(path.join(h.workspace,'manifest.json')),false);
 }
});

test('cancellation after provider response records that attempt and never starts a fallback',async t=>{
 for(const kind of ['direct','opencode','suggestion']){
  const h=harness(t,{force:kind==='opencode',abortDuringCall:true});await assert.rejects(h.run(kind==='suggestion'?h.suggestion:h.trajectory),/cancelled/);assert.equal(h.calls.direct+h.calls.chat,1);assert.equal(h.records.length,1);assert.ok(h.records[0].record.failure);
 }
});
test('malformed direct response is preserved as failed Trace before the original fallback',async t=>{
 const h=harness(t,{directText:'not-json'});await h.run(h.trajectory);assert.equal(h.records.length,2);assert.equal(h.records[0].record.assistantOutput,'not-json');assert.ok(h.records[0].record.failure);assert.equal(h.calls.chat,1);
});
test('failed core OpenCode attempt preserves provider messages before direct fallback',async t=>{
 const h=harness(t,{force:true,chatError:true});await h.run(h.trajectory);assert.equal(h.calls.chat,1);assert.equal(h.calls.direct,1);assert.equal(h.records.length,2);assert.ok(h.records[0].record.failure);assert.deepEqual(h.records[0].rawMessages,h.raw);
});
test('legacy direct transport still reads its configured model without trusted context',async t=>{
 const h=harness(t,{core:false});await h.trajectory();assert.equal(h.calls.direct,1);assert.equal(h.calls.chat,0);assert.equal(h.calls.legacyConfig,1);assert.equal(h.modelOptions[0].model,'old-model');assert.equal(h.records[0].legacy,true);
});
test('core calls without trusted context fail before models or source file writes',async t=>{
 for(const kind of ['direct','suggestion']){const h=harness(t);await assert.rejects(kind==='direct'?h.trajectory():h.suggestion(),/Trusted core/);assert.equal(h.calls.direct+h.calls.chat,0);assert.equal(h.calls.legacyConfig,0);}
});
test('legacy forced OpenCode still binds its original fixed directory',async t=>{
 const h=harness(t,{core:false,force:true});await h.trajectory();assert.equal(h.calls.chat,1);assert.equal(h.calls.direct,0);assert.equal(h.calls.sessions[0].directory,'/tmp');assert.equal(h.calls.opts[0].captureMode,undefined);assert.equal(h.calls.opts[0].frozenModel,undefined);assert.equal(h.records[0].legacy,true);
});
test('legacy suggestion model failure keeps its optional empty-result behavior',async t=>{
 const h=harness(t,{core:false,chatError:true});assert.equal((await h.suggestion()).length,0);assert.equal(h.calls.chat,1);assert.equal(h.calls.legacyWorkspace,1);assert.equal(h.records[0].legacy,true);assert.equal(h.records[0].record.failure,undefined);
});
