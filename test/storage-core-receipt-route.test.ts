import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
function load(file:string,dependencies:Record<string,unknown>){
 const module={exports:{}};
 vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:(id:string)=>dependencies[id]??{},Response,Request,console,URL});
 return module.exports as Record<string,Function>;
}
test('public create checks the committed receipt before current evaluator, dataset or user catalog validation',async()=>{
 let pairs=0;const core={compatibilityRoute:true};
 const route=load('src/app/api/experiments/route.ts',{
  'next/server':{NextResponse:Response},'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},
  '@/lib/storage-core/experiments':{getCoreExperimentContext:()=>core,lookupCoreExperimentOperation:async()=>({experiment:{id:'original',type:'llm'}})},
  '@/lib/engine/experiment/comparison-runner':{autoPairGroups:async(id:string)=>{assert.equal(id,'original');pairs++;}},
  '@/lib/auth/auth':{resolveUser:()=>{throw Error('latest catalog should not be touched');}},
 });
 const response=await route.POST(new Request('http://localhost/api/experiments',{method:'POST',body:'{"name":"old","type":"llm"}'}));
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{id:'original'});assert.equal(pairs,1);
});
test('public diagnosis replay reaches its receipt before rebuilding latest frozen skills or source selection',async()=>{
 let lookup=0;const route=load('src/app/api/experiments/[id]/cases/[caseId]/diagnoses/route.ts',{
  '@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},
  '@/lib/diagnosis/http':{diagnosisRequestResponse:async(_request:Request,fn:Function)=>Response.json(await fn()),diagnosisUser:async()=> 'owner'},
  '@/lib/diagnosis/contracts':{diagnosisRequest:{parse:(body:unknown)=>body}},
  '@/lib/diagnosis/service':{buildSnapshot:()=>{throw Error('latest snapshot unavailable');}},
  '@/lib/storage-core/diagnosis-consumer':{lookupCoreDiagnosisSubmission:async(id:string,caseId:string,input:Record<string,unknown>)=>{lookup++;assert.equal(id,'exp');assert.equal(caseId,'case');assert.equal(input.requestKey,'key');return {id:'committed-run',status:'done'};}},
 });
 const response=await route.POST(new Request('http://localhost/api/experiments/exp/cases/case/diagnoses',{method:'POST',body:JSON.stringify({resultIds:['result'],requestKey:'key',expectedInputHash:'a'.repeat(64)})}),{params:Promise.resolve({id:'exp',caseId:'case'})});
 assert.deepEqual(await response.json(),{runId:'committed-run',status:'done'});assert.equal(lookup,1);
});
