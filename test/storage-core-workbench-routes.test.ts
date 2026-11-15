import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
test('the original workbench experiment route acquires trusted scope and ignores a spoofed query user',async()=>{
 let context:Record<string,unknown>|undefined;let scopes=0;let owner:string|undefined;
 const module={exports:{}};const dependencies:Record<string,unknown>={
  'next/server':{NextResponse:Response},'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},'@/lib/storage-core/experiments':{getCoreExperimentContext:()=>context},
  '@/lib/storage-core/workbench':{withCoreWorkbenchRoute:async(request:Request,next:Function)=>{scopes++;context={compatibilityRoute:true};const url=new URL(request.url);url.searchParams.set('user','verified');return next({url:url.toString(),nextUrl:url});}},
  '@/lib/auth/auth':{resolveUser:async(_request:Request,user:string)=>({username:user})},'@/lib/skill-workbench/experiment-service':{listWorkbenchExperiments:async(user:string)=>{owner=user;return {experiments:[]};},WORKBENCH_EXPERIMENT_PRESETS:['use-case']},
 };
 vm.runInNewContext(ts.transpileModule(readFileSync('src/app/api/skill-workbench/skills/[name]/experiments/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:(id:string)=>dependencies[id]??{},Response,URL,console});
 const request={url:'http://localhost/api/skill-workbench/skills/skill/experiments?version=1&user=forged',nextUrl:new URL('http://localhost/api/skill-workbench/skills/skill/experiments?version=1&user=forged')};
 const response=await (module.exports as {GET:Function}).GET(request,{params:Promise.resolve({name:'skill'})});assert.equal(response.status,200);assert.equal(scopes,1);assert.equal(owner,'verified');
});
