import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {randomUUID} from 'node:crypto';

test('the existing Experiment worker dispatches a frozen legacy Trigger aggregate to its dedicated runner',async()=>{
 let legacy=0,trigger=0,completed=0;const fixtureModule={exports:{}};
 const handle={experiment_id:'trigger-exp',run_id:'run',work_item_id:'work',attempt_id:'attempt',case_id:'case',result_id:'slot',evaluator_id:'__skill_trigger_live__',fence:'2',lease_owner:'worker'};
 const work={handle,runplan:{config:{core_trigger:{version:1,kind:'run'}}},experiment_config:{scope:'skill-trigger-analysis'},raw_case:{}};
 const context={actor:{workspace:'w',principal:'alice',username:'legacy-alice'},rpc:async(action:string)=>{if(action==='load_work')return work;if(action==='fail')throw Error('wrong default evaluator');return {};}};
 const dependencies:Record<string,unknown>={
  'node:crypto':{randomUUID},'@/lib/engine/experiment/run-experiment':{evaluateFrozenExperimentWork:async()=>{legacy++;throw Error('ordinary evaluator must not replace legacy live Trigger');}},
  './experiments':{runWithCoreExperimentContext:(_context:unknown,fn:()=>Promise<unknown>)=>fn(),prepareCoreExperimentRuntime:(_context:unknown,_work:unknown,fn:()=>Promise<unknown>)=>fn()},
  './execution-delivery':{isCoreDeliveryUncertain:()=>false,submitCoreOperationReceipt:async()=>{completed++;}},
  './experiment-skill-derived':{attachExperimentSkillDerived:(_work:unknown,value:unknown)=>value},
  './trigger-runtime':{evaluateCoreTriggerWork:async()=>{trigger++;return {score:100,evidence:{json:{coreTriggerResult:{items:[]}}}};}},
 };
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/storage-core/experiment-worker.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:fixtureModule,exports:fixtureModule.exports,require:(name:string)=>dependencies[name],setInterval,clearInterval,setTimeout,clearTimeout,AbortController,Map,Symbol,console});
 const status=await (fixtureModule.exports as {runCoreExperimentWork:(handle:unknown,context:unknown)=>Promise<string>}).runCoreExperimentWork(handle,context);
 assert.equal(status,'done');assert.equal(trigger,1);assert.equal(legacy,0);assert.equal(completed,1);
});
