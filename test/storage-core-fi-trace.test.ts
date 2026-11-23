import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const require=createRequire(import.meta.url);
function setup(core:boolean,options:{privateRun?:boolean;missingSession?:boolean;failure?:number;changed?:boolean}={}){
 const run={runId:'run',sessionTaskId:'task',fiTaskId:'fi-task',user:options.privateRun?'bob':'legacy-alice',platform:'opencode',fault:'timeout',submode:'test',status:'done',error:null,requestJson:'{}',markersJson:'[]',judgedAt:null};
 const session=options.missingSession?null:{taskId:'task',model:'session/model',interactions:JSON.stringify([{role:'assistant',content:'实际执行结果'}])};
 const events=[{id:'ras',deliveryId:'delivery',taskId:'task',type:'anomaly',framework:'opencode',platform:'opencode',anomalyKind:'timeout',severity:'high',summary:'actual RAS',actionTypes:'retry',payloadJson:'{}',ts:new Date('2026-11-15T00:00:00Z')}];
 let oldDynamicReads=0,evidenceReads=0,validations=0;
 const controls={faultInjectionRun:{findUnique:async()=>run,findFirst:async(query:{where:{user:string}})=>query.where.user===run.user?run:null},faultInjectionTask:{findUnique:async()=>({taskKey:'key',name:'Task',model:null}),findFirst:async()=>({taskKey:'key',name:'Task',model:null})},session:{findUnique:async()=>{oldDynamicReads++;if(core)throw Error('old Session read');return session;}}};
 const deps:Record<string,unknown>={
  'next/server':{NextResponse:Response},'@/lib/storage/prisma':{prisma:controls,prismaRaw:controls},
  '@/lib/auth/auth':{resolveUser:async()=>({username:'legacy-alice'})},
  '@/lib/storage-core/mode':{isStorageCoreEnabled:()=>core},
  '@/lib/storage-core/fault-injection':{withCoreFiRequest:async(_request:Request,action:()=>Promise<Response>)=>action(),coreFiOwner:()=> 'legacy-alice',resolveFiUser:async()=>({username:'legacy-alice'}),findCoreFiRun:async()=>run.user==='legacy-alice'?run:null,findCoreFiTask:async()=>({taskKey:'key',name:'Task',model:null})},
  '@/lib/storage-core/control-context':{requireCoreControlContext:()=>({})},
  '@/lib/storage-core/compat':{compatibilityContext:async()=>({username:'legacy-alice',principalUsername:'alice',principal:'alice',workspace:'w'}),compatibilityFailure:(error:{status?:number})=>Response.json({error:'core'},{status:error.status||503})},
  '@/lib/storage-core/evidence':{readTraceEvidence:async()=>{evidenceReads++;if(options.failure)throw Object.assign(Error('core'),{status:options.failure});if(!session)throw Object.assign(Error('missing'),{status:404});return{evidence:{snapshot_hash:options.changed&&evidenceReads>1?'changed':'original',execution:{user:run.user},session:{...session,interactions:JSON.parse(session.interactions)}}};}},
  '@/lib/storage-core/analytics':{readCoreRasEvents:async()=>({events,validate:async()=>{validations++;}}),analyticsFailure:(error:{status?:number})=>Response.json({error:'core'},{status:error.status||503})},
  '@/lib/ingest/ras/store':{listRasEventsByTaskIds:async()=>{oldDynamicReads++;if(core)throw Error('old RAS read');return events;}},
  '@/lib/fault-injection/worker-protocol':{getLatestWorkerInventory:async()=>null},
 };
 const sandboxModule={exports:{}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/api/fault-injection/runs/[runId]/trace/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:sandboxModule,exports:sandboxModule.exports,require:(name:string)=>deps[name]??require(name),Response,Request,URL,Date,console:{error(){}}});
 const {GET}=sandboxModule.exports as {GET:(request:Request,ctx:{params:Promise<{runId:string}>})=>Promise<Response>};
 return{call:()=>GET(new Request('http://localhost/api/fault-injection/runs/run/trace?user=bob'),{params:Promise.resolve({runId:'run'})}),counts:()=>({oldDynamicReads,evidenceReads,validations})};
}
for(const missingSession of [false,true])test('FI Trace keeps original interactions/model/real RAS and markers DTO '+missingSession,async()=>{
 const before=setup(false,{missingSession}),after=setup(true,{missingSession});const result=await after.call();assert.equal(result.status,200);assert.deepEqual(await result.json(),await (await before.call()).json());assert.equal(after.counts().oldDynamicReads,0);assert.equal(after.counts().validations,1);
});
test('FI Trace does not expose another static control owner through a spoofed query user',async()=>{
 const api=setup(true,{privateRun:true});assert.equal((await api.call()).status,404);assert.equal(api.counts().evidenceReads,0);
});
test('FI Trace rejects source errors and changes without old Session/RAS fallback',async()=>{
 for(const failure of [401,403,409,413,503]){const api=setup(true,{failure});assert.equal((await api.call()).status,failure);assert.equal(api.counts().oldDynamicReads,0);}
 const changed=setup(true,{changed:true});assert.equal((await changed.call()).status,409);
});
test('existing apiFetch transports the actual key only for the migrated FI Trace GET',async()=>{
 const sandboxModule={exports:{}};const keys:string[]=[];
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/client/api.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:sandboxModule,exports:sandboxModule.exports,process:{env:{}},window:{},localStorage:{getItem:()=> 'actual-key'},Headers,Response,Date,setTimeout,fetch:async(_url:string,options:RequestInit)=>{keys.push(new Headers(options.headers).get('x-witty-api-key')||'');return Response.json({});}});
 const {apiFetch}=sandboxModule.exports as {apiFetch:(url:string,options?:RequestInit)=>Promise<Response>};
 await apiFetch('/api/fault-injection/runs/run/trace?user=bob');await apiFetch('/api/fault-injection/runs/run/trace',{method:'DELETE'});assert.deepEqual(keys,['actual-key','']);
});
