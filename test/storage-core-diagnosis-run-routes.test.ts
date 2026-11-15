import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
function load(path:string){const module={exports:{}};let scoped=false;let legacy=0;let core=0;vm.runInNewContext(ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,console,Response,require:(name:string)=>{
 if(name.endsWith('/http'))return {diagnosisRequestResponse:async(_r:Request,fn:Function)=>{scoped=true;return Response.json(await fn());},diagnosisResponse:async(fn:Function)=>Response.json(await fn()),diagnosisUser:async()=>{assert.equal(scoped,true);return 'trusted';}};
 if(name.endsWith('/mode'))return {isStorageCoreEnabled:()=>true};
 if(name.endsWith('diagnosis-consumer'))return {listCoreDiagnoses:async()=>{core++;return [{id:'run',status:'done'}];}};
 if(name.endsWith('/prisma'))return {prismaRaw:{diagnosisRun:{findMany:async()=>{legacy++;return [];}}}};
 if(name.endsWith('/service'))return {getDiagnosis:async()=>{assert.equal(scoped,true);return {id:'run'};}};
 return {};
 }});return {api:module.exports as Record<string,Function>,counts:()=>({core,legacy})};}
test('DiagnosisRun read enters verified request scope before service access',async()=>{const f=load('src/app/api/diagnosis-runs/[runId]/route.ts');const response=await f.api.GET(new Request('http://localhost/api/diagnosis-runs/run'),{params:Promise.resolve({runId:'run'})});assert.equal(response.status,200);assert.equal((await response.json()).id,'run');});
test('Case diagnosis list reads core with the original runs response',async()=>{const f=load('src/app/api/experiments/[id]/cases/[caseId]/diagnoses/route.ts');const response=await f.api.GET(new Request('http://localhost/api/experiments/e/cases/c/diagnoses'),{params:Promise.resolve({id:'e',caseId:'c'})});assert.equal(response.status,200);assert.deepEqual(await response.json(),{runs:[{id:'run',status:'done'}]});assert.deepEqual(f.counts(),{core:1,legacy:0});});
