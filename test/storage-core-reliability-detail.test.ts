import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const require=createRequire(import.meta.url);
function setup(core:boolean,failure?:number,missing=false,changed?:number|'snapshot') {
 const all=Array.from({length:240},(_,index)=>({id:'event-'+index,deliveryId:'event-'+index,type:'anomaly',taskId:'task',platform:'opencode',framework:'opencode',anomalyKind:'timeout',severity:'high',summary:'event '+index,actionTypes:'retry',payloadJson:'{}',ts:new Date(Date.UTC(2026,10,15,0,index))}));
 const execution=missing?null:{id:'execution',taskId:'task',finalResult:'actual result'};
 let oldReads=0,validated=0,evidenceReads=0;
 const deps:Record<string,unknown>={
  'next/server':{NextResponse:Response},
  '@/lib/storage-core/mode':{isStorageCoreEnabled:()=>core},
  '@/lib/storage-core/read-retry':{withCoreReadRetry:async(_req:Request,read:()=>Promise<Response>)=>read(),coreReadChanged:(message:string)=>Object.assign(Error(message),{status:409,code:'TRACE_READ_CHANGED'})},
  '@/lib/storage-core/evidence':{readTraceExecution:async()=>{evidenceReads++;if(failure)throw Object.assign(Error('storage'),{status:failure});if(missing)throw Object.assign(Error('missing'),{status:404});if(evidenceReads>1&&typeof changed==='number')throw Object.assign(Error('source changed'),{status:changed});return{evidence:{execution,manifest:{},snapshot_hash:evidenceReads>1&&changed==='snapshot'?'changed':'original'}};}},
  '@/lib/storage-core/analytics':{readCoreRasEvents:async(_req:Request,tasks:string[],selection:{limit:number;order:string})=>{assert.equal(JSON.stringify(tasks),'["task"]');assert.equal(selection.order,'asc');assert.equal(selection.limit,200);return{events:all.slice(0,200),validate:async()=>{validated++;}};},analyticsFailure:(error:{status?:number})=>Response.json({error:'storage'},{status:error.status||503})},
  '@/lib/storage/prisma':{prisma:{execution:{findUnique:async()=>{oldReads++;if(core)throw Error('old Execution read');return execution;}},rasAnomalyEvent:{findMany:async()=>{oldReads++;if(core)throw Error('old RAS read');return missing?[]:all.slice(0,200);}}}},
 };
 const sandboxModule={exports:{}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/api/observe/executions/[executionId]/reliability/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:sandboxModule,exports:sandboxModule.exports,require:(name:string)=>deps[name]??require(name),Response,Request,URL,Date,console:{error(){}}});
 const {GET}=sandboxModule.exports as {GET:(request:Request,context:{params:Promise<{executionId:string}>})=>Promise<Response>};
 return {call:(locale='zh')=>GET(new Request('http://localhost/api/observe/executions/execution/reliability?locale='+locale),{params:Promise.resolve({executionId:'execution'})}),counts:()=>({oldReads,validated})};
}

for(const locale of ['zh','en'])test('reliability detail preserves oldest 200 events and original DTO '+locale,async()=>{
 const core=setup(true);const after=await core.call(locale);
 assert.equal(after.status,200);const body=await after.json();assert.equal(body.anomalyCount,200);assert.equal(body.anomalyStatus,'abnormal');assert.equal(body.executionId,'execution');assert.equal(body.faults.length,200);assert.equal(body.faults[0].summary,'event 0');assert.equal(body.faults[199].summary,'event 199');assert.equal(body.faults[0].firstOccurredAt,'2026-11-15T00:00:00.000Z');assert.equal(body.faults[199].firstOccurredAt,new Date(Date.UTC(2026,10,15,0,199)).toISOString());assert.equal(core.counts().oldReads,0);assert.equal(core.counts().validated,1);
});
test('reliability detail keeps unknown empty response for an absent execution',async()=>{
 const legacy=setup(false,undefined,true),core=setup(true,undefined,true);
 assert.deepEqual(await (await core.call()).json(),await (await legacy.call()).json());assert.equal(core.counts().oldReads,0);
});
test('reliability detail propagates authorization and source errors without legacy fallback',async()=>{
 for(const status of [401,403,409,413,503]){const core=setup(true,status);assert.equal((await core.call()).status,status);assert.equal(core.counts().oldReads,0);}
});
test('reliability detail rechecks the execution after RAS reads and rejects revoked, deleted or edited sources',async()=>{
 for(const changed of [403,404,'snapshot'] as const){const core=setup(true,undefined,false,changed);assert.equal((await core.call()).status,changed==='snapshot'?409:changed);assert.equal(core.counts().oldReads,0);}
});
