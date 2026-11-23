import assert from 'node:assert/strict';
import test from 'node:test';
import {createIsolatedDatabase} from './helpers/isolated-database';

const isolated=createIsolatedDatabase();
type Source=Record<string,any>;
function source(taskId:string,revision:string,label:string,query='question'):Source{return {
 collector:true,trace_id:'trace-'+taskId,identity_hash:'d'.repeat(64),source_revision:revision,annotation_revision:revision,can_write:false,can_execute:false,owner_principal_id:'alice',
 session_json:JSON.stringify({taskId,label,query,user:'alice',startTime:'1970-01-01T00:00:00.000Z',interactions:[{role:'user',content:'unchanged content'}]}),
 execution:{id:taskId,taskId,user:'alice',framework:'generic',timestamp:'1970-01-01T00:00:00.000Z',tokens:0,cost:0,latency:0},thread:null,
};}
async function run(taskId:string,read:(count:number)=>Source,action:(get:(view?:string)=>Promise<Response>,reads:()=>number)=>Promise<void>){
 const previous={fetch:globalThis.fetch,mode:process.env.AGENT_INSIGHT_TRACE_STORAGE,url:process.env.AGENT_INSIGHT_STORAGE_CORE_URL};let count=0;
 process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19019';
 globalThis.fetch=async(input)=>{
  const url=new URL(String(input));
  if(url.pathname==='/v1/auth/me')return Response.json({principal_id:'alice',username:'alice',workspace_id:'w',workspaces:[{workspace_id:'w',role:'member'}]});
  if(url.pathname.endsWith('/session-source'))return Response.json({value:read(++count)});
  if(url.pathname.endsWith('/session-sources'))return Response.json({value:[]});
  if(url.pathname.endsWith('/session-relations'))return Response.json({value:{[taskId]:{parent:null,children:[]}}});
  throw Error('Unexpected model or private request '+url.pathname);
 };
 try{const {GET}=await import('@/app/api/observe/session/route');await action((view='structure')=>GET(new Request('http://localhost/api/observe/session?'+new URLSearchParams({taskId,view}),{headers:{authorization:'Bearer api_'+'r'.repeat(43)}})),()=>count);}
 finally{globalThis.fetch=previous.fetch;for(const [key,value] of [['AGENT_INSIGHT_TRACE_STORAGE',previous.mode],['AGENT_INSIGHT_STORAGE_CORE_URL',previous.url]] as const){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
}

test('core parsed Session cache refreshes query and label when source revisions change without changing interactions',async()=>{
 const task='revision-cache';let current=source(task,'1','before','old query');
 await run(task,()=>current,async get=>{const first=await get();assert.equal(first.status,200);assert.equal((await first.json()).label,'before');current=source(task,'2','after','new query');const second=await get();assert.equal(second.status,200);const value=await second.json();assert.equal(value.label,'after');assert.equal(value.query,'new query');});
});

test('a same-identity source transition during Session postflight rebuilds the whole authorized read',async()=>{
 const task='postflight-change';await run(task,count=>source(task,count===1?'1':'2',count===1?'before':'after'),async(get,reads)=>{const response=await get();assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).label,'after');assert.ok(reads()>=4);});
});

test('a source transition before on-demand model execution cannot be swallowed into a stale successful Session',async()=>{
 const task='model-preflight-change';await run(task,count=>{const value=source(task,count===1?'1':'2',count===1?'before':'after',count===1?'':'new query');value.can_execute=true;return value;},async(get,reads)=>{const response=await get('full');assert.equal(response.status,200,await response.clone().text());const value=await response.json();assert.equal(value.label,'after');assert.equal(value.query,'new query');assert.ok(reads()>=4);});
});

test('a collector Session disappearing at postflight is rejected without adopting another identity',async()=>{
 const task='disappearing-source';await run(task,count=>count===1?source(task,'1','before'):{collector:false},async(get,reads)=>{const response=await get();assert.equal(response.status,409);assert.equal(reads(),2);});
});

test('a replaced Trace identity at Session postflight is not automatically retried',async()=>{
 const task='replaced-identity';await run(task,count=>{const value=source(task,'1','before');if(count>1)value.trace_id='replacement';return value;},async(get,reads)=>{assert.equal((await get()).status,409);assert.equal(reads(),2);});
});
test('a changed incarnation proof at Session postflight is not automatically retried',async()=>{
 const task='changed-incarnation';await run(task,count=>{const value=source(task,count===1?'1':'2','before');if(count>1)value.identity_hash='e'.repeat(64);return value;},async(get,reads)=>{assert.equal((await get()).status,409);assert.equal(reads(),2);});
});
test('legacy Session sources without identity proof cannot gain automatic transition retries',async()=>{
 const task='legacy-no-proof';await run(task,count=>{const value=source(task,count===1?'1':'2','before');delete value.identity_hash;return value;},async(get,reads)=>{assert.equal((await get()).status,409);assert.equal(reads(),2);});
});
test('model preflight identity and unproven-version failures cannot be swallowed after refreshing its cache',async()=>{
 for(const kind of ['trace','owner','proof'] as const){
  const task='model-invalid-'+kind;await run(task,count=>{const value=source(task,count===1?'1':'2','before',count===1?'':'new query');value.can_execute=true;if(kind==='proof')delete value.identity_hash;if(count>1){if(kind==='trace')value.trace_id='replacement';if(kind==='owner')value.owner_principal_id='bob';}return value;},async(get,reads)=>{assert.equal((await get('full')).status,409);assert.equal(reads(),2);});
 }
});
test.after(async()=>{const {prismaRaw}=await import('@/lib/storage/prisma');await prismaRaw.$disconnect();isolated.dispose();});
