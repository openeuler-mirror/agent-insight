import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as delivery from '../src/lib/storage-core/execution-delivery';
import * as skillDerived from '../src/lib/storage-core/experiment-skill-derived';

const handle={experiment_id:'exp',run_id:'run',attempt_id:'attempt',work_item_id:'work',case_id:'case',case_key:'case',result_id:'slot',evaluator_id:'preset-fixture',evaluator_slot:'preset-fixture',fence:'2',lease_owner:'worker',lease_until_ms:Date.now()+30000,checkpoint_revision:'1',plan_hash:'a'.repeat(64)};
function work(){return {handle:{...handle},raw_case:{id:'case',input:'frozen input',datasetInput:'frozen dataset',actualOutput:'frozen answer',referenceOutput:'gold',executionId:'execution',taskId:'task',evaluatorContextJson:null,caseValuesJson:null as string|null},experiment_config:{id:'exp',skillName:'',evaluatorConfigsJson:'{}',configSnapshotJson:'{}'},frozen_trace_evidence:{format:'agent-insight.trace-evidence',version:1,snapshot_hash:'b'.repeat(64),manifest:{trace_id:'trace'},execution:{id:'execution',taskId:'task',query:'source query',finalResult:'source answer'},session:{taskId:'task',interactions:[{role:'assistant',content:'body',opaque:{kept:true},tool_calls:[{function:{name:'bash'},output:'real result'}]}]}},frozen_evaluator:{evaluator_id:'preset-fixture',card:{id:'preset-fixture',evaluatorType:'LLM'}},runplan:{}};}
function load(filename:string,dependencies:Record<string,unknown>,globals:Record<string,unknown>={}){
 const loaded={exports:{}};const js=ts.transpileModule(readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(js,{module:loaded,exports:loaded.exports,require:(id:string)=>id==='./execution-delivery'?delivery:id==='./experiment-skill-derived'?skillDerived:dependencies[id]??{},console,setTimeout,clearTimeout,setInterval,clearInterval,setImmediate,AbortController,AbortSignal,structuredClone,Buffer,URL,Error,...globals});return loaded.exports as Record<string,Function>;
}
function grading(overrides:Record<string,unknown>={}){
 let captured:Record<string,unknown>|undefined;let sql=0;
 const forbidden=new Proxy({},{get(){sql++;throw new Error('Legacy ORM access is forbidden');}});
 const api=load('src/lib/engine/experiment/run-experiment.ts',{
  '@/lib/storage/prisma':{prisma:forbidden},
  '@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},
  './similarity-preset-evaluators':{isSimilarityPresetId:(id:string)=>id==='preset-fixture',runSimilarityPreset:async(_id:string,_user:string,ctx:Record<string,unknown>)=>{captured=ctx;return {score:73.5,verdict:'warn',summary:'real preset result',evidence:{json:{opaque:true}}};}},
  '@/lib/evaluators/evaluator-case-context':{normalizeEvaluatorCaseContext:()=>null},
  '@/lib/engine/experiment/case-fi-meta':{parseExperimentCaseEvaluatorContext:()=>({context:null,error:null}),resolveCaseFaultInjectionType:()=>null},
  './dataset-root-cause-context':{frozenExperimentRootCauseResolutionContext:()=>({})},
  './evaluator-execution-policy':{withEvaluatorExecution:async(_config:unknown,_signal:AbortSignal,fn:()=>Promise<unknown>)=>fn(),runConfiguredEvaluationStage:async(fn:()=>Promise<unknown>)=>fn()},
  './evaluation-attempt':{withEvaluationAttempt:async(_timeout:unknown,_signal:unknown,fn:()=>Promise<unknown>)=>fn(),isRetryableEvaluationFailure:()=>false},
  '@/lib/evaluators/evaluator-run-config':{parseStoredEvaluatorRunConfigs:()=>({}),evaluatorRunConfigOf:()=>({}),isConfigurableTextEvaluatorId:()=>false},
  '@/lib/evaluators/evaluator-execution-config':{parseStoredEvaluatorExecutionConfig:()=>null},
  '@/lib/evaluators/evaluator-skill-service':{resolveFrozenCustomEvaluator:()=>{throw new Error('Missing frozen custom card');}},
  ...Object.fromEntries(['./agent-trajectory-preset-evaluators','./faithful-preset-evaluators','./result-preset-evaluators','./text-preset-evaluators','./content-preset-evaluators','./creativity-preset-evaluators','./safety-preset-evaluators','./depth-preset-evaluators','./rigor-preset-evaluators','./agent-tool-preset-evaluators','./ras-reliability-evaluator','./task-completion-preset-evaluators','./fluency-preset-evaluators','./hallucination-preset-evaluators','@/lib/skill-workbench/trigger-evaluator'].map(id=>[id,new Proxy({},{get:()=>()=>false})])),
  ...overrides,
 });return {api,get captured(){return captured;},get sql(){return sql;}};
}

test('frozen scoring reuses preset output and full interactions without any Experiment ORM',async()=>{
 const fixture=grading();assert.equal(typeof fixture.api.evaluateFrozenExperimentWork,'function');
 const result=await fixture.api.evaluateFrozenExperimentWork(work(),{user:'alice',signal:new AbortController().signal});
 assert.equal(result.score,73.5);assert.equal(result.verdict,'warn');assert.equal(fixture.sql,0);
 assert.equal(fixture.captured?.caseInput,'frozen input');assert.equal(fixture.captured?.actualOutput,'frozen answer');
 assert.deepEqual(JSON.parse(JSON.stringify(fixture.captured?.interactions)),work().frozen_trace_evidence.session.interactions);
});

test('missing frozen evidence or evaluator fails explicitly without latest or empty fallback',async()=>{
 const fixture=grading();assert.equal(typeof fixture.api.evaluateFrozenExperimentWork,'function');
 for(const missing of ['frozen_trace_evidence','frozen_evaluator']){
  const input:Record<string,unknown>=work();input[missing]=null;
  await assert.rejects(fixture.api.evaluateFrozenExperimentWork(input,{user:'alice',signal:new AbortController().signal}),error=>!!error&&typeof error==='object'&&'status'in error&&error.status===503);
 }
 assert.equal(fixture.sql,0);
});

test('worker submits stable operation identity and the exact fenced handle',async()=>{
 const calls:Array<{action:string;payload:Record<string,unknown>}>=[];
 const ctx={actor:{token:'private-token',workspace:'w',principal:'alice',username:'alice'},operationKey:'http-start',body:{},request:new Request('http://localhost'),options:{},rpc:async(action:string,payload:Record<string,unknown>)=>{calls.push({action,payload});if(action==='load_work')return work();return {status:'done'};}};
 const api=load('src/lib/storage-core/experiment-worker.ts',{
  './experiments':{runWithCoreExperimentContext:async(_ctx:unknown,fn:()=>Promise<unknown>)=>fn(),prepareCoreExperimentRuntime:async(_ctx:unknown,_work:unknown,fn:()=>Promise<unknown>)=>fn()},
  '@/lib/engine/experiment/run-experiment':{evaluateFrozenExperimentWork:async()=>({score:0,summary:'zero is a real score',evidence:{json:{kept:1}}})},
  'node:crypto':{randomUUID:()=> 'receipt'},
 });
 assert.equal(typeof api.runCoreExperimentWork,'function');await api.runCoreExperimentWork(handle,ctx);
 const completed=calls.find(call=>call.action==='complete');assert.ok(completed);assert.equal(completed.payload.fence,'2');assert.equal(completed.payload.attempt_id,'attempt');
 assert.notEqual(completed.payload.operation_key,ctx.operationKey);assert.equal((completed.payload.result as {score:number}).score,0);assert.ok(!JSON.stringify(completed.payload).includes(ctx.actor.token));
});

test('lease loss aborts grading and never submits stale complete or fail',async()=>{
 const calls:string[]=[];let tick:(()=>void)|undefined;let sawAbort=false;
 const ctx={actor:{username:'alice'},rpc:async(action:string)=>{calls.push(action);if(action==='load_work')return work();if(action==='renew')throw Object.assign(new Error('fence expired'),{status:409});return {};}};
 const api=load('src/lib/storage-core/experiment-worker.ts',{
  './experiments':{runWithCoreExperimentContext:async(_ctx:unknown,fn:()=>Promise<unknown>)=>fn(),prepareCoreExperimentRuntime:async(_ctx:unknown,_work:unknown,fn:()=>Promise<unknown>)=>fn()},
  '@/lib/engine/experiment/run-experiment':{evaluateFrozenExperimentWork:async(_work:unknown,{signal}:{signal:AbortSignal})=>{tick!();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{sawAbort=true;resolve();},{once:true}));return {score:100};}},
 },{setInterval:(fn:()=>void)=>{tick=fn;return 1;},clearInterval:()=>{}});
 assert.equal(await api.runCoreExperimentWork(handle,ctx),'failed');assert.equal(sawAbort,true);assert.deepEqual(calls,['load_work','renew']);
});

test('grading errors write failure with semantic identity and preserved code',async()=>{
 const calls:Array<{action:string;payload:Record<string,unknown>}>=[];
 const ctx={actor:{username:'alice'},rpc:async(action:string,payload:Record<string,unknown>)=>{calls.push({action,payload});return action==='load_work'?work():{};}};
 const api=load('src/lib/storage-core/experiment-worker.ts',{
  './experiments':{runWithCoreExperimentContext:async(_ctx:unknown,fn:()=>Promise<unknown>)=>fn(),prepareCoreExperimentRuntime:async(_ctx:unknown,_work:unknown,fn:()=>Promise<unknown>)=>fn()},
  '@/lib/engine/experiment/run-experiment':{evaluateFrozenExperimentWork:async()=>{throw Object.assign(new Error('bad frozen config'),{code:'INVALID_CONFIG'});}},
 });
 assert.equal(await api.runCoreExperimentWork(handle,ctx),'failed');const failed=calls.find(c=>c.action==='fail')!;
 assert.ok(failed.payload.operation_key);assert.equal((failed.payload.error as {code:string}).code,'INVALID_CONFIG');
 assert.deepEqual(JSON.parse(JSON.stringify(failed.payload.operation_request)),JSON.parse(JSON.stringify({...handle,error:{message:'bad frozen config',code:'INVALID_CONFIG'}})));
});

test('concurrent activation shares scheduling and scores each claimed item once',async()=>{
 let claims=0;let graded=0;let reconciles=0;
 const ctx={actor:{username:'alice',workspace:'w',principal:'alice'},rpc:async(action:string)=>{
  if(action==='claim')return ++claims<=7?{...handle,attempt_id:`a${claims}`,result_id:`r${claims}`}:null;
  if(action==='load_work')return work();if(action==='reconcile')reconciles++;return {};
 }};
 const api=load('src/lib/storage-core/experiment-worker.ts',{
  './experiments':{runWithCoreExperimentContext:async(_ctx:unknown,fn:()=>Promise<unknown>)=>fn(),prepareCoreExperimentRuntime:async(_ctx:unknown,_work:unknown,fn:()=>Promise<unknown>)=>fn()},
  '@/lib/engine/experiment/run-experiment':{evaluateFrozenExperimentWork:async()=>{graded++;return {score:50};}},
  'node:crypto':{randomUUID:()=> 'worker'},
 });
 const first=api.activateExperimentWork(ctx,'exp');const second=api.activateExperimentWork(ctx,'exp');assert.equal(first,second);await first;
 assert.equal(graded,7);assert.equal(reconciles,1);assert.equal(claims,11);
});

test('text-only Cases score frozen text without requiring a Trace',async()=>{
 const fixture=grading();const input=work();input.raw_case.executionId='';input.raw_case.taskId='';
 (input as unknown as {frozen_trace_evidence:null}).frozen_trace_evidence=null;
 const result=await fixture.api.evaluateFrozenExperimentWork(input,{user:'alice',signal:new AbortController().signal});
 assert.equal(result.score,73.5);assert.equal(fixture.sql,0);assert.equal(fixture.captured?.caseInput,'frozen input');
 assert.deepEqual(JSON.parse(JSON.stringify(fixture.captured?.interactions)),[]);
});

test('core cancellation observes actor-scoped state without legacy execution records',async()=>{
 let cancelled=false;let legacy=0;
 const context={rpc:async(action:string)=>{assert.equal(action,'read');return {experiment:{id:'exp',status:cancelled?'cancelled':'running',cases:[{id:'case'}]}};}};
 const api=load('src/lib/engine/experiment/cancellation-context.ts',{
  'node:async_hooks':{AsyncLocalStorage:class {getStore(){return undefined;}run(_scope:unknown,fn:Function){return fn();}}},
  '@/lib/storage/prisma':{prisma:new Proxy({},{get(){legacy++;throw Error('legacy forbidden');}})},
  '@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},
  '@/lib/storage-core/experiments':{requireCoreExperimentContext:()=>context},
  '@/lib/storage-core/workbench-results':load('src/lib/storage-core/workbench-results.ts',{}),
  './evaluation-attempt':{evaluationAttemptSignal:()=>undefined},
 });
 await api.assertExperimentActive('exp','case');cancelled=true;
 await assert.rejects(api.assertExperimentActive('exp','case'),(error:unknown)=>(error as {code:string}).code==='EXPERIMENT_CANCELLED');assert.equal(legacy,0);
});

 test('custom scoring executes the frozen card without consulting current custom definitions',async()=>{
 let promptCard:unknown;
 const fixture=grading({
  '@/lib/evaluators/custom-evaluator-model':{customEvaluatorUsesVariable:()=>false},
  '@/lib/evaluators/judge-assembly':{buildJudgePrompt:(card:unknown)=>{promptCard=card;return {system:'frozen',user:'text'};},parseJudgeText:()=>({score:91,summary:'frozen custom'}),JudgeOutputParseError:class extends Error {}},
  './judge-llm':{callJudgeLlm:async()=>'{"score":91}'},
  '@/server/user_evaluators_storage':{readUserCustomEvaluators:()=>{throw Error('Current evaluator must not be read');}},
 });
 const input=work();input.handle.evaluator_id='custom-frozen';
 const card={id:'custom-frozen',evaluatorType:'LLM',llmConfig:{systemPrompt:'original frozen prompt',skills:[]}};
 (input.frozen_evaluator as {card:unknown}).card=card;
 const result=await fixture.api.evaluateFrozenExperimentWork(input,{user:'alice',signal:new AbortController().signal});
 assert.equal(result.score,91);assert.equal(promptCard,card);assert.equal(fixture.sql,0);
});

test('failed scoring preserves attempts, duration and failure evidence in its receipt',async()=>{
 let failed:Record<string,unknown>|undefined;
 const ctx={actor:{username:'alice'},rpc:async(action:string,payload:Record<string,unknown>)=>{if(action==='load_work')return work();if(action==='fail')failed=payload;return {};}};
 const api=load('src/lib/storage-core/experiment-worker.ts',{
  './experiments':{runWithCoreExperimentContext:async(_ctx:unknown,fn:()=>Promise<unknown>)=>fn(),prepareCoreExperimentRuntime:async(_ctx:unknown,_work:unknown,fn:()=>Promise<unknown>)=>fn()},
  '@/lib/engine/experiment/run-experiment':{evaluateFrozenExperimentWork:async()=>{throw Object.assign(new Error('exhausted'),{coreExperimentFailureResult:{attempts:3,durationMs:50,evidence:{diagnostics:[{code:'TIMEOUT'}]}}});}},
 });
 await api.runCoreExperimentWork(handle,ctx);assert.equal((failed?.result as {attempts:number})?.attempts,3);
});

test('frozen root-cause cache requires matching frozen answer and never writes live datasets',()=>{
 const api=load('src/lib/engine/experiment/dataset-root-cause-context.ts',{
  '../../dataset-case-root-causes':{canReuseRootCauseCache:(answer:string,meta:{expectedOutputHash:string})=>answer===meta?.expectedOutputHash},
 });
 const stale=api.frozenExperimentRootCauseResolutionContext({referenceOutput:'new',rootCauses:[{content:'stale',weight:1}],rootCauseMeta:{status:'ready',expectedOutputHash:'old'}});
 assert.equal(stale.precomputedRootCauses,undefined);
 const fresh=api.frozenExperimentRootCauseResolutionContext({referenceOutput:'new',rootCauses:[{content:'correct',weight:1}],rootCauseMeta:{status:'ready',expectedOutputHash:'new'}});
 assert.equal(fresh.precomputedRootCauses[0].content,'correct');assert.equal(fresh.onLiveRootCausesExtracted,undefined);
});

test('an append accepted while the shared worker reconciles is drained before its activation promise settles',async()=>{
 let release:()=>void=()=>{};let announce:()=>void=()=>{};const barrier=new Promise<void>(resolve=>{release=resolve;});const reconciling=new Promise<void>(resolve=>{announce=resolve;});
 let first=true;let queued=false;let graded=0;let completed=0;
 const ctx={actor:{username:'alice',workspace:'w',principal:'alice'},rpc:async(action:string)=>{
  if(action==='claim'){if(queued){queued=false;return {...handle};}return null;}
  if(action==='load_work')return work();if(action==='complete')completed++;
  if(action==='reconcile'&&first){first=false;announce();await barrier;}return {};
 }};
 const api=load('src/lib/storage-core/experiment-worker.ts',{
  './experiments':{runWithCoreExperimentContext:async(_ctx:unknown,fn:()=>Promise<unknown>)=>fn(),prepareCoreExperimentRuntime:async(_ctx:unknown,_work:unknown,fn:()=>Promise<unknown>)=>fn()},
  '@/lib/engine/experiment/run-experiment':{evaluateFrozenExperimentWork:async()=>{graded++;return {score:50};}},'node:crypto':{randomUUID:()=> 'worker'},
 });
 const initial=api.activateExperimentWork(ctx,'exp');await reconciling;queued=true;const append=api.activateExperimentWork(ctx,'exp');release();await Promise.all([initial,append]);assert.equal(graded,1);assert.equal(completed,1);assert.equal(queued,false);
});

test('a replay after another worker completed returns the durable result instead of fabricating failed',async()=>{
 const api=load('src/lib/storage-core/experiment-worker.ts',{'./experiments':{},'@/lib/engine/experiment/run-experiment':{},'node:crypto':{randomUUID:()=> 'worker'}});
 const ctx={rpc:async(action:string)=>action==='claim'?null:{experiment_id:'exp',status:'done'}};
 assert.equal(await api.executeCoreResultRow(ctx,'result','exp'),'done');
});

test('frozen trigger analysis uses verified client routing facts rather than incidental Trace Skill mentions',async()=>{
 let trigger:Record<string,unknown>|undefined;
 const fixture=grading({'@/lib/skill-workbench/trigger-evaluator':{isSkillTriggerAnalyzerId:(id:string)=>id==='skill-trigger-analyzer',evaluateSkillTriggerAnalysis:(input:Record<string,unknown>)=>{trigger=input;return {score:input.shouldTrigger===input.skillTriggered?100:0};}}});
 const input=work();input.handle.evaluator_id='skill-trigger-analyzer';input.frozen_evaluator.card.id='skill-trigger-analyzer';input.raw_case.caseValuesJson='{"should_trigger":true,"trigger_rationale":"原始标注"}';
 (input.raw_case as Record<string,unknown>).triggerDecision={triggered:true,competingSkill:null,sessionId:'task',actualModel:'actual-model'};
 input.runplan={config:{execution_request:{skillExecution:{version:2,mode:'trigger',targetSkillName:'skill'}}}};
 const output=await fixture.api.evaluateFrozenExperimentWork(input,{user:'alice',signal:new AbortController().signal});assert.equal(output.score,100);assert.equal(trigger?.skillTriggered,true);assert.equal((trigger?.facts as Record<string,unknown>).runsTotal,1);assert.equal(fixture.sql,0);
 delete (input.raw_case as Record<string,unknown>).triggerDecision;
 await assert.rejects(fixture.api.evaluateFrozenExperimentWork(input,{user:'alice',signal:new AbortController().signal}),(error:unknown)=>(error as {status?:number}).status===503);
});

test('a committed score with a lost HTTP receipt is confirmed without compensating fail or another model call',async()=>{
 let graded=0,failed=0;const ctx={actor:{username:'alice'},rpc:async(action:string)=>{if(action==='load_work')return work();if(action==='complete')throw new TypeError('connection lost after commit');if(action==='lookup_operation')return {found:true,result:{experiment:{id:'exp'}}};if(action==='result_lookup')throw Error('Must not infer delivery from another generation');if(action==='fail')failed++;return {};}};
 const api=load('src/lib/storage-core/experiment-worker.ts',{'./experiments':{runWithCoreExperimentContext:async(_ctx:unknown,fn:Function)=>fn(),prepareCoreExperimentRuntime:async(_ctx:unknown,_work:unknown,fn:Function)=>fn()},'@/lib/engine/experiment/run-experiment':{evaluateFrozenExperimentWork:async()=>{graded++;return {score:90};}}});
 assert.equal(await api.runCoreExperimentWork(handle,ctx),'done');assert.equal(graded,1);assert.equal(failed,0);
});

test('an indeterminate score delivery remains a storage error instead of overwriting the result with failed',async()=>{
 let failed=0;const ctx={actor:{username:'alice'},rpc:async(action:string)=>{if(action==='load_work')return work();if(action==='complete')throw Object.assign(Error('unavailable'),{status:503});if(action==='lookup_operation')return {found:false};if(action==='result_lookup')return {...handle,status:'done',attempt_id:'different'};if(action==='fail')failed++;return {};}};
 const api=load('src/lib/storage-core/experiment-worker.ts',{'./experiments':{runWithCoreExperimentContext:async(_ctx:unknown,fn:Function)=>fn(),prepareCoreExperimentRuntime:async(_ctx:unknown,_work:unknown,fn:Function)=>fn()},'@/lib/engine/experiment/run-experiment':{evaluateFrozenExperimentWork:async()=>({score:90})}});
 await assert.rejects(api.runCoreExperimentWork(handle,ctx),(error:unknown)=>(error as {status?:number}).status===503);assert.equal(failed,0);
});

test('reusing an owned evaluator experiment follows the verified owner rather than a legacy username alias',async()=>{
 const context={actor:{username:'legacy-model-owner'},rpc:async(action:string)=>{assert.equal(action,'read');return {experiment:{id:'existing',user:'normalized-iam-owner',status:'draft'}};}};
 const fixture=grading({'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},'@/lib/storage-core/experiments':{requireCoreExperimentContext:()=>context}});
 const id=await fixture.api.ensureEvalExperiment({user:'legacy-model-owner',existingId:'existing',name:'owned',evaluatorIds:['preset-fixture']});assert.equal(id,'existing');assert.equal(fixture.sql,0);
});

test('an authorized but gold-redacted foreign experiment is never reused as an owned experiment',async()=>{
 const context={actor:{username:'legacy-model-owner'},rpc:async(action:string)=>{if(action==='read')return {gold_redacted:true,experiment:{id:'foreign',user:'legacy-model-owner',status:'draft'}};assert.equal(action,'ensure_lookup');throw new Error('Use only the owned creation path');}};
 const fixture=grading({'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},'@/lib/storage-core/experiments':{requireCoreExperimentContext:()=>context}});
 await assert.rejects(fixture.api.ensureEvalExperiment({user:'legacy-model-owner',existingId:'foreign',name:'owned',evaluatorIds:['preset-fixture']}),/owned creation path/);assert.equal(fixture.sql,0);
});


test('an uncertain model delivery preserves its intent and never records a compensating failed result',async()=>{
 const calls:string[]=[];const uncertain=Object.assign(new Error('Recorded model response is not confirmed'),{status:503,coreDeliveryUncertain:true});
 const ctx={actor:{username:'alice'},rpc:async(action:string)=>{calls.push(action);if(action==='load_work')return work();return {};}};
 const api=load('src/lib/storage-core/experiment-worker.ts',{'./experiments':{runWithCoreExperimentContext:async(_ctx:unknown,fn:Function)=>fn(),prepareCoreExperimentRuntime:async(_ctx:unknown,_work:unknown,fn:Function)=>fn()},'@/lib/engine/experiment/run-experiment':{evaluateFrozenExperimentWork:async()=>{throw uncertain;}}});
 await assert.rejects(api.runCoreExperimentWork(handle,ctx),error=>error===uncertain);assert.deepEqual(calls,['load_work']);
});

test('native evaluation cleanup aborts only the exact scoped attempt and waits for its worker',async()=>{
 let began!:()=>void;const ready=new Promise<void>(resolve=>{began=resolve;});let stopped=false;const calls:string[]=[];
 const ctx={actor:{username:'alice',workspace:'w',principal:'alice'},rpc:async(action:string)=>{calls.push(action);if(action==='load_work')return work();return {};}};
 const api=load('src/lib/storage-core/experiment-worker.ts',{'./experiments':{runWithCoreExperimentContext:async(_ctx:unknown,fn:Function)=>fn(),prepareCoreExperimentRuntime:async(_ctx:unknown,_work:unknown,fn:Function)=>fn()},'@/lib/engine/experiment/run-experiment':{evaluateFrozenExperimentWork:async(_work:unknown,{signal}:{signal:AbortSignal})=>{began();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{stopped=true;resolve();},{once:true}));return {score:80};}}});
 const running=api.runCoreExperimentWork(handle,ctx);await ready;assert.equal(typeof api.stopCoreEvaluationAttempt,'function');
 const target={experiment_id:'exp',attempt_id:'attempt',work_item_id:'work',run_id:'run',fence:'2',lease_owner:'worker',actor_principal_id:'alice'};
 await assert.rejects(api.stopCoreEvaluationAttempt(ctx,{...target,fence:'1'}),(error:any)=>error.status===409);assert.equal(stopped,false);
 const proof=await api.stopCoreEvaluationAttempt(ctx,target);assert.equal(proof.cleanup,'confirmed');assert.equal(proof.workspace_id,'w');assert.equal(stopped,true);assert.equal(await running,'failed');assert.equal(calls.includes('complete'),false);assert.equal(calls.includes('fail'),false);
});
test('unknown or explicitly unconfirmed native evaluation cleanup never produces a stopped proof',async()=>{
 let began!:()=>void;const ready=new Promise<void>(resolve=>{began=resolve;});const ctx={actor:{username:'alice',workspace:'w',principal:'alice'},rpc:async(action:string)=>action==='load_work'?work():{}};
 const api=load('src/lib/storage-core/experiment-worker.ts',{'./experiments':{runWithCoreExperimentContext:async(_ctx:unknown,fn:Function)=>fn(),prepareCoreExperimentRuntime:async(_ctx:unknown,_work:unknown,fn:Function)=>fn()},'@/lib/engine/experiment/run-experiment':{evaluateFrozenExperimentWork:async(_work:unknown,{signal}:{signal:AbortSignal})=>{began();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));throw Object.assign(new Error('Process group still exists'),{code:'EVALUATION_CLEANUP_UNCONFIRMED'});}}});
 assert.equal(typeof api.stopCoreEvaluationAttempt,'function');const target={experiment_id:'exp',attempt_id:'attempt',work_item_id:'work',run_id:'run',fence:'2',lease_owner:'worker',actor_principal_id:'alice'};
 await assert.rejects(api.stopCoreEvaluationAttempt(ctx,target),(error:any)=>error.status===503);const running=api.runCoreExperimentWork(handle,ctx);await ready;await assert.rejects(api.stopCoreEvaluationAttempt(ctx,target),(error:any)=>error.status===503);assert.equal(await running,'failed');await assert.rejects(api.stopCoreEvaluationAttempt(ctx,target),(error:any)=>error.status===503);
});
