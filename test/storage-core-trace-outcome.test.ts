import { getModelClientConfig } from '../src/lib/server/model-client';
import {createIsolatedDatabase} from './helpers/isolated-database';
import {configuredModelFetchFixture,controlVmFixture} from './helpers/storage-core-vm';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
const database=createIsolatedDatabase();
test.after(async()=>{const {prismaRaw}=await import('../src/lib/storage/prisma');await prismaRaw.$disconnect();database.dispose();});
type Row=Record<string,unknown>;
type Api=typeof import('../src/lib/storage-core/trace-outcome') & typeof import('../src/lib/engine/evaluation/judge') & {POST:(request:Request)=>Promise<Response>};
import type {FrozenExperimentWork} from '../src/lib/storage-core/experiment-worker';
function load<T=Api>(file:string,deps:Record<string,unknown>){if(!deps['./control-context']&&file==='src/lib/storage-core/experiments.ts')deps['./control-context']=controlVmFixture({actor:{token:'fixture',principal:'alice',workspace:'w',username:'alice'}}).context;const runtimeModule={exports:{}};vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:runtimeModule,exports:runtimeModule.exports,require:(name:string)=>name==='@/lib/server/model-client'?{getModelClientConfig}:name==='@/lib/server/configured-model-fetch'?{configuredModelFetch:configuredModelFetchFixture}:name==='@/lib/usage-analytics/collector'?{recordUsageEvent:(event:Row)=>{assert.equal(event.user,'alice');assert.equal(event.featureKey,'trace');assert.equal(event.eventKey,'trace.update');}}:deps[name]??{},console,JSON,Buffer,process,Date,Map,Set,URL,URLSearchParams,Request,Response,TextDecoder,TextEncoder,fetch,structuredClone,setTimeout,clearTimeout,setInterval,clearInterval,AbortController,AbortSignal});return runtimeModule.exports as T;}
function frozen(mode='rejudge',criteria:unknown={root_causes:[]}){return {handle:{evaluator_id:'__trace_outcome__',experiment_id:'outcome',run_id:'run'},experiment_config:{scope:'trace-outcome'},runplan:{config:{core_outcome:{version:1,mode,trace_id:'trace',trace_snapshot_hash:'a'.repeat(64),criteria,query:'Question',skill_name:'skill',skill_definition:'Frozen Skill',invoked_skills:[{name:'skill',version:2}],execution_steps:null,flow_source:null}}},frozen_trace_evidence:{snapshot_hash:'a'.repeat(64),manifest:{trace_id:'trace'},execution:{id:'execution',taskId:'task',finalResult:'Answer',failures:'[{"reason":"previous"}]',skillIssues:null},session:{interactions:[]}}} as unknown as FrozenExperimentWork;}
test('frozen Outcome uses original judgment and attribution, preserving real zero and the dedicated source marker',async()=>{
 let judgments=0,analyses=0,old=0;const context={actor:{username:'alice'},rpc:async(action:string)=>{assert.equal(action,'check_work');}};
 const api=load('src/lib/storage-core/trace-outcome.ts',{'./experiments':{requireCoreExperimentContext:()=>context},'@/lib/engine/evaluation/judge':{normalizeInteractions:(x:unknown)=>x,judgeAnswer:async(query:string,criteria:Row,answer:string,user:string)=>{judgments++;assert.equal(query,'Question');assert.equal(criteria.skill_definition,'Frozen Skill');assert.equal(answer,'Answer');assert.equal(user,'alice');return {score:0,is_correct:false,reason:'real zero'};},analyzeFailures:async()=>{analyses++;return {failures:[{reason:'actual'}],skill_issues:[]};}},'@/lib/evaluator-agent':{isEvaluatorTraceRecord:()=>false},'./flow-model-delivery':{withCoreFlowModelDelivery:async(_ctx:unknown,_work:unknown,act:()=>Promise<unknown>)=>act()},'@/lib/storage/prisma':{db:new Proxy({},{get(){old++;throw Error('Old dynamic access');}})}});
 const result=await api.computeFrozenCoreOutcomeWork(frozen(),{user:'alice',signal:new AbortController().signal});assert.equal(result.score,0);assert.equal(result.evidence.json.coreOutcome.answer_score,0);assert.equal(result.evidence.json.coreOutcome.source_snapshot_hash,'a'.repeat(64));assert.equal((result.evidence.json.coreOutcome.failures[0] as Row).reason,'actual');assert.equal(judgments,1);assert.equal(analyses,1);assert.equal(old,0);
});
test('edited Final Result without a matching config completes as unknown score and retains original failure fields',async()=>{
 const context={actor:{username:'alice'},rpc:async()=>{}};const api=load('src/lib/storage-core/trace-outcome.ts',{'./experiments':{requireCoreExperimentContext:()=>context},'@/lib/engine/evaluation/judge':{normalizeInteractions:(x:unknown)=>x,judgeAnswer:()=>{throw Error('No model for unmatched config');},analyzeFailures:()=>{throw Error('Editing does not add rejudge-only analysis');}},'./flow-model-delivery':{withCoreFlowModelDelivery:async(_ctx:unknown,_work:unknown,act:()=>Promise<unknown>)=>act()}});
 const result=await api.computeFrozenCoreOutcomeWork(frozen('edited-final-result',null),{user:'alice',signal:new AbortController().signal});assert.equal(result.score,null);assert.equal(result.evidence.json.coreOutcome.answer_score,null);assert.equal(result.evidence.json.coreOutcome.judgment_reason,'未找到匹配的效果评测配置');assert.equal((result.evidence.json.coreOutcome.failures[0] as Row).reason,'previous');
});
test('frozen Outcome rejects a different source or actor before scoring',async()=>{
 let calls=0;const api=load('src/lib/storage-core/trace-outcome.ts',{'./experiments':{requireCoreExperimentContext:()=>({actor:{username:'alice'}})},'@/lib/engine/evaluation/judge':{judgeAnswer:()=>{calls++;}}});
 await assert.rejects(api.computeFrozenCoreOutcomeWork(frozen(),{user:'bob',signal:new AbortController().signal}),(e:Row)=>e.status===403);
 const other=frozen();other.frozen_trace_evidence!.snapshot_hash='b'.repeat(64);await assert.rejects(api.computeFrozenCoreOutcomeWork(other,{user:'alice',signal:new AbortController().signal}),(e:Row)=>e.status===409);assert.equal(calls,0);
});

test('trusted legacy Outcome judge records real model calls and propagates recording uncertainty',async()=>{
 let calls=0,records=0,legacy=0,recordingFailure=false;const trusted={trustedModel:{modelID:'frozen',apiKey:'key',baseURL:'http://model'},recordCoreTrace:async()=>{records++;if(recordingFailure)throw Error('unavailable');}};
 class Model{apiKey='key';chat={completions:{create:async()=>{calls++;return {choices:[{message:{content:'{"evaluations":[{"id":"RC-0","match_score":0,"explanation":"actual zero"}]}'}}]};}}};}
 const api=load('src/lib/engine/evaluation/judge.ts',{'node:crypto':{randomUUID},'openai':{OpenAI:Model},'@/lib/engine/general-agent/trusted-context':{getTrustedCoreAgentContext:()=>trusted},'@/lib/engine/evaluation/evaluator-execution-recorder':{buildDirectEvaluatorExecutionRecord:()=>({task_id:'real'})},'@/lib/storage-core/flow-model-delivery':{executeCoreFlowModelCall:async(_body:unknown,perform:()=>Promise<unknown>)=>perform()},'@/lib/storage/server-config':{getActiveConfig:()=>{legacy++;throw Error('Latest model read');}},'@/lib/server/model-fetch':{getModelFetch:()=>undefined},'@/lib/env':{resolveAgentInsightDataPath:()=>'/tmp/unused-outcome-log'},'@/lib/logger/server':{isLogEnabled:()=>false},'@/prompts/judge-prompt':{generateJudgePrompt:()=> 'judge'}});
 const first=await api.judgeAnswer('q',{root_causes:[{content:'rc',weight:1}]},'a','alice');assert.equal(first.score,0);assert.equal(calls,1);assert.equal(records,1);assert.equal(legacy,0);
 recordingFailure=true;await assert.rejects(api.judgeAnswer('q',{root_causes:[{content:'rc',weight:1}]},'a','alice'),(e:Row)=>e.code==='CORE_TRACE_RECORDING_FAILED');assert.equal(calls,2);assert.equal(records,2);
});

test('Final Result editing acknowledges only the atomic handoff and an exact retry uses its durable receipt',async()=>{
 let captured=0,configReads=0,scheduled=0,activations=0,replay:Row|null=null,finalValue:unknown;
 const context={actor:{username:'alice',principal:'p',workspace:'w'},operationKey:'edit',body:{task_id:'task',currentUser:'forged',final_result:'  edited  '},request:new Request('http://localhost/api/observe/data',{method:'PATCH',body:'{}'}),options:{},rpc:async(action:string,payload:Row)=>{
  if(action==='flow_lookup')return {match:null,attribution:null};
  if(action==='outcome_lookup')return {outcome:null,selection_hash:'prior-none'};
  if(action==='outcome_begin'){scheduled++;finalValue=payload.final_result;assert.equal(((payload.config as Row).core_outcome as Row).mode,'edited-final-result');assert.equal(((payload.config as Row).core_outcome as Row).criteria,null);return replay={experiment_id:'exp',run_id:'run',result_id:'slot',trace_id:'trace',execution_id:'execution',task_id:'task'};}
  throw Error('Unexpected '+action);
 }};
 const api=load('src/lib/storage-core/trace-outcome.ts',{'./experiments':{coreExperimentFailure:(cause:unknown)=>{throw cause;},requireCoreExperimentContext:()=>context,withCoreExperiments:async(_r:unknown,action:()=>Promise<unknown>)=>action(),lookupCoreExperimentOperation:async()=>replay},'./evidence':{readTraceOutcomeEvidence:async()=>{captured++;return {username:'alice',evidence:{manifest:{trace_id:'trace'},snapshot_hash:'a'.repeat(64),execution:{query:'question'},session:{interactions:[]}}};}},'@/lib/storage/data-service':{resolveImmutableSkillVersion:(input:{existingSkillVersion:number|null;incomingSkillVersion:number|null})=>({resolved:input.existingSkillVersion??input.incomingSkillVersion}),buildRecordEvaluationSnapshots:async(record:Row)=>({...record,routing_evaluation:{status:'missing',is_correct:false,trigger_rate:null},outcome_evaluation:{status:'missing',skill_breakdown:[]}}),readConfig:async(user:string)=>{assert.equal(user,'alice');configReads++;return [];},findBestOutcomeConfig:()=>null,findBestRoutingConfig:async()=>null,extractInvokedSkillsFromSessionInteractions:()=>[],getEvaluationContextLabel:()=> 'question'},'@/lib/engine/evaluation/judge':{normalizeInteractions:(x:unknown)=>x},'@/lib/storage/server-config':{getActiveConfig:async()=>null},'./frozen-model':{freezeModelSelection:()=>null},'./experiment-worker':{activateExperimentWork:async()=>{activations++;}}});
 const first=await api.handleCoreFinalResultEdit(context.request);assert.equal(first.status,200);assert.deepEqual(await first.json(),{success:true,message:'Final Result 已保存，正在后台重新评估'});assert.equal(finalValue,'edited');assert.equal(scheduled,1);
 const second=await api.handleCoreFinalResultEdit(context.request);assert.equal(second.status,200);assert.equal(captured,1);assert.equal(configReads,1);assert.equal(scheduled,1);assert.equal(activations,2);
});

test('the original rejudge and cancel endpoints choose core handlers before touching the legacy task manager or database',async()=>{
 let old=0;const forbidden=new Proxy({},{get(){old++;throw Error('Legacy DB');}});
 for(const [file,handler] of [['src/app/api/eval/rejudge/route.ts','handleCoreOutcomeRejudge'],['src/app/api/evaluation/cancel/route.ts','handleCoreOutcomeCancel']]){
  const route=load(file,{'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},'@/lib/storage-core/trace-outcome':{[handler]:async()=>Response.json({success:true,core:true})},'@/lib/storage/prisma':{db:forbidden}});
  const result=await route.POST(new Request('http://localhost/api',{method:'POST',body:'{"task_id":"task","currentUser":"alice"}'}));assert.equal(result.status,200);assert.equal((await result.json()).core,true);
 }
 assert.equal(old,0);
});

test('rejudge cancellation returns the original cancellation DTO using persisted status',async()=>{
 const context={actor:{username:'alice'},body:{task_id:'task',currentUser:'ignored-for-auth'},options:{},rpc:async(action:string)=>{
  if(action==='outcome_lookup')return {run_id:'run',is_evaluating:false,outcome:null};
  if(action==='result_lookup')return {status:'cancelled'};
  throw Error(action);
 }};
 const api=load('src/lib/storage-core/trace-outcome.ts',{'./experiments':{coreExperimentFailure:(cause:unknown)=>{throw cause;},requireCoreExperimentContext:()=>context,withCoreExperiments:async(_r:unknown,action:()=>Promise<unknown>)=>action(),lookupCoreExperimentOperation:async()=>({experiment_id:'exp',run_id:'run',result_id:'slot',trace_id:'trace',execution_id:'execution',task_id:'task'})},'./experiment-worker':{activateExperimentWork:async()=>{}}});
 const response=await api.handleCoreOutcomeRejudge(new Request('http://localhost/rejudge',{method:'POST'}));assert.equal(response.status,200);assert.deepEqual(await response.json(),{success:false,cancelled:true,message:'Evaluation cancelled'});
});

test('Outcome edit evidence explicitly allows a missing Session while keeping strict rejudge evidence unchanged',async()=>{
 process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';
 const {readTraceOutcomeEvidence,readTraceEvidence}=await import('../src/lib/storage-core/evidence');
 const token='session_'+'E'.repeat(43),request=new Request('http://localhost/edit',{headers:{authorization:'Bearer '+token}});
 const evidence={format:'agent-insight.trace-evidence',version:1,captured_at:'2026-11-16T00:00:00Z',snapshot_hash:'a'.repeat(64),manifest:{workspace_id:'w',trace_id:'trace'},execution:{id:'execution',taskId:'task',finalResult:''},session:null};
 const fetcher:typeof fetch=async(input,options)=>{
  assert.equal(new Headers(options?.headers).get('authorization'),'Bearer '+token);
  const url=new URL(String(input));
  if(url.pathname==='/v1/auth/me')return Response.json({principal_id:'alice',username:'alice',workspace_id:'w',workspaces:[{workspace_id:'w'}]});
  assert.equal(url.searchParams.get('view'),'outcome-edit');return Response.json({value:evidence});
 };
 const result=await readTraceOutcomeEvidence(request,{traceRef:'task'},{fetcher});assert.equal(result.evidence.session,null);assert.equal(result.evidence.execution.finalResult,'');
 await assert.rejects(readTraceEvidence(request,{traceRef:'task'},{fetcher:async input=>new URL(String(input)).pathname==='/v1/auth/me'?Response.json({principal_id:'alice',username:'alice',workspace_id:'w',workspaces:[{workspace_id:'w'}]}):Response.json({value:evidence})}));
});

test('apiFetch sends the original stored credential for rejudge, cancel and Final Result edit and preserves an explicit key',async()=>{
 const exports:Record<string,unknown>={},seen:Array<{url:string;key:string|null}>=[];
 vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/client/api.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,process:{env:{}},window:{},localStorage:{getItem:(key:string)=>key==='api_key'?'real-existing-key':null},Headers,Date,setTimeout,fetch:async(url:string,options:RequestInit)=>{seen.push({url,key:new Headers(options.headers).get('x-witty-api-key')});return Response.json({success:true});}});
 const apiFetch=exports.apiFetch as (url:string,options:RequestInit)=>Promise<Response>;
 for(const [url,method] of [['/api/eval/rejudge','POST'],['/api/evaluation/cancel','POST'],['/api/observe/data','PATCH']])await apiFetch(url,{method,body:'{}'});
 assert.deepEqual(seen.map(row=>row.key),['real-existing-key','real-existing-key','real-existing-key']);
 await apiFetch('/api/eval/rejudge',{method:'POST',body:'{}',headers:{'x-witty-api-key':'explicit-key'}});assert.equal(seen[3].key,'explicit-key');
});


test('editing preserves the last real Outcome failure analysis instead of the older ingestion capsule',async()=>{
 const context={actor:{username:'alice'},rpc:async()=>{}};
 const api=load('src/lib/storage-core/trace-outcome.ts',{'./experiments':{requireCoreExperimentContext:()=>context},'./flow-model-delivery':{withCoreFlowModelDelivery:async(_ctx:unknown,_work:unknown,act:()=>Promise<unknown>)=>act()}});
 const work=frozen('edited-final-result',null);
 ((work.runplan.config as Row).core_outcome as Row).previous_outcome={selection_hash:'prior',failures:[{reason:'current real Outcome'}],skill_issues:[{description:'current real issue'}]};
 work.frozen_trace_evidence!.session=null;
 const result=await api.computeFrozenCoreOutcomeWork(work,{user:'alice',signal:new AbortController().signal});
 assert.equal((result.evidence.json.coreOutcome.failures[0] as Row).reason,'current real Outcome');assert.equal((result.evidence.json.coreOutcome.skill_issues![0] as Row).description,'current real issue');
});

test('rejudge preserves real Session-derived Skill projection and original evaluation snapshots in the public record',async()=>{
 const service=await import('../src/lib/storage/data-service');const projection=await import('../src/lib/storage-core/trace-outcome-projection');
 const configs=[{id:'routing',query:'Question',dataset_type:'routing' as const,skill:'actual',expectedSkills:[{skill:'actual',version:2}],routing_intent:'Question',routing_anchors:['Question'],standard_answer:''},{id:'outcome',query:'Question',dataset_type:'outcome' as const,skill:'actual',skillVersion:2,standard_answer:'Expected',root_causes:[{content:'actual cause',weight:1}]}];
 const source={snapshot_hash:'a'.repeat(64),manifest:{trace_id:'trace'},execution:{id:'execution',taskId:'task',query:'Question',finalResult:'Answer',framework:'test'},session:{interactions:[{role:'assistant',content:'actual skill invocation'}]}};
 let manifest:Row={},resultValue:Row={};let captures=0,actualVersion:number|null=2;
 const selected=()=>({experiment_id:'exp',run_id:'run',selection_hash:'selected',is_evaluating:false,outcome:{value:resultValue,run_id:'run'}});
 const context={actor:{username:'alice',principal:'p',workspace:'w'},request:new Request('http://localhost/rejudge',{method:'POST',body:'{}'}),body:{task_id:'task',currentUser:'ignored'},options:{},rpc:async(action:string,payload:Row)=>{
  if(action==='flow_lookup')return {match:null,attribution:null};
  if(action==='outcome_begin'){manifest=(payload.config as Row).core_outcome as Row;return {experiment_id:'exp',run_id:'run',result_id:'slot',trace_id:'trace',execution_id:'execution',task_id:'task'};}
  if(action==='check_work')return {active:true};
  if(action==='outcome_lookup')return Object.keys(resultValue).length?selected():{outcome:null,selection_hash:'prior-none'};
  if(action==='result_lookup')return {status:'done'};
  throw Error(action);
 }};
 const api:Api=load('src/lib/storage-core/trace-outcome.ts',{'./trace-outcome-projection':projection,'./experiments':{coreExperimentFailure:(cause:unknown)=>{throw cause;},requireCoreExperimentContext:()=>context,withCoreExperiments:async(_r:unknown,act:()=>Promise<unknown>)=>act(),lookupCoreExperimentOperation:async()=>null},'./evidence':{readTraceEvidence:async()=>{captures++;return {username:'alice',evidence:structuredClone(source)};}},'@/lib/storage/data-service':{...service,readConfig:async()=>structuredClone(configs),extractInvokedSkillsFromSessionInteractions:()=>[{name:'actual',version:actualVersion}]},'@/lib/storage/prisma':{db:{findSkill:async()=>({id:'skill-id',name:'actual',versions:[{version:9,content:'Latest definition as evaluation context'}]})},prismaRaw:{skill:{findFirst:async()=>({id:'skill-id'})}}},'@/lib/storage/server-config':{getActiveConfig:async()=>null},'./frozen-model':{freezeModelSelection:()=>null},'@/lib/engine/evaluation/judge':{normalizeInteractions:(x:unknown)=>x,judgeAnswer:async()=>({score:0,is_correct:false,reason:'actual zero'}),analyzeFailures:async()=>({failures:[],skill_issues:[]})},'@/lib/evaluator-agent':{isEvaluatorTraceRecord:()=>false},'./flow-model-delivery':{withCoreFlowModelDelivery:async(_c:unknown,_w:unknown,act:()=>Promise<unknown>)=>act()},'./experiment-worker':{activateExperimentWork:async()=>{
  const work={...frozen(),frozen_trace_evidence:source,runplan:{config:{core_outcome:manifest}}} as unknown as FrozenExperimentWork;
  resultValue=(await api.computeFrozenCoreOutcomeWork(work,{user:'alice',signal:new AbortController().signal})).evidence.json.coreOutcome as unknown as Row;
 }},'./server':{requestCore:async()=>({data:{value:[{task_id:'task',upload_id:'execution',query:'Question',skill:undefined,skills:[],skill_version:null}]}})}});
 const response=await api.handleCoreOutcomeRejudge(context.request);assert.equal(response.status,200);const body=await response.json();assert.deepEqual(body.record.skills,['actual']);assert.deepEqual(body.record.invokedSkills,[{name:'actual',version:2}]);assert.equal(body.record.skill,'actual');assert.equal(body.record.skill_version,2);assert.deepEqual(body.record.rootSkill,{name:'actual',version:2});
 const expected=await service.buildRecordEvaluationSnapshots({query:'Question',skill:'actual',skill_version:2,skills:['actual'],invokedSkills:[{name:'actual',version:2}],answer_score:0,is_answer_correct:false,judgment_reason:'actual zero'},configs,'alice');
 assert.deepEqual(body.record.routing_evaluation,JSON.parse(JSON.stringify(expected.routing_evaluation)));assert.deepEqual(body.record.outcome_evaluation,JSON.parse(JSON.stringify(expected.outcome_evaluation)));assert.equal(body.record.is_skill_correct,expected.routing_evaluation?.is_correct);assert.equal(captures,1);assert.equal('skill'in source.execution,false);
 resultValue={};actualVersion=null;const unknown=await api.handleCoreOutcomeRejudge(context.request);assert.equal(unknown.status,200);const unknownBody=await unknown.json();assert.equal(unknownBody.record.skill_version,null);assert.equal(unknownBody.record.invokedSkills[0].version,null);assert.equal(unknownBody.record.rootSkill.version,null);
 resultValue={};actualVersion=2;(source.execution as Row).skillVersion=1;const existing=await api.handleCoreOutcomeRejudge(context.request);assert.equal(existing.status,200);const existingBody=await existing.json();assert.equal(existingBody.record.skill_version,1);assert.equal(existingBody.record.invokedSkills[0].version,2);assert.equal(existingBody.record.rootSkill.version,1);
});

test('a queued Outcome with a frozen null model never consults the model added after scheduling',async()=>{
 const frozenModel=await import('../src/lib/storage-core/frozen-model');let latest=0,modelCalls=0;
 const added={id:'new-model',name:'added later',model:'latest',provider:'test',apiKey:'new-key',baseUrl:'http://late-model'};
 const settings=load<typeof import('../src/lib/storage/server-config')>('src/lib/storage/server-config.ts',{'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>false},'@/lib/storage-core/frozen-model':frozenModel,'@/lib/storage/prisma':{db:{findUserSettings:async()=>{latest++;return {settingsJson:JSON.stringify({activeConfigId:added.id,configs:[added]})};}}},'@/lib/shared/default-model-config':{loadDefaultModelConfigs:()=>{latest++;return [added];}},'@/lib/shared/model-connection':{resolveModelConnection:(x:unknown)=>x},'@/lib/engine/experiment/runtime-parameter-templates':{readRuntimeParameterTemplates:()=>[]}});
 class Model{constructor(){modelCalls++;throw Error('Frozen null model cannot become the new model');}}
 const judge=load('src/lib/engine/evaluation/judge.ts',{'openai':{OpenAI:Model},'@/lib/engine/general-agent/trusted-context':{getTrustedCoreAgentContext:()=>undefined},'@/lib/storage/server-config':{getActiveConfig:settings.getActiveConfig},'@/lib/env':{resolveAgentInsightDataPath:()=>'/tmp/unused-frozen-null-judge'},'@/lib/logger/server':{isLogEnabled:()=>false}});
 const runtime=load<typeof import('../src/lib/storage-core/experiments')>('src/lib/storage-core/experiments.ts',{'node:async_hooks':{AsyncLocalStorage},'./datasets':{runWithCoreDatasetActor:async(_actor:unknown,_request:unknown,act:()=>Promise<unknown>)=>act()},'./evaluators':{runWithCoreEvaluatorActor:async(_actor:unknown,act:()=>Promise<unknown>)=>act()},'./frozen-model':frozenModel});
 const context={actor:{username:'alice',principal:'alice',workspace:'w',token:'token'},request:new Request('http://localhost/work'),options:{},body:{},operationKey:'work',rpc:async()=>null};
 const current=await settings.getActiveConfig('alice');assert.equal(current?.model,'latest');assert.ok(latest>0);latest=0;
 const judgment=await runtime.prepareCoreExperimentRuntime(context,{handle:{run_id:'run',attempt_id:'attempt'},runplan:{config:{model_selection:null}}},()=>judge.judgeAnswer('Question',{root_causes:[{content:'Real criterion',weight:1}]},'Answer','alice'));
 assert.equal(judgment.score,0);assert.equal(judgment.reason,'请在首页左上角的设置中配置 LLM');assert.equal(latest,0);assert.equal(modelCalls,0);
});

test('Final Result edits retain existing raw Skill associations and primary version instead of replacing them with evaluation context',async()=>{
 const service=await import('../src/lib/storage/data-service'),projection=await import('../src/lib/storage-core/trace-outcome-projection');
 const configs=[{id:'routing',query:'Question',dataset_type:'routing' as const,skill:'s',expectedSkills:[{skill:'s',version:null}],routing_intent:'Question',routing_anchors:['Question'],standard_answer:''},{id:'outcome',query:'Question',dataset_type:'outcome' as const,skill:'s',standard_answer:'Expected'}];
 const cases=[{skills:['s'],invokedSkills:'[]',skillVersion:null},{skills:['s','aux'],invokedSkills:'[{"name":"s","version":2}]',skill:'s',skillVersion:1}];
 for(const fields of cases){
  let captured:Row={},extracted=0;
  const source={snapshot_hash:'a'.repeat(64),manifest:{trace_id:'trace'},execution:{id:'execution',taskId:'task',query:'Question',finalResult:'old',framework:'test',...fields},session:{interactions:[{role:'assistant',content:'Other Skill in Session'}]}};
  const context={actor:{username:'alice',principal:'p',workspace:'w'},request:new Request('http://localhost/edit',{method:'PATCH',body:'{}'}),body:{task_id:'task',final_result:'edited'},options:{},rpc:async(action:string,payload:Row)=>{
   if(action==='outcome_lookup')return {outcome:null,selection_hash:'none'};
   if(action==='flow_lookup')return {match:null,attribution:null};
   if(action==='outcome_begin'){captured=(payload.config as Row).core_outcome as Row;return {experiment_id:'exp',run_id:'run',result_id:'slot',trace_id:'trace',execution_id:'execution',task_id:'task'};}
   if(action==='check_work')return {active:true};throw Error(action);
  }};
  const api=load('src/lib/storage-core/trace-outcome.ts',{'./trace-outcome-projection':projection,'./experiments':{requireCoreExperimentContext:()=>context,withCoreExperiments:async(_r:unknown,act:()=>Promise<unknown>)=>act(),lookupCoreExperimentOperation:async()=>null,coreExperimentFailure:(cause:unknown)=>{throw cause;}},'./evidence':{readTraceOutcomeEvidence:async()=>({username:'alice',evidence:structuredClone(source)})},'@/lib/storage/data-service':{...service,readConfig:async()=>structuredClone(configs),fillConfigKeyActionsFromParsedFlows:async()=>{},extractInvokedSkillsFromSessionInteractions:()=>{extracted++;return [{name:'other',version:9}];}},'@/lib/storage/prisma':{db:{findSkill:async()=>({id:'skill-id',name:'s',versions:[{version:9,content:'context definition'}]})},prismaRaw:{skill:{findFirst:async()=>({id:'skill-id'})}}},'@/lib/storage/server-config':{getActiveConfig:async()=>null},'./frozen-model':{freezeModelSelection:()=>null},'./experiment-worker':{activateExperimentWork:async()=>{}},'./flow-model-delivery':{withCoreFlowModelDelivery:async(_c:unknown,_w:unknown,act:()=>Promise<unknown>)=>act()},'@/lib/engine/evaluation/judge':{normalizeInteractions:(x:unknown)=>x,judgeAnswer:async()=>({score:0,is_correct:false,reason:'real zero'})}});
  const response=await api.handleCoreFinalResultEdit(context.request);assert.equal(response.status,200);const frozenProjection=captured.record_projection as Row;
  assert.deepEqual(Array.from(frozenProjection.skills as string[]),fields.skills);assert.deepEqual(JSON.parse(JSON.stringify(frozenProjection.invokedSkills)),JSON.parse(fields.invokedSkills));assert.equal(frozenProjection.skill,fields.skill);assert.equal(frozenProjection.skill_version,fields.skillVersion);assert.equal(extracted,0);
  const work={...frozen('edited-final-result'),runplan:{config:{core_outcome:captured}},frozen_trace_evidence:{...source,execution:{...source.execution,finalResult:'edited'}}} as unknown as FrozenExperimentWork;
  const value=(await api.computeFrozenCoreOutcomeWork(work,{user:'alice',signal:new AbortController().signal})).evidence.json.coreOutcome;
  const expected=await service.buildRecordEvaluationSnapshots({query:'Question',skill:fields.skill,skill_version:fields.skillVersion,skills:fields.skills,invokedSkills:JSON.parse(fields.invokedSkills),answer_score:0,is_answer_correct:false,judgment_reason:'real zero'},configs,'alice');
  assert.deepEqual(JSON.parse(JSON.stringify(value.record_projection?.routing_evaluation)),JSON.parse(JSON.stringify(expected.routing_evaluation)));assert.deepEqual(JSON.parse(JSON.stringify(value.record_projection?.outcome_evaluation)),JSON.parse(JSON.stringify(expected.outcome_evaluation)));
 }
});

test('query answer reset preserves true Skill and failure metadata while using the new query snapshot template',async()=>{
 const {overlayCoreOutcome}=await import('../src/lib/storage-core/trace-outcome-projection');
 const service=await import('../src/lib/storage/data-service');
 const configs=[{id:'new',query:'new question',dataset_type:'outcome' as const,skill:'actual',standard_answer:'new answer'}];
 const base=await service.buildRecordEvaluationSnapshots({query:'new question',skill:'actual',skill_version:2,skills:['actual'],invokedSkills:[{name:'actual',version:2}],answer_score:null,is_answer_correct:false,judgment_reason:'结果评估中...'},configs,'alice');
 const older={...base,skills:['actual'],invokedSkills:[{name:'actual',version:2}],skill:'actual',skill_version:2,is_skill_correct:false,skill_trigger_rate:null,routing_evaluation:base.routing_evaluation!,outcome_evaluation:{...base.outcome_evaluation!,matched_config_id:'old',status:'available' as const,score:1,is_correct:true,reason:'old reason'}};
 const selected={experiment_id:'exp',run_id:'run',selection_hash:'hash',is_evaluating:false,answer_reset:{version:1 as const,through_generation:1,annotation_revision:'1',content_hash:'a'.repeat(64)},outcome:{experiment_id:'exp',run_id:'run',machine_result_id:'machine',content_hash:'b'.repeat(64),generation:1,value:{version:1 as const,source_snapshot_hash:'c'.repeat(64),answer_score:1,is_answer_correct:true,judgment_reason:'old reason',failures:[{reason:'actual failure'}],skill_issues:[],record_projection:older}}};
 const record=overlayCoreOutcome(base,selected);assert.equal(record.answer_score,null);assert.equal(record.is_answer_correct,false);assert.equal(record.judgment_reason,'结果评估中...');assert.equal(record.is_evaluating,false);assert.equal(record.outcome_evaluation?.matched_config_id,'new');assert.equal(record.outcome_evaluation?.status,'pending');assert.equal(record.outcome_evaluation?.score,null);assert.deepEqual(record.failures,[{reason:'actual failure'}]);assert.deepEqual(record.invokedSkills,[{name:'actual',version:2}]);
});

test('query PATCH selects the private query handoff before the lower priority Final Result branch',async()=>{
 let calls=0;
 const api=load<typeof import('../src/lib/storage-core/compat')>('src/lib/storage-core/compat.ts',{'./server':{readCoreBytes:async(body:ReadableStream<Uint8Array>)=>new Uint8Array(await new Response(body).arrayBuffer())},'./trace-outcome':{handleCoreQueryEdit:async(request:Request)=>{calls++;assert.equal((await request.json()).query,' new question ');return Response.json({success:true,message:'Query 已更新'});},handleCoreFinalResultEdit:()=>{throw Error('Query priority cannot schedule a Final Result model');}}});
 const response=await api.handleCompatibleObserveData(new Request('http://localhost/api/observe/data',{method:'PATCH',body:JSON.stringify({task_id:'task',currentUser:'forged',query:' new question ',final_result:'ignored lower priority'})}));assert.equal(response.status,200);assert.equal(calls,1);
});

test('rejudge and Final Result edits keep routing scalar unknown when no Skill was called while snapshot coverage is zero',async()=>{
 const service=await import('../src/lib/storage/data-service');
 const configs=[{id:'routing',query:'Question',dataset_type:'routing' as const,skill:'expected',expectedSkills:[{skill:'expected',version:null}],routing_intent:'Question',routing_anchors:['Question'],standard_answer:''},{id:'outcome',query:'Question',dataset_type:'outcome' as const,skill:'expected',standard_answer:'Expected'}];
 for(const mode of ['rejudge','edited-final-result']){
  let captured:Row={};const stop=Error('captured before mutation');
  const context={actor:{username:'alice'},request:new Request('http://localhost/edit',{method:'PATCH',body:'{}'}),body:{task_id:'task',currentUser:'ignored',final_result:'edited'},options:{},rpc:async(action:string,payload:Row)=>{
   if(action==='outcome_lookup')return {outcome:null,selection_hash:'none'};
   if(action==='flow_lookup')return {match:null,attribution:null};
   if(action==='outcome_begin'){captured=(payload.config as Row).core_outcome as Row;throw stop;}throw Error(action);
  }};
  const read=async()=>({username:'alice',evidence:{snapshot_hash:'a'.repeat(64),manifest:{trace_id:'trace'},execution:{id:'execution',taskId:'task',query:'Question',finalResult:'old',framework:'test',skills:[],invokedSkills:'[]'},session:{interactions:[]}}});
  const api=load('src/lib/storage-core/trace-outcome.ts',{'./experiments':{requireCoreExperimentContext:()=>context,withCoreExperiments:async(_r:unknown,act:()=>Promise<unknown>)=>act(),lookupCoreExperimentOperation:async()=>null,coreExperimentFailure:(cause:unknown)=>{throw cause;}},'./evidence':{readTraceOutcomeEvidence:read,readTraceEvidence:read},'@/lib/storage/data-service':{...service,readConfig:async()=>structuredClone(configs),fillConfigKeyActionsFromParsedFlows:async()=>{},extractInvokedSkillsFromSessionInteractions:()=>[]},'@/lib/storage/prisma':{db:{findSkill:async()=>null}},'@/lib/storage/server-config':{getActiveConfig:async()=>null},'./frozen-model':{freezeModelSelection:()=>null},'@/lib/engine/evaluation/judge':{normalizeInteractions:(x:unknown)=>x}});
  await assert.rejects(mode==='rejudge'?api.handleCoreOutcomeRejudge(context.request):api.handleCoreFinalResultEdit(context.request),error=>error===stop);
  const projection=captured.record_projection as Row;assert.equal(projection.is_skill_correct,false);assert.equal(projection.skill_trigger_rate,null);assert.equal((projection.routing_evaluation as Row).trigger_rate,0);
 }
});

test('query handoff seals new routing scalar and snapshots once and exact response-loss retry does not reload changed Config',async()=>{
 const service=await import('../src/lib/storage/data-service'),project=await import('../src/lib/storage-core/trace-outcome-projection');
 const configs=[{id:'A',query:'old question',dataset_type:'routing' as const,skill:'A',expectedSkills:[{skill:'A',version:null}],routing_intent:'old question',routing_anchors:['old question'],standard_answer:''},{id:'B',query:'new question',dataset_type:'routing' as const,skill:'B',expectedSkills:[{skill:'B',version:null}],routing_intent:'new question',routing_anchors:['new question'],standard_answer:''}];
 const oldRecord={query:'old question',skill:'A',skill_version:1,skills:['A'],invokedSkills:[{name:'A',version:1}],is_skill_correct:true,skill_trigger_rate:1,answer_score:1,is_answer_correct:true};
 let sealed:Row={},receipt:Row|null=null,reads=0,models=0,writes=0;
 const selected=()=>({experiment_id:'exp',run_id:null,selection_hash:writes?'query-selected':'before-query',is_evaluating:false,outcome:null,...(writes?{answer_reset:{version:1,through_generation:0,annotation_revision:'1',content_hash:'a'.repeat(64),query_projection:sealed}}:{})});
 const context={actor:{username:'alice',principal:'alice',workspace:'w'},request:new Request('http://localhost/api/observe/data',{method:'PATCH',body:'{}'}),body:{task_id:'task',currentUser:'forged',query:' new question ',query_projection:{is_skill_correct:true,skill_trigger_rate:1}},options:{},rpc:async(action:string,payload:Row)=>{
  if(action==='outcome_lookup')return selected();
  if(action==='outcome_query'){assert.equal(payload.source_snapshot_hash,'b'.repeat(64));assert.equal(payload.previous_outcome_selection,'before-query');assert.equal(payload.query,'new question');sealed=payload.query_projection as Row;writes++;return receipt={experiment_id:'exp',trace_id:'trace',execution_id:'execution',task_id:'task'};}throw Error(action);
 }};
 const api=load('src/lib/storage-core/trace-outcome.ts',{'./trace-outcome-projection':project,'./experiments':{requireCoreExperimentContext:()=>context,withCoreExperiments:async(_r:unknown,act:()=>Promise<unknown>)=>act(),lookupCoreExperimentOperation:async()=>receipt,coreExperimentFailure:(cause:unknown)=>{throw cause;}},'./evidence':{readTraceOutcomeEvidence:async()=>({username:'alice',evidence:{snapshot_hash:'b'.repeat(64),manifest:{trace_id:'trace'},execution:{id:'execution',taskId:'task',query:'old question',skill:'A',skillVersion:1,skills:'["A"]',invokedSkills:'[{"name":"A","version":1}]'},session:null}})},'@/lib/storage/data-service':{...service,readConfig:async(user:string)=>{assert.equal(user,'alice');reads++;return configs;}},'@/lib/storage/server-config':{getActiveConfig:async()=>{models++;throw Error('Query must never load a model');}},'./server':{requestCore:async()=>({data:{value:[{...oldRecord,task_id:'task',upload_id:'execution',query:'new question'}]}})}});
 const first=await api.handleCoreQueryEdit(context.request);assert.equal(first.status,200);const result=await first.json();assert.equal(result.record.is_skill_correct,false);assert.equal(result.record.skill_trigger_rate,0);assert.equal(result.record.routing_evaluation.matched_config_id,'B');assert.equal(result.record.routing_evaluation.trigger_rate,0);assert.equal(result.record.answer_score,null);assert.equal(result.record.is_evaluating,false);
 configs[1].expectedSkills=[{skill:'A',version:null}];
 const replay=await api.handleCoreQueryEdit(context.request);assert.equal(replay.status,200);const retry=await replay.json();assert.equal(retry.record.skill_trigger_rate,0);assert.equal(retry.record.routing_evaluation.matched_config_id,'B');assert.equal(reads,1);assert.equal(writes,1);assert.equal(models,0);
});

test('private query RPC binds the actual actor, controller proof and unchanged receipt across a lost HTTP response',async()=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'outcome-query-controller-')),file=path.join(dir,'controller');await fs.writeFile(file,'a'.repeat(64),{mode:0o600});
 const previous=process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE;process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=file;
 try{
  process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';const core=await import('../src/lib/storage-core/experiments'),controller=await import('../src/lib/storage-core/controller');
  const token='api_'+'K'.repeat(43),request=new Request('http://localhost/api/observe/data',{method:'PATCH',headers:{authorization:'Bearer '+token,'idempotency-key':'same-query-operation'},body:JSON.stringify({task_id:'task',currentUser:'forged',query:'new question'})});
  let writes=0,firstBody='';
  await core.withCoreExperiments(request,async()=>{await core.requireCoreExperimentContext().rpc('outcome_query',{trace_ref:'task',query:'new question',source_snapshot_hash:'b'.repeat(64),previous_outcome_selection:'c'.repeat(64),query_projection:{is_skill_correct:false}});},{fetcher:async(input,options)=>{
   if(new URL(String(input)).pathname==='/v1/auth/me')return Response.json({principal_id:'actual-owner',username:'alice',workspace_id:'w',workspaces:[{workspace_id:'w'}]});
   const body=String(options?.body),headers=new Headers(options?.headers);assert.equal(headers.get('authorization'),'Bearer '+token);assert.equal(headers.get('x-storage-controller-proof'),controller.signControllerPayload('a'.repeat(64),'experiment-frozen-assets/v1','actual-owner','w',body));
   const value=JSON.parse(body);assert.equal(value.action,'outcome_query');assert.equal(value.operation_key,'same-query-operation');assert.equal(value.operation_request.body.currentUser,'forged');
   writes++;if(writes===1){firstBody=body;throw new TypeError('lost HTTP response after storage commit');}assert.equal(body,firstBody);return Response.json({value:{task_id:'task',execution_id:'execution'}});
  }});assert.equal(writes,2);
 }finally{if(previous===undefined)delete process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE;else process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=previous;await fs.rm(dir,{recursive:true,force:true});}
});

test('public rejudge denies real admin, shared member and read-only owner before reading missing Config or any model',async()=>{
 const {spawn}=await import('node:child_process'),{createInterface}=await import('node:readline');
 const script=String.raw`
import json,signal,sys
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from services.storage.tests.test_trace_outcome import OutcomeTests
from services.storage.iam import Forbidden,Unauthorized
base=OutcomeTests();base.setUp();store=base.prepare()
base.iam.share_resource(base.token,'w','trace','trace','bob')
readonly=base.iam.issue_api_credential(base.token,'w',{'read'})
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def reply(self,status,value):
  body=json.dumps(value).encode();self.send_response(status);self.send_header('content-type','application/json');self.send_header('content-length',str(len(body)));self.end_headers();self.wfile.write(body)
 def token(self):return self.headers.get('authorization','').removeprefix('Bearer ')
 def do_GET(self):
  try:
   scope=base.iam.scope(self.token())
   with base.control.read_transaction() as con:name=con.execute('SELECT normalized_login_name FROM iam_principals WHERE principal_id=?',(scope.principal_id,)).fetchone()[0]
   self.reply(200,{'principal_id':scope.principal_id,'username':name,'workspace_id':'w','workspaces':[{'workspace_id':grant.workspace_id} for grant in scope.grants]})
  except Exception as exc:self.reply(401 if isinstance(exc,Unauthorized) else 403,{'error':type(exc).__name__})
 def do_POST(self):
  try:
   body=json.loads(self.rfile.read(int(self.headers.get('content-length','0'))));value=store.dispatch(body['action'],self.token(),'w',body);self.reply(200,{'value':value})
  except Exception as exc:self.reply(403 if isinstance(exc,Forbidden) else 401 if isinstance(exc,Unauthorized) else getattr(exc,'status',500),{'error':type(exc).__name__})
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
print(json.dumps({'origin':'http://127.0.0.1:'+str(server.server_port),'actors':[{'token':base.admin,'principal':'admin','username':'admin'},{'token':base.bob,'principal':'bob','username':'bob'},{'token':readonly,'principal':'alice','username':'alice'}]}),flush=True)
signal.signal(signal.SIGTERM,lambda *_:sys.exit(0))
try:server.serve_forever()
finally:server.server_close();base.doCleanups()
`;
 const child=spawn(process.env.PYTHON||'python3',['-u','-c',script],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',value=>{errors=(errors+String(value)).slice(-16000);});
 const lines=createInterface({input:child.stdout});const previous=process.env.AGENT_INSIGHT_STORAGE_CORE_URL;
 try{
  const line=await new Promise<string>((resolve,reject)=>{lines.once('line',resolve);child.once('error',reject);child.once('exit',()=>reject(Error('Real IAM fixture did not start: '+errors)));});
  const first=JSON.parse(line) as {origin:string;actors:Array<{token:string;principal:string;username:string}>};
  process.env.AGENT_INSIGHT_STORAGE_CORE_URL=first.origin;
  const core=await import('../src/lib/storage-core/experiments');let configs=0,models=0,evidenceReads=0;
  const evidence=async()=>{evidenceReads++;return {username:core.requireCoreExperimentContext().actor.username,evidence:{manifest:{trace_id:'trace',owner_principal_id:'alice'},snapshot_hash:'a'.repeat(64),execution:{id:'execution',taskId:'task',query:'Question'},session:{interactions:[]}}};};
  const api=load('src/lib/storage-core/trace-outcome.ts',{'./experiments':core,'./evidence':{readTraceEvidence:evidence,readTraceOutcomeEvidence:evidence},'@/lib/storage/data-service':{readConfig:async()=>{configs++;return [];},findBestMatchConfig:()=>undefined,extractInvokedSkillsFromSessionInteractions:()=>[],resolveImmutableSkillVersion:()=>({resolved:null})},'@/lib/storage/server-config':{getActiveConfig:async()=>{models++;return null;}},'@/lib/engine/evaluation/judge':{normalizeInteractions:(value:unknown)=>value}});
  for(const actor of first.actors){
   for(const handler of ['handleCoreOutcomeRejudge','handleCoreFinalResultEdit','handleCoreQueryEdit'] as const){
    const rejudge=handler==='handleCoreOutcomeRejudge';
    const request=new Request(rejudge?'http://localhost/api/eval/rejudge':'http://localhost/api/observe/data',{method:rejudge?'POST':'PATCH',headers:{authorization:'Bearer '+actor.token},body:JSON.stringify({task_id:'task',currentUser:'alice',query:'new question',final_result:'edited'})});
    const response=await api[handler](request);assert.equal(response.status,403,actor.principal+' '+handler);assert.equal(configs,0);assert.equal(models,0);assert.equal(evidenceReads,0);
   }
  }
 }finally{if(previous===undefined)delete process.env.AGENT_INSIGHT_STORAGE_CORE_URL;else process.env.AGENT_INSIGHT_STORAGE_CORE_URL=previous;lines.close();if(child.exitCode===null){const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGTERM');await exited;}}
});

async function recordingActivationCase(options:{recordingStatus:number;slotStatus:string;currentRun?:string;readFailure?:number;slotFailure?:number;checkpointFailure?:boolean;lookupExperiment?:string;lookupSlot?:string}) {
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const trustedContext=await import('../src/lib/engine/general-agent/trusted-context');
 const recorder=await import('../src/lib/engine/evaluation/evaluator-execution-recorder');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'outcome-cancel-fence-'));
 const handle={experiment_id:'exp',run_id:'original-run',work_item_id:'work',attempt_id:randomUUID(),case_id:'case',result_id:'slot',evaluator_id:'__trace_outcome__',fence:'1',lease_owner:'worker',lease_until_ms:Date.now()+30000,checkpoint_revision:'0'};
 const work={handle,raw_case:{id:'case'},experiment_config:{scope:'trace-outcome'},frozen_trace_evidence:null,frozen_evaluator:{card:{}},runplan:{config:{model_selection:{id:'frozen-model'}}},checkpoint:{}} as unknown as FrozenExperimentWork;
 let models=0,recordings=0,revision=0,activationFailure:unknown;let checkpoint:Row={};
 const selected={experiment_id:options.lookupExperiment??'exp',run_id:options.currentRun??'original-run',selection_hash:'current-selection',is_evaluating:['pending','running'].includes(options.slotStatus),outcome:null};
 const context={actor:{username:'alice',principal:'alice',workspace:'w',token:'token'},request:new Request('http://localhost/api/eval/rejudge',{method:'POST',body:'{}'}),body:{task_id:'task',currentUser:'alice'},options:{},operationKey:'original-request',rpc:async(action:string,payload:Row={})=>{
  if(action==='load_work')return work;
  if(action==='checkpoint'){if(options.checkpointFailure)throw Object.assign(Error('Checkpoint delivery is unknown'),{status:503});checkpoint=structuredClone(payload.checkpoint as Row);return {...handle,checkpoint_revision:String(++revision)};}
  if(action==='lookup_operation'&&options.checkpointFailure)return {found:false};
  if(action==='renew')return {...handle,lease_until_ms:Date.now()+30000};
  if(action==='outcome_lookup'){if(options.readFailure)throw Object.assign(Error('Current Trace access rejected'),{status:options.readFailure});return selected;}
  if(action==='result_lookup'){if(options.slotFailure)throw Object.assign(Error('Original slot access rejected'),{status:options.slotFailure});return {experiment_id:'exp',case_id:'case',result_id:options.lookupSlot??'slot',evaluator_id:'__trace_outcome__',status:options.slotStatus};}
  throw Error('Unexpected '+action);
 }};
 const runtime=load<typeof import('../src/lib/storage-core/experiments')>('src/lib/storage-core/experiments.ts',{'node:async_hooks':{AsyncLocalStorage},'./datasets':{runWithCoreDatasetActor:async(_a:unknown,_r:unknown,action:()=>Promise<unknown>)=>action()},'./evaluators':{runWithCoreEvaluatorActor:async(_a:unknown,action:()=>Promise<unknown>)=>action()},'./frozen-model':{matchesFrozenModelSelection:()=>true,runWithFrozenModelConfiguration:(_u:unknown,_m:unknown,action:()=>Promise<unknown>)=>action()},'@/lib/storage/server-config':{getUserSettings:async()=>({configs:[{id:'frozen-model'}]})},'@/lib/env':{resolveAgentInsightHomePath:(...parts:string[])=>path.join(directory,...parts)},'node:fs/promises':fs,'@/lib/engine/general-agent/trusted-context':trustedContext,'@/lib/engine/general-agent/runner':{resolveGeneralAgentModel:async()=>({modelID:'mock-model',apiKey:'fake-key',baseURL:'http://unused-model'})},'./server':{requestCore:async(endpoint:string,payload:{body:string})=>{
  assert.ok(endpoint.startsWith('/v1/compat/observe/agent-traces?'));const body=JSON.parse(payload.body);assert.equal(body.context.experiment_attempt_id,handle.attempt_id);assert.equal(body.context.experiment_fence,handle.fence);recordings++;throw Object.assign(Error('Recording boundary rejected this attempt'),{status:options.recordingStatus});
 }}});
 const delivery=load<typeof import('../src/lib/storage-core/flow-model-delivery')>('src/lib/storage-core/flow-model-delivery.ts',{'node:async_hooks':{AsyncLocalStorage},'node:crypto':{createHash:(await import('node:crypto')).createHash}});
 class Model {apiKey='fake-key';chat={completions:{create:async()=>{models++;return {choices:[{message:{content:'{"evaluations":[{"id":"RC-0","match_score":0,"explanation":"real response"}]}'}}]};}}};}
 const judge=load('src/lib/engine/evaluation/judge.ts',{'node:crypto':{randomUUID},'openai':{OpenAI:Model},'@/lib/engine/general-agent/trusted-context':trustedContext,'@/lib/engine/evaluation/evaluator-execution-recorder':recorder,'@/lib/storage-core/flow-model-delivery':delivery,'@/lib/server/model-fetch':{getModelFetch:()=>undefined},'@/lib/env':{resolveAgentInsightDataPath:()=>path.join(directory,'unused-debug.jsonl')},'@/lib/logger/server':{isLogEnabled:()=>false},'@/prompts/judge-prompt':{generateJudgePrompt:()=> 'Frozen judgment'}});
 const worker=load<typeof import('../src/lib/storage-core/experiment-worker')>('src/lib/storage-core/experiment-worker.ts',{'./experiments':runtime,'@/lib/engine/experiment/run-experiment':{evaluateFrozenExperimentWork:async()=>delivery.withCoreFlowModelDelivery(context,work,()=>judge.judgeAnswer('Question',{root_causes:[{content:'cause',weight:1}]},'Answer','alice'))},'./execution-delivery':{isCoreDeliveryUncertain:(error:unknown)=>(error as {coreDeliveryUncertain?:boolean})?.coreDeliveryUncertain===true},'./experiment-skill-derived':{attachExperimentSkillDerived:()=>{throw Error('A rejected recording cannot complete scoring');}}});
 const api=load('src/lib/storage-core/trace-outcome.ts',{'./experiments':{requireCoreExperimentContext:()=>context,withCoreExperiments:async(_r:unknown,action:()=>Promise<unknown>)=>action(),lookupCoreExperimentOperation:async()=>({experiment_id:'exp',run_id:'original-run',result_id:'slot',trace_id:'trace',execution_id:'execution',task_id:'task'}),coreExperimentFailure:runtime.coreExperimentFailure},'./experiment-worker':{activateExperimentWork:async()=>{try{await worker.runCoreExperimentWork(handle,context);}catch(error){activationFailure=error;throw error;}}}});
 try{
  const response=await api.handleCoreOutcomeRejudge(context.request);return {response,body:await response.json(),models,recordings,checkpoint,activationFailure};
 }finally{await fs.rm(directory,{recursive:true,force:true});}
}

test('late fenced recording preserves the original cancelled DTO only after the same Outcome run was durably cancelled',async()=>{
 const result=await recordingActivationCase({recordingStatus:409,slotStatus:'cancelled'});
 assert.equal(result.response.status,200);assert.deepEqual(result.body,{success:false,cancelled:true,message:'Evaluation cancelled'});assert.equal(result.models,1);assert.equal(result.recordings,1);assert.equal((result.activationFailure as Row).coreTraceRecordingStatus,409);assert.equal((result.checkpoint._flow_model_calls as Row)['0']&&((result.checkpoint._flow_model_calls as Row)['0'] as Row).state,'intent');
});

test('a fenced recording from a durably superseded Outcome run returns the original cancellation DTO',async()=>{
 const result=await recordingActivationCase({recordingStatus:410,slotStatus:'pending',currentRun:'replacement-run'});
 assert.equal(result.response.status,200);assert.equal(result.body.cancelled,true);assert.equal(result.models,1);assert.equal(result.recordings,1);
});

test('real recording failures and delivery uncertainty are never converted into cancellation without the matching fence and durable state',async()=>{
 for(const [recordingStatus,slotStatus,currentRun] of [[503,'cancelled','original-run'],[503,'pending','replacement-run'],[413,'cancelled','original-run'],[401,'cancelled','original-run'],[403,'cancelled','original-run'],[409,'pending','original-run'],[409,'done','original-run'],[409,'failed','original-run']] as const){
  const result=await recordingActivationCase({recordingStatus,slotStatus,currentRun});assert.equal(result.response.status,503);assert.equal(result.body.cancelled,undefined);assert.equal((result.activationFailure as Row).coreDeliveryUncertain,true);assert.equal(result.models,1);assert.equal(result.recordings,1);
 }
});

test('cancel reconciliation preserves current Trace and original slot authorization failures',async()=>{
 for(const status of [401,403]){
  const denied=await recordingActivationCase({recordingStatus:409,slotStatus:'cancelled',readFailure:status});assert.equal(denied.response.status,status);assert.equal(denied.body.cancelled,undefined);
  const missing=await recordingActivationCase({recordingStatus:409,slotStatus:'cancelled',slotFailure:status});assert.equal(missing.response.status,status);assert.equal(missing.body.cancelled,undefined);
 }
});

test('an uncertain checkpoint and mismatched durable identities cannot masquerade as Outcome cancellation',async()=>{
 const pending=await recordingActivationCase({recordingStatus:409,slotStatus:'cancelled',checkpointFailure:true});assert.equal(pending.response.status,503);assert.equal(pending.body.cancelled,undefined);assert.equal(pending.models,0);assert.equal(pending.recordings,0);assert.equal((pending.activationFailure as Row).coreTraceRecordingStatus,undefined);
 for(const identity of [{lookupExperiment:'another-experiment'},{lookupSlot:'another-slot'}]){
  const result=await recordingActivationCase({recordingStatus:409,slotStatus:'cancelled',...identity});assert.equal(result.response.status,503);assert.equal(result.body.cancelled,undefined);
 }
});

test('uncertain completion replay conflicts stay uncertain even when the Outcome was durably cancelled',async()=>{
 const {submitCoreOperationReceipt}=await import('../src/lib/storage-core/execution-delivery');
 const core=await import('../src/lib/storage-core/experiments');
 for(const status of [409,410]){
  let writes=0;
  const context={actor:{username:'alice',principal:'alice',workspace:'w',token:'token'},request:new Request('http://localhost/rejudge',{method:'POST',body:'{}'}),body:{task_id:'task',currentUser:'alice'},options:{},operationKey:'key',rpc:async(action:string)=>{
   if(action==='lookup_operation')return {found:false};
   if(action==='complete'){writes++;throw Object.assign(Error('Completion delivery was not confirmed'),{status:writes===1?503:status});}
   if(action==='outcome_lookup')return {experiment_id:'exp',run_id:'run',selection_hash:'current',is_evaluating:false,outcome:null};
   if(action==='result_lookup')return {experiment_id:'exp',result_id:'slot',evaluator_id:'__trace_outcome__',status:'cancelled'};
   throw Error(action);
  }};
  let uncertain:unknown;
  try{await submitCoreOperationReceipt(context,'complete',{},'completion');}catch(error){uncertain=error;}
  assert.equal((uncertain as Row).status,status);assert.equal((uncertain as Row).coreDeliveryUncertain,true);assert.equal((uncertain as Row).coreTraceRecordingStatus,undefined);
  const api=load('src/lib/storage-core/trace-outcome.ts',{'./experiments':{requireCoreExperimentContext:()=>context,withCoreExperiments:async(_request:unknown,action:()=>Promise<unknown>)=>action(),lookupCoreExperimentOperation:async()=>({experiment_id:'exp',run_id:'run',result_id:'slot',trace_id:'trace',execution_id:'execution',task_id:'task'}),coreExperimentFailure:core.coreExperimentFailure},'./experiment-worker':{activateExperimentWork:async()=>{throw uncertain;}}});
  const response=await api.handleCoreOutcomeRejudge(context.request);assert.equal(response.status,status);assert.equal((await response.json()).cancelled,undefined);
 }
});
