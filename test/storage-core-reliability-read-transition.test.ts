import assert from 'node:assert/strict';
import test from 'node:test';
import {createIsolatedDatabase} from './helpers/isolated-database';
const isolated=createIsolatedDatabase();

async function run(replaced:boolean,revoked:boolean){
 const previous={fetch:globalThis.fetch,mode:process.env.AGENT_INSIGHT_TRACE_STORAGE,url:process.env.AGENT_INSIGHT_STORAGE_CORE_URL};let evidenceReads=0,identities=0;
 process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19023';
 globalThis.fetch=async(input,options)=>{
  const url=new URL(String(input));
  if(url.pathname==='/v1/auth/me'){if(revoked&&++identities>2)return Response.json({error:'revoked'},{status:401});return Response.json({principal_id:'alice',username:'alice',workspace_id:'w',workspaces:[{workspace_id:'w',role:'member'}]});}
  if(url.pathname.endsWith('/evidence')){
   evidenceReads++;return Response.json({value:{format:'agent-insight.trace-execution',version:1,captured_at:'2026-11-18T00:00:00.000Z',snapshot_hash:(evidenceReads===1?'a':'b').repeat(64),manifest:{project_id:'default',workspace_id:'w',trace_id:replaced&&evidenceReads>1?'replacement':'trace',source_namespace:'collector.source.v1',native_trace_id:'task',trace_bucket:'2026-11-18',incarnation:'1',route_epoch:'1',owner_principal_id:'alice',aliases:{task_id:'task',execution_id:'execution'}},execution:{id:'execution',taskId:'task',framework:'generic',finalResult:null}}});
  }
  if(url.pathname.endsWith('/analytics')){
   const action=JSON.parse(String(options?.body)).action;
   if(action==='ras_read')return Response.json({value:{events:[],read_token:'read-token',scope_fingerprint:'scope',execution_ids:{}}});
   if(action==='validate_ras_read')return Response.json({value:{scope_fingerprint:'scope'}});
  }
  throw Error('Unexpected request '+url.pathname);
 };
 try{const {GET}=await import('@/app/api/observe/executions/[executionId]/reliability/route');const response=await GET(new Request('http://localhost/api/observe/executions/execution/reliability',{headers:{authorization:'Bearer api_'+'k'.repeat(43)}}),{params:Promise.resolve({executionId:'execution'})});return {response,evidenceReads};}
 finally{globalThis.fetch=previous.fetch;for(const [key,value] of [['AGENT_INSIGHT_TRACE_STORAGE',previous.mode],['AGENT_INSIGHT_STORAGE_CORE_URL',previous.url]] as const){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
}
test('reliability detail refreshes its whole read when only the same Trace evidence version changes',async()=>{const {response,evidenceReads}=await run(false,false);assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).executionId,'execution');assert.equal(evidenceReads,4);});
test('reliability detail rejects identity replacement instead of reading another Trace',async()=>{const {response,evidenceReads}=await run(true,false);assert.equal(response.status,409);assert.equal(evidenceReads,2);});
test('revocation during reliability revalidation remains an authentication failure',async()=>{const {response,evidenceReads}=await run(false,true);assert.equal(response.status,401);assert.equal(evidenceReads,1);});
test.after(async()=>{const {prismaRaw}=await import('@/lib/storage/prisma');await prismaRaw.$disconnect();isolated.dispose();});
