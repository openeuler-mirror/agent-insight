import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import ts from 'typescript';
import * as trustedContext from '@/lib/engine/general-agent/trusted-context';
import * as frozenModel from '@/lib/storage-core/frozen-model';

const nativeRequire=createRequire(import.meta.url);
const card={id:'custom-frozen',name:'frozen_judge',evaluatorType:'LLM',llmConfig:{systemPrompt:'Evaluate {{input}} / {{reference_output}}',userPrompt:'Actual {{output}}',skills:[]}};
const input={caseInput:'question',actualOutput:'actual',expectedOutput:'gold'};
const answer='{"score":87,"reason":"original reason"}';
function harness(options:{core?:boolean;abort?:boolean;recordError?:boolean;chatError?:boolean;empty?:boolean;listError?:boolean;streamError?:boolean;recordGate?:Promise<void>;creationError?:boolean;rawText?:string;apiKey?:string;skillRecorderError?:boolean;force?:boolean;directError?:boolean}={}){
 const controller=new AbortController();const records:any[]=[];const calls={legacyReads:0,legacyWrites:0,skills:0,abort:0,deleted:0,direct:0,logs:[] as string[],models:[] as any[],directMessages:[] as any[],options:[] as any[],payloads:[] as any[],sessions:[] as any[]};
 const apiKey=options.apiKey??'api-secret';
 const raw=[{info:{id:'real-user',role:'user'},parts:[{type:'text',text:'Actual actual'}]},{info:{id:'real-answer',role:'assistant',modelID:'frozen-model'},parts:[{type:'text',text:answer},{type:'tool',tool:'read',state:{input:{token:'header-secret'},output:apiKey}}]}];
 const trusted={trustedWorkspaceDir:'/tmp/private-frozen-evaluator',trustedModel:{providerID:'frozen-provider',modelID:'frozen-model',apiKey,baseURL:'https://fixture.invalid',headers:{'X-Token':'header-secret'}},cancelSignal:controller.signal,recordCoreTrace:async(value:any)=>{await options.recordGate;if(options.recordError)throw Error('index unavailable');records.push(value);}};
 const client={createSession:async(value:any)=>{calls.sessions.push(value);if(options.creationError)throw Error('creation failed');return{id:'provider-session'};},listMessages:async()=>{if(options.listError)throw Error('messages unavailable');return options.empty?[]:raw;},abortSession:async()=>{calls.abort++;return true;},deleteSession:async()=>{calls.deleted++;},chat:async(_id:string,payload:any,handlers:any)=>{calls.payloads.push(payload);if(options.abort)controller.abort(Error('lease lost'));if(options.streamError)handlers.onError(Error('stream failed api-secret'));if(options.chatError)throw Error('provider failed api-secret header-secret');return{text:options.rawText??answer};}};
 const deps:Record<string,any>={
  '@/lib/engine/general-agent/trusted-context':trustedContext,
  '@langchain/openai':{ChatOpenAI:class{constructor(value:any){calls.models.push(value);}async invoke(messages:any,invokeOptions:any){calls.direct++;calls.directMessages.push(messages);if(options.core!==false)assert.ok(invokeOptions.signal);if(options.abort)controller.abort(Error('lease lost'));if(options.directError)throw Error('direct provider failed api-secret');return{content:answer,usage_metadata:{input_tokens:4,output_tokens:3,total_tokens:7}};}}},
  '@langchain/core/messages':{HumanMessage:class{constructor(readonly content:any){}},SystemMessage:class{constructor(readonly content:any){}}},
  '@/lib/server/model-fetch':{getModelFetch:()=>fetch},
  './cancellation-context':{experimentSignal:()=>undefined},
  './evaluation-attempt':{evaluationAttemptSignal:()=>undefined,remainingEvaluationTimeMs:()=>undefined,trackEvaluationRequest:async(action:any)=>action()},
  './evaluator-execution-policy':{hasEvaluatorExecutionPolicy:()=>false,withConfiguredEvaluationTimeout:async(action:any)=>action()},
  '@/lib/evaluators/judge-assembly':{JudgeOutputParseError:class extends Error{}},
  '@/lib/storage-core/frozen-model':frozenModel,
  '@/lib/storage-core/mode':{isStorageCoreEnabled:()=>options.core!==false},
  '@/lib/storage-core/experiments':{getCoreExperimentContext:()=>undefined},
  '@/lib/evaluators/model-configuration-error':{MISSING_EVALUATION_MODEL_MESSAGE:'missing frozen model'},
  './custom-evaluator-runtime':{runCustomEvaluatorWithSkills:async()=>{calls.skills++;if(options.skillRecorderError)throw new Error('wrapped Skill recorder failure',{cause:new deps['./evaluator-execution-recorder'].CoreTraceRecordingError(Error('index unavailable'))});throw Error('not original algorithm');},CustomEvaluatorExecutionError:class extends Error{}},
  '@/lib/engine/general-agent/concurrency-limiter':{withBackgroundOpencodeSlot:async(action:()=>unknown)=>action()},
  '@/lib/engine/general-agent/workspace':{buildEvaluatorPermissions:()=>[{permission:'read',action:'allow'}]},
  '@/lib/storage/server-config':{getActiveConfig:async()=>{calls.legacyReads++;return{model:'legacy-model',apiKey:'old',baseUrl:'https://legacy.invalid'};}},
  '@/lib/shared/model-connection':{isModelConnectionReady:()=>true},
  '@/lib/engine/general-agent/server-model-config':{loadServerModelForUser:async()=>{calls.legacyReads++;return{providerID:'legacy',modelID:'legacy-model'};},inferProviderFromBaseUrl:()=> 'legacy',normalizeProviderID:(v:unknown)=>v},
  '@/lib/storage/prisma':{prismaRaw:{registeredAgent:{findFirst:async()=>({id:'original-agent',agentOwnership:'system',agentType:'main',description:'系统：自建评估器（自动注册）'})}}},
  '@/lib/internal-agent-tag':{tagOpencodeSession:()=>{}},
  '@/server/user_evaluators_storage':{readUserCustomEvaluators:async()=>{calls.legacyReads++;return[card];}},
  '@/lib/evaluators/custom-evaluator-model':nativeRequire('../src/lib/evaluators/custom-evaluator-model.ts'),
  '@/lib/evaluators/custom-evaluator-score':nativeRequire('../src/lib/evaluators/custom-evaluator-score.ts'),
  '@/lib/engine/experiment/cancellation-context':{experimentSignal:()=>undefined},
  '@/lib/engine/experiment/evaluation-attempt':{evaluationAttemptSignal:()=>undefined},
  '@/lib/engine/general-agent/session-cancellation':nativeRequire('../src/lib/engine/general-agent/session-cancellation.ts'),
  '@/lib/engine/skill-generation/opencode-agent-cli/opencode-client':{AgentInsight:class{constructor(){return client;}}},
  '@/lib/engine/skill-generation/opencode-agent-cli/opencode-manager':{runWithEphemeralOpencodeServer:async(opts:any,fn:any)=>{calls.options.push(opts);return fn('http://fixture.invalid');}},
  '@/lib/storage/data-service':{saveExecutionRecord:async()=>{calls.legacyWrites++;throw Error('legacy result write forbidden');}},
 };
 function load(file:string){const exports:Record<string,any>={};const output=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;vm.runInNewContext(output,{exports,require:(name:string)=>{if(name in deps)return deps[name];if(name.endsWith('agent-run-diagnostics.cjs'))return nativeRequire('../scripts/agent-run-diagnostics.cjs');if(name.startsWith('node:'))return nativeRequire(name);throw Error('Unexpected dependency '+name);},process,Date,Error,Promise,AbortSignal,AbortController,structuredClone,setTimeout:(fn:any,ms:number)=>{const timer=setTimeout(fn,ms);timer.unref();return timer;},clearTimeout,console:{...console,warn:(...values:any[])=>calls.logs.push(values.map(String).join(' '))}});return exports;}
 deps['./evaluator-execution-recorder']=load('src/lib/engine/evaluation/evaluator-execution-recorder.ts');
 deps['./evaluator-execution-recorder'].shouldForceOpencodeEvalTransport=()=>!!options.force;
 deps['@/lib/engine/evaluation/evaluator-execution-recorder']=deps['./evaluator-execution-recorder'];
 const evaluator=load('src/lib/engine/evaluation/custom-llm-evaluator.ts');
 const judge=load('src/lib/engine/experiment/judge-llm.ts');
 const request={system:'unchanged system',user:'unchanged user',recordTrace:{agentName:'frozen_judge',query:'unchanged query'}};
 const runJudge=(req:any=request)=>trustedContext.runWithTrustedCoreAgentContext(trusted,()=>judge.callJudgeLlm('alice',req));
 const runOpenCode=(req:any=request)=>trustedContext.runWithTrustedCoreAgentContext(trusted,()=>judge.opencodeJudgeCaller('alice',req));
 const run=(...cards:any[])=>trustedContext.runWithTrustedCoreAgentContext(trusted,()=>evaluator.runCustomLlmEvaluator('alice',card.id,input,null,null,cards.length?cards[0]:card));
 return{run,evaluator,trusted,controller,calls,records,raw,runJudge,runOpenCode,request};
}

test('core custom evaluator keeps original prompt/parser with frozen runtime and acknowledged private Trace',async()=>{
 const h=harness();const result=await h.run();assert.equal(h.calls.legacyReads,0);assert.equal(h.calls.legacyWrites,0);assert.equal(h.calls.skills,0);assert.equal(h.calls.options[0].captureMode,'core-recorded');assert.equal(h.calls.options[0].frozenModel.apiKey,'api-secret');assert.equal(h.calls.sessions[0].directory,h.trusted.trustedWorkspaceDir);assert.equal(h.calls.payloads[0].model.modelID,'frozen-model');assert.equal(h.calls.payloads[0].text,'Actual actual');assert.match(h.calls.payloads[0].system,/Evaluate question \/ gold/);assert.match(h.calls.payloads[0].system,/score 必须是 0 到 100/);assert.equal(result.score,87);assert.equal(result.reason,'original reason');assert.equal(result.rawResponse,answer);assert.equal(result.runtime.evaluationTraceId,'provider-session');assert.equal(h.records.length,1);assert.equal(h.records[0].record.interactions[0].content,h.calls.payloads[0].system);assert.equal(h.records[0].rawMessages[1].info.id,'real-answer');assert.ok(!JSON.stringify(h.records).includes('api-secret'));assert.ok(!JSON.stringify(h.records).includes('header-secret'));assert.equal(h.calls.deleted,1);
});
test('core custom Trace recording failure blocks score publication',async()=>{const h=harness({recordError:true});await assert.rejects(h.run(),/Core Trace recording failed/);assert.equal(h.calls.legacyWrites,0);});
test('core custom provider failure records actual failure and redacts configured credentials',async()=>{const h=harness({chatError:true});const value=await h.run();assert.equal(value.score,null);assert.equal(h.records.length,1);assert.ok(h.records[0].record.failures.length);assert.equal(h.records[0].rawMessages[1].info.id,'real-answer');assert.ok(!JSON.stringify(h.records).includes('api-secret'));assert.ok(!JSON.stringify(h.records).includes('header-secret'));assert.ok(!JSON.stringify(value).includes('api-secret'));});
test('core custom empty-message failure records unavailable source evidence without invented provider data',async()=>{const h=harness({chatError:true,listError:true});const value=await h.run();assert.equal(value.score,null);assert.equal(h.records.length,1);assert.equal(h.records[0].record.source_messages_unavailable,true);assert.equal(h.records[0].rawMessages.length,0);assert.ok(h.records[0].record.failures.length);});
test('core custom cancellation records attempt but never returns stale score',async()=>{const h=harness({abort:true});await assert.rejects(h.run(),/lease lost/);assert.equal(h.calls.abort,1);assert.equal(h.records.length,1);assert.ok(h.records[0].record.failures.length);});
test('core custom pre-cancelled attempt starts no provider',async()=>{const h=harness();h.controller.abort(Error('lease lost'));await assert.rejects(h.run(),/lease lost/);assert.equal(h.calls.options.length,0);assert.equal(h.calls.payloads.length,0);});
test('core custom requires frozen evaluator and trusted model scope before mutable reads',async()=>{const h=harness();await assert.rejects(h.run(undefined),/Frozen custom evaluator/);await assert.rejects(h.evaluator.runCustomLlmEvaluator('alice',card.id,input,null,null,card),/Trusted core/);assert.equal(h.calls.legacyReads,0);assert.equal(h.calls.options.length,0);});
test('core no-model plan returns configuration error without starting a server or reading latest model',async()=>{const h=harness();const value=await frozenModel.runWithFrozenModelConfiguration('alice',null,()=>h.evaluator.runCustomLlmEvaluator('alice',card.id,input,null,null,card));assert.equal(value.error,'missing frozen model');assert.equal(h.calls.legacyReads,0);assert.equal(h.calls.options.length,0);});
test('legacy custom evaluator keeps original latest-model transport and result',async()=>{const h=harness({core:false});const value=await h.evaluator.runCustomLlmEvaluator('alice',card.id,input);assert.equal(value.score,87);assert.equal(value.runtime,undefined);assert.equal(h.calls.options[0].captureMode,undefined);assert.equal(h.calls.sessions[0].directory,'/tmp');assert.equal(h.calls.payloads[0].model.modelID,'legacy-model');assert.equal(h.records.length,0);assert.equal(h.calls.legacyReads,3);});

test('core custom does not publish a self Trace id until index acknowledgment',async()=>{
 let acknowledge!:()=>void;const gate=new Promise<void>(resolve=>{acknowledge=resolve;});const h=harness({recordGate:gate});let settled=false;const pending=h.run().then((value:any)=>{settled=true;return value;});await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);assert.equal(h.records.length,0);acknowledge();const value=await pending;assert.equal(value.runtime.evaluationTraceId,'provider-session');assert.equal(h.records.length,1);
});
test('core custom cancellation while indexing rejects stale result after acknowledgment',async()=>{
 let acknowledge!:()=>void;const gate=new Promise<void>(resolve=>{acknowledge=resolve;});const h=harness({recordGate:gate});const pending=h.run();await new Promise(resolve=>setImmediate(resolve));h.controller.abort(Error('lease lost while indexing'));acknowledge();await assert.rejects(pending,/lease lost while indexing/);assert.equal(h.records.length,1);assert.equal(h.calls.deleted,1);
});
test('core custom malformed output keeps parse error and failure Trace',async()=>{const h=harness({rawText:'unparseable'});const result=await h.run();assert.equal(result.score,null);assert.equal(result.error,'未能从模型响应中解析出 0-100 分数');assert.ok(h.records[0].record.failures.length);assert.equal(result.runtime.evaluationTraceId,'provider-session');});
test('core custom stream failure preserves original recoverable score behavior',async()=>{const h=harness({streamError:true});const result=await h.run();assert.equal(result.score,87);assert.equal(result.error,undefined);assert.ok(h.records[0].record.failures.length);assert.ok(!JSON.stringify(h.records).includes('api-secret'));});
test('core custom session creation failure records failed attempt without fabricating provider messages',async()=>{const h=harness({creationError:true});const result=await h.run();assert.equal(result.score,null);assert.equal(h.records[0].rawMessages.length,0);assert.equal(h.records[0].record.source_messages_unavailable,true);assert.ok(h.records[0].record.failures.length);});

test('core configured credentials containing JSON escapes are redacted without corrupting provider evidence',async()=>{const h=harness({apiKey:'fixture-"quote\nline\\value'});await h.run();const tool=h.records[0].rawMessages[1].parts[1];assert.equal(tool.state.output,'[REDACTED]');assert.equal(h.records[0].rawMessages[1].info.id,'real-answer');});

test('core Skill wrapper preserves fatal recorder failure cause instead of returning a score result',async()=>{const h=harness({skillRecorderError:true});await assert.rejects(h.run({...card,llmConfig:{...card.llmConfig,skills:[{name:'fixture'}]}}),/wrapped Skill recorder failure/);assert.equal(h.calls.skills,1);assert.equal(h.calls.options.length,0);});

test('core direct Judge keeps original sampling and prompt with frozen model and real direct Trace',async()=>{const h=harness();const result=await h.runJudge();assert.equal(result,answer);assert.equal(h.calls.legacyReads,0);assert.equal(h.calls.direct,1);assert.equal(h.calls.options.length,0);assert.equal(h.calls.models[0].model,'frozen-model');assert.equal(h.calls.models[0].temperature,0);assert.equal(h.calls.models[0].topP,1);assert.equal(h.calls.models[0].modelKwargs.seed,42);assert.equal(h.calls.directMessages[0][0].content,'unchanged system');assert.equal(h.calls.directMessages[0][1].content,'unchanged user');assert.equal(h.records.length,1);assert.equal(h.records[0].record.query,'unchanged query');assert.equal(h.records[0].rawMessages[1].content,'unchanged user');assert.equal(h.records[0].rawMessages[2].usage.total,7);});
test('core direct Judge index failure blocks fallback and Trace saved callback',async()=>{const h=harness({recordError:true});let saved=0;await assert.rejects(h.runJudge({...h.request,onTraceSaved:()=>saved++}),/Core Trace recording failed/);assert.equal(saved,0);assert.equal(h.calls.direct,1);assert.equal(h.calls.options.length,0);});
test('core direct Judge preserves original OpenCode fallback with both real attempt Traces',async()=>{const h=harness({directError:true});assert.equal(await h.runJudge(),answer);assert.equal(h.calls.direct,1);assert.equal(h.calls.payloads.length,1);assert.equal(h.records.length,2);assert.ok(h.records[0].record.failures.length);assert.equal(h.calls.legacyReads,0);});
test('core OpenCode Judge uses trusted model and preserves server Skill workspace',async()=>{const h=harness({force:true});let trace='';const result=await h.runOpenCode({...h.request,directory:'/tmp/evaluator-skills-frozen',onTraceSaved:(id:string)=>{trace=id;}});assert.equal(result,answer);assert.equal(h.calls.legacyReads,0);assert.equal(h.calls.options[0].captureMode,'core-recorded');assert.equal(h.calls.options[0].frozenModel.apiKey,'api-secret');assert.equal(h.calls.sessions[0].directory,'/tmp/evaluator-skills-frozen');assert.equal(h.calls.payloads[0].directory,'/tmp/evaluator-skills-frozen');assert.equal(h.calls.payloads[0].system,'unchanged system');assert.equal(h.calls.payloads[0].text,'unchanged user');assert.equal(trace,'provider-session');assert.equal(h.records[0].rawMessages[1].info.id,'real-answer');});
test('core OpenCode Judge index failure is fatal and session still cleaned',async()=>{const h=harness({recordError:true});let saved=0;await assert.rejects(h.runOpenCode({...h.request,onTraceSaved:()=>saved++}),/Core Trace recording failed/);assert.equal(saved,0);assert.equal(h.calls.deleted,1);});
test('core OpenCode Judge failed session preserves full failure evidence',async()=>{const h=harness({chatError:true});await assert.rejects(h.runOpenCode(),/provider failed/);assert.equal(h.records.length,1);assert.ok(h.records[0].record.failures.length);assert.ok(!JSON.stringify(h.records).includes('api-secret'));});
test('core OpenCode Judge lease loss never publishes Trace saved callback or text',async()=>{const h=harness({abort:true});let saved=0;await assert.rejects(h.runOpenCode({...h.request,onTraceSaved:()=>saved++}),/lease lost/);assert.equal(saved,0);assert.equal(h.records.length,1);assert.ok(h.records[0].record.failures.length);assert.equal(h.calls.abort,1);});

test('core direct provider fallback redacts configured credential values from diagnostic logs',async()=>{const h=harness({directError:true});await h.runJudge();assert.ok(!h.calls.logs.join(' ').includes('api-secret'));assert.ok(h.calls.logs.join(' ').includes('direct provider failed'));});
test('legacy direct Judge keeps original no-Trace semantics and configured model',async()=>{const h=harness({core:false});let saved=0;assert.equal(await h.runJudge({...h.request,onTraceSaved:()=>saved++}),answer);assert.equal(h.calls.direct,1);assert.equal(h.calls.legacyReads,1);assert.equal(h.calls.models[0].model,'legacy-model');assert.equal(h.records.length,0);assert.equal(saved,0);});
