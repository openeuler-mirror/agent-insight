import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source=ts.transpileModule(fs.readFileSync('src/lib/storage-core/experiment-routes.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(status:string,result:unknown,executorCallbackBaseUrl?:string){
 const calls:Record<string,unknown>[]=[];const usage:string[]=[];const context={actor:{username:'verified-owner'},request:new Request('http://internal.test/api/experiments/exp/run',{headers:{'x-forwarded-host':'public.test','x-forwarded-proto':'https'}}),body:{generateTrace:{workerId:'forged'}},rpc:async(action:string)=>{assert.equal(action,'read');return {experiment:{id:'exp',scope:'benchmark',status}};}};
 const module={exports:{}};vm.runInNewContext(source,{module,exports:module.exports,require:(id:string)=>({
  './experiments':{requireCoreExperimentContext:()=>context},
  '@/lib/benchmark/scheduler':{startBenchmarkExperiment:async(input:Record<string,unknown>)=>{calls.push(input);return result;}},
  '@/lib/benchmark/evaluator-runtime-config':{defaultEvaluatorRuntimeConfigProvider:{snapshot:()=>({executorCallbackBaseUrl})}},
  '@/lib/usage-analytics/collector':{recordUsageEvent:(event:{eventKey:string})=>usage.push(event.eventKey)},
 }[id]??{}),console,Response,URL,process:{env:{NEXT_PUBLIC_URL_PREFIX:'/insight/'}},Symbol,Set});
 return {calls,usage,run:(module.exports as {runCoreExperimentRoute:(id:string)=>Promise<Response>}).runCoreExperimentRoute};
}

test('generic Benchmark run preserves accepted DTO and callback origins through the typed scheduler',async()=>{
 const f=fixture('draft',{status:'running',alreadyRunning:false,runId:'erun',completion:Promise.resolve()},'https://executor.test/insight');const response=await f.run('exp');assert.equal(response.status,202);assert.deepEqual(await response.json(),{status:'running',runId:'erun'});assert.deepEqual(JSON.parse(JSON.stringify(f.calls)),[{experimentId:'exp',user:'verified-owner',publicCallbackOrigin:'https://public.test/insight',executorCallbackOrigin:'https://executor.test/insight'}]);assert.deepEqual(f.usage,['experiment.run']);
});
test('already-running Benchmark still resolves its real run identity without an ordinary-run shortcut',async()=>{
 const f=fixture('running',{status:'running',alreadyRunning:true,runId:'existing'});const response=await f.run('exp');assert.equal(response.status,202);assert.deepEqual(await response.json(),{status:'running',runId:'existing',alreadyRunning:true});assert.equal(f.calls.length,1);assert.equal(f.calls[0].executorCallbackOrigin,'https://public.test/insight');assert.deepEqual(f.usage,[]);
});
test('generic Benchmark run preserves missing experiment semantics from its scheduler',async()=>{
 const f=fixture('draft',null);await assert.rejects(()=>f.run('exp'),{status:404});
});
