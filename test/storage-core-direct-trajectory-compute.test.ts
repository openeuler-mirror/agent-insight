import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function load(){const module={exports:{}};vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/eval/direct-trajectory-draft.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:()=>({}),Date,JSON,structuredClone,AbortSignal});return module.exports as Record<string,Function>;}
const work=()=>({runplan:{config:{}},handle:{case_id:'case',experiment_id:'run',evaluator_id:'__direct_trajectory__',attempt_id:'attempt'},raw_case:{id:'case',taskId:'task',directTrajectory:{id:'compat-result',evaluatorRunId:'run',datasetId:'dataset',caseId:'gold',rawAnalysisJson:'{"selectedEvaluators":["custom-one"]}',status:'pending'}},frozen_trace_evidence:{execution:{id:'execution',taskId:'task',query:'private raw input',finalResult:'answer'},session:{taskId:'task',interactions:[{role:'assistant',content:'full trace'}]}}});

test('direct computation draft reads only frozen source and submits immutable 0..100 result',async()=>{
 const api=load();const input=work();const draft=api.createDirectTrajectoryDraft(input,'alice',new AbortController().signal);
 assert.equal((await draft.source.execution.findFirst({where:{taskId:'task'}})).query,'private raw input');
 assert.deepEqual(JSON.parse((await draft.source.session.findUnique({where:{taskId:'task'}})).interactions),input.frozen_trace_evidence.session.interactions);
 await draft.source.trajectoryEvalResult.update({where:{id:'compat-result'},data:{status:'done',trajectoryScore:0.8,rawAnalysisJson:'{"score":0,"customEvaluationScore":null}'}});
 const result=draft.result();assert.equal(result.score,80);assert.equal(result.evidence.json.directTrajectory.trajectoryScore,0.8);assert.equal(JSON.parse(result.evidence.json.directTrajectory.rawAnalysisJson).score,0);
 assert.equal(input.raw_case.directTrajectory.status,'pending');
 await assert.rejects(draft.source.trajectoryEvalResult.update({where:{id:'other'},data:{status:'done'}}));
});

test('unscored remains null and missing source or cancellation fails closed',async()=>{
 const api=load();const input=work();const controller=new AbortController();const draft=api.createDirectTrajectoryDraft(input,'alice',controller.signal);
 await draft.source.trajectoryEvalResult.update({where:{id:'compat-result'},data:{status:'done',trajectoryScore:null,rawAnalysisJson:'{"customEvaluationScore":null}'}});
 assert.equal(draft.result().score,null);controller.abort();assert.throws(()=>draft.result());
 const missing=work();(missing as {frozen_trace_evidence:unknown}).frozen_trace_evidence=null;assert.throws(()=>api.createDirectTrajectoryDraft(missing,'alice',new AbortController().signal));
});

test('original custom evaluator algorithm runs against frozen request, full Trace and immutable Dataset scope',async()=>{
 const draftApi=load();let captured:Record<string,unknown>|undefined;let datasetLoads=0;let legacy=0;
 const deps:Record<string,unknown>={
  './direct-trajectory-draft':draftApi,
  './frozen-skill-catalog':{withFrozenSkillCatalog:async(_skills:unknown,_user:string,action:()=>Promise<unknown>)=>action()},
  '@/lib/engine/evaluation/derive-skill-opt-points':{deriveOptPointArtifacts:()=>({evaluations:[],skillIssues:[]})},
  '@/lib/evaluators/evaluator-skill-service':{resolveFrozenCustomEvaluator:async()=>({id:'custom-one',name:'Frozen evaluator',llmConfig:{systemPrompt:'{{input}}',userPrompt:'',skills:[]}})},
  '@/lib/engine/evaluation/custom-llm-evaluator':{isCustomEvaluatorId:(id:string)=>id.startsWith('custom-'),runCustomLlmEvaluator:async(_user:string,_id:string,context:Record<string,unknown>)=>{captured=context;return {evaluatorId:'custom-one',score:75,reason:'frozen original custom result'};}},
  '@/lib/engine/evaluation/task-completion-json':{parseLooseJson:JSON.parse},
  '@/lib/engine/evaluation/eval-run-guards':{createSimpleAsyncLimiter:()=>({acquire:async()=>{},release:()=>{}})},
  '@/lib/engine/evaluation/semantic-dataset-match':{extractRealUserInput:async(input:string)=>({normalized_input:input})},
  '@/lib/engine/evaluation/trajectory-auto-watch-helper':{normalizeAutoWatchEnabledAt:()=>''},
  '@/lib/eval/trajectory-task-meta':{extractTrajectoryTaskMeta:()=>({title:'run'})},
  '@/lib/engine/evaluation/trace-summarizer':{summarizeTrace:()=>({steps:[],totalSteps:0}),formatTraceForLLM:()=>''},
  '@/lib/engine/evaluation/key-action-trace-analysis':{buildSkillKeyActionReference:async()=>({status:'unavailable'}),getPrimaryExecutionSkillTargets:()=>[]},
  '@/lib/engine/evaluation/skill-attribution':{buildSkillAttributionStatus:()=>({state:'unavailable'})},
  '@/lib/dataset-case-root-causes':{canReuseRootCauseCache:()=>false},
  '@/lib/evaluation-task-manager':{startOrReplace:()=>({runId:'active'}),finish:()=>{}},
  '@/lib/eval/trajectory-diagnostic':{buildEvaluationDiagnostic:()=>({code:'error'})},
  '@/server/agent_datasets_storage':{findAgentDataset:()=>{datasetLoads++;throw Error('Live Dataset forbidden');}},
  '@/lib/storage/prisma':{prismaRaw:new Proxy({},{get(){legacy++;throw Error('legacy forbidden');}})},
 };
 const module={exports:{}};vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/eval/direct-trajectory-compute.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:(name:string)=>deps[name]||{},Date,JSON,structuredClone,AbortSignal,console,process:{env:{}},Symbol,Map,Set,Promise,setTimeout,clearTimeout});
 const input={...work(),experiment_config:{configSnapshotJson:JSON.stringify({coreDirectDatasets:{datasets:[{id:'dataset',name:'frozen',cases:[{id:'gold',input:'private raw input',expectedOutput:'gold',trajectory:'',evaluationFocus:''}]}]}})}};
 const result=await (module.exports as Record<string,Function>).computeFrozenDirectTrajectory(input,{user:'alice',signal:new AbortController().signal});
 assert.equal(result.score,75);assert.equal(captured?.caseInput,'private raw input');assert.equal(result.evidence.json.directTrajectory.trajectoryScore,null);assert.equal(datasetLoads,0);assert.equal(legacy,0);
 assert.equal(JSON.parse(result.evidence.json.directTrajectory.rawAnalysisJson).customEvaluations['custom-one'].score,75);
});

test('canonical score converts trace and result fractions but preserves custom evaluator hundred scale',async()=>{
 const api=load();const draft=api.createDirectTrajectoryDraft(work(),'alice',new AbortController().signal);
 await draft.source.trajectoryEvalResult.update({where:{id:'compat-result'},data:{status:'done',trajectoryScore:0.8,rawAnalysisJson:'{"resultEvaluation":{"score":0.6},"customEvaluationScore":40}'}});
 assert.equal(draft.result().score,60);
});
