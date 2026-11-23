import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

for(const [suffix,method] of [['','GET'],['','POST'],['','DELETE'],['/upload','POST'],['/draft','POST'],['/run','POST'],['/runs','GET'],['/run/[runId]/cancel','POST']])test('Trigger '+(suffix||'root')+' '+method+' verifies actor before any legacy source access',async()=>{
 let touched=0;const poison=new Proxy(function(){touched++;throw Error('Static or model access before trusted Trigger identity');},{get(){return poison;},apply(){touched++;throw Error('Static or model access before trusted Trigger identity');}});
 const fixtureModule={exports:{}};const dependencies:Record<string,unknown>={
  'next/server':{NextResponse:Response},'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},
  '@/lib/storage-core/experiments':{getCoreExperimentContext:()=>null,coreExperimentFailure:()=>Response.json({error:'denied'},{status:401})},
  '@/lib/storage-core/trigger':{isCoreTriggerRoute:()=>false,withCoreTriggerRoute:async()=>Response.json({error:'denied'},{status:401})},
 };
 const source=fs.readFileSync('src/app/api/skill-eval/trigger/[skillName]'+suffix+'/route.ts','utf8');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:fixtureModule,exports:fixtureModule.exports,require:(name:string)=>dependencies[name]||poison,URL,Request,Response,console:{error:()=>{},warn:()=>{}},Date,AbortController,Map,Set});
 const result=await (fixtureModule.exports as Record<string,(request:Request,route:unknown)=>Promise<Response>>)[method](new Request('http://localhost/api/skill-eval/trigger/checking'+suffix.replace('[runId]','r')+'?user=forged',{method,...(method==='POST'?{headers:{'content-type':'application/json'},body:JSON.stringify({user:'forged',items:[]})}:{})}),{params:Promise.resolve({skillName:'checking',runId:'r'})});
 assert.equal(result.status,401);assert.equal(touched,0);
});
