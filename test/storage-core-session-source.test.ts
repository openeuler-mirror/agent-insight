import assert from 'node:assert/strict';
import test from 'node:test';
import {createIsolatedDatabase} from './helpers/isolated-database';
const isolated=createIsolatedDatabase();
test('core Session keeps the original Node views and headless Session without Span enrichment',async()=>{
 const {GET}=await import('@/app/api/observe/session/route');
 const {withTracePayloadVersions}=await import('@/lib/trace/session-payload');
 const old={fetch:globalThis.fetch,mode:process.env.AGENT_INSIGHT_TRACE_STORAGE,url:process.env.AGENT_INSIGHT_STORAGE_CORE_URL};
 const raw=[{z:0,a:null,role:'user',content:'完整原文'}];let headless=false;
 process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19017';
 globalThis.fetch=async(input)=>{
  const url=new URL(String(input));
  if(url.pathname==='/v1/auth/me')return Response.json({principal_id:'alice',username:'alice',workspace_id:'w',workspaces:[{workspace_id:'w',role:'member'}]});
  if(url.pathname.endsWith('/session-source'))return Response.json({value:{collector:true,trace_id:'internal',source_revision:'1',annotation_revision:'2',can_write:false,owner_principal_id:'alice',session_json:JSON.stringify({taskId:'task',label:'原标签',query:'原问题',user:'alice',startTime:'1970-01-01T00:00:00.000Z',interactions:raw}),execution:headless?null:{id:'execution',taskId:'task',user:'alice',framework:'generic',timestamp:'1970-01-01T00:00:00.000Z',tokens:0,cost:0,latency:0},thread:null}});
  if(url.pathname.endsWith('/session-sources'))return Response.json({value:[]});
  if(url.pathname.endsWith('/session-relations'))return Response.json({value:{task:{parent:null,children:[]}}});
  throw new Error('Unexpected private request '+url.pathname);
 };
 try{
  const headers={authorization:'Bearer api_'+ 'a'.repeat(43)};
  const full=await GET(new Request('http://localhost/api/observe/session?taskId=task',{headers}));assert.equal(full.status,200);const value=await full.json();assert.equal(value.startTime,0);assert.deepEqual(value.interactions,withTracePayloadVersions(raw));assert.equal(value.execution.tokens,0);assert.equal(value.execution.cost,0);assert.equal(value.interactions[0].spanId,undefined);
  const structure=await GET(new Request('http://localhost/api/observe/session?taskId=task&view=structure',{headers}));assert.equal(structure.status,200);assert.equal((await structure.json()).interactionCount,1);
  const item=await GET(new Request('http://localhost/api/observe/session?taskId=task&view=interaction&index=0',{headers}));assert.equal(item.status,200);assert.deepEqual((await item.json()).interaction,withTracePayloadVersions(raw)[0]);
  const {withCoreSessionRead,readCoreStoredSession}=await import('@/lib/storage-core/session-source');const {runCoreSessionModel}=await import('@/lib/storage-core/collector-entry');let executed=false;const modelRequest=new Request('http://localhost/api/observe/session?taskId=task',{headers});await withCoreSessionRead(modelRequest,async()=>{await readCoreStoredSession('task');await assert.rejects(runCoreSessionModel(modelRequest,'task',async()=>{executed=true;}),(error:any)=>error.status===403);});assert.equal(executed,false);
  headless=true;const empty=await GET(new Request('http://localhost/api/observe/session?taskId=task',{headers}));assert.equal(empty.status,200);assert.equal((await empty.json()).execution,undefined);
 }finally{globalThis.fetch=old.fetch;for(const [k,v] of [['AGENT_INSIGHT_TRACE_STORAGE',old.mode],['AGENT_INSIGHT_STORAGE_CORE_URL',old.url]] as const){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
test.after(async()=>{const {prismaRaw}=await import('@/lib/storage/prisma');await prismaRaw.$disconnect();isolated.dispose();});
