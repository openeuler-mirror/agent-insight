import assert from 'node:assert/strict';
import test from 'node:test';
import {GET} from '../src/app/api/observe/session/route';

test('Body endpoint rejects a spoofed user query before looking up any Trace',async()=>{
 const response=await GET(new Request('http://localhost/api/observe/session?taskId=missing&view=context-body&sourceSessionId=s&contextRequestId=attempt&user=alice'));
 assert.equal(response.status,401);assert.equal(response.headers.get('cache-control'),'no-store');
});
test('Body endpoint rejects anonymous identity even when a Trace identifier is supplied',async()=>{
 const response=await GET(new Request('http://localhost/api/observe/session?taskId=missing&view=context-body'));
 assert.equal(response.status,401);
});

test('Body API verifies owner and request membership with authenticated identities',async()=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path'),{randomUUID}=await import('node:crypto');
 const {db}=await import('../src/lib/storage/prisma');const {saveHarnessBody}=await import('../src/lib/ingest/deepseek-harness-otel/body-store');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'harness-body-api-')),task='body-auth-'+randomUUID(),attempt=randomUUID();
 const previous=process.env.AGENT_INSIGHT_HARNESS_BODY_DIR;
 const original={user:db.findUserByApiKey,session:db.findSessionByTaskId,executions:db.findExecutions};
 process.env.AGENT_INSIGHT_HARNESS_BODY_DIR=root;
 (db as any).findUserByApiKey=async(key:string)=>key==='alice-key'?{username:'alice'}:key==='bob-key'?{username:'bob'}:null;
 (db as any).findSessionByTaskId=async(id:string)=>id===task?{taskId:task,user:'alice',interactions:JSON.stringify([{role:'assistant',content:'response',harnessRequests:[{sourceSessionId:'s',eventSequence:18,turn:1,step:1,membership:{bodyRef:attempt}}]}])}:null;
 (db as any).findExecutions=async()=>[];
 try{
  saveHarnessBody('alice',{schemaVersion:1,sourceSessionId:'s',attemptId:attempt,expiresAt:new Date(Date.now()+60000).toISOString(),items:[{itemId:'m',text:'private constraint'}]});
  const url=`http://localhost/api/observe/session?taskId=${task}&view=context-body&sourceSessionId=s&contextRequestId=${attempt}`;
  const owner=await GET(new Request(url,{headers:{'x-witty-api-key':'alice-key'}}));assert.equal(owner.status,200);assert.equal(owner.headers.get('cache-control'),'no-store');assert.ok(JSON.stringify(await owner.json()).includes('private constraint'));
  assert.equal((await GET(new Request(url,{headers:{'x-witty-api-key':'bob-key'}}))).status,403);
  assert.equal((await GET(new Request(url.replace('sourceSessionId=s','sourceSessionId=other'),{headers:{'x-witty-api-key':'alice-key'}}))).status,404);
  assert.equal((await GET(new Request(url+'&user=alice'))).status,401);
  const clock=Date.now;
  try {
   Date.now=()=>clock()+120000;
   const expired=await GET(new Request(url,{headers:{'x-witty-api-key':'alice-key'}}));
   assert.equal(expired.status,410);assert.equal(expired.headers.get('cache-control'),'no-store');
   assert.ok(!JSON.stringify(await expired.json()).includes('private constraint'));
  }finally{Date.now=clock;}
  (db as any).findSessionByTaskId=async(id:string)=>id===task?{taskId:task,user:'alice',interactions:JSON.stringify([{role:'assistant',content:'response',harnessRequests:[{sourceSessionId:'s',eventSequence:18,turn:1,step:1,dshContext:{details:{bodyRef:attempt}}}]}])}:null;
  assert.equal((await GET(new Request(url,{headers:{'x-witty-api-key':'alice-key'}}))).status,200);
  assert.equal((await GET(new Request(url,{headers:{'x-witty-api-key':'bob-key'}}))).status,403);
  assert.equal((await GET(new Request(url.replace('sourceSessionId=s','sourceSessionId=other'),{headers:{'x-witty-api-key':'alice-key'}}))).status,404);
  (db as any).findSessionByTaskId=async(id:string)=>id===task?{taskId:task,user:'alice',interactions:JSON.stringify([{role:'assistant',content:'response',harnessRequests:[{sourceSessionId:'s',eventSequence:62,turn:3,step:1,contextEvents:[{sourceSessionId:'s',eventSequence:50,eventType:'compaction/summary',body:{contextBody:{source:'harness-native',sourceSessionId:'s',sourceEventSeq:50,kind:'compaction-summary',bodyRef:attempt}}}]}]}])}:null;
  const native=await GET(new Request(url,{headers:{'x-witty-api-key':'alice-key'}}));assert.equal(native.status,200);assert.equal(native.headers.get('cache-control'),'no-store');
  assert.equal((await GET(new Request(url,{headers:{'x-witty-api-key':'bob-key'}}))).status,403);
  assert.equal((await GET(new Request(url.replace('sourceSessionId=s','sourceSessionId=other'),{headers:{'x-witty-api-key':'alice-key'}}))).status,404);
  assert.equal((await GET(new Request(url.replace(attempt,randomUUID()),{headers:{'x-witty-api-key':'alice-key'}}))).status,404);
  (db as any).findSessionByTaskId=async()=>null;
  assert.equal((await GET(new Request(url,{headers:{'x-witty-api-key':'alice-key'}}))).status,404);
 }finally{
  (db as any).findUserByApiKey=original.user;(db as any).findSessionByTaskId=original.session;(db as any).findExecutions=original.executions;
  if(previous===undefined)delete process.env.AGENT_INSIGHT_HARNESS_BODY_DIR;else process.env.AGENT_INSIGHT_HARNESS_BODY_DIR=previous;
  fs.rmSync(root,{recursive:true,force:true});
 }
});
