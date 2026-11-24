import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {separateHarnessBodies,readHarnessBody,cleanupHarnessBodies} from '../src/lib/ingest/deepseek-harness-otel/body-store';
import {aggregateDeepSeekHarnessOtelEvents} from '../src/lib/ingest/deepseek-harness-otel/aggregator';
import {contextViewEvents,nativeContextBodies} from '../src/lib/ingest/deepseek-harness-otel/context-view';
import {splitNativeContextBody} from '../scripts/agent-trace-collectors/deepseek-harness/dsh-context-details.mjs';
const now=Date.now(),stamp=new Date(now).toISOString();
const event=(seq:number,type:string,body:any):any=>({user:'alice',sessionId:'s',sourceSessionId:'s',sequence:seq,eventType:type,eventTimestamp:stamp,receivedAt:stamp,body,attributes:{},resource:{},scope:{}});
const summary=()=>event(50,'compaction/summary',{compactionId:'compact-1',summary:[{type:'text',text:'x'.repeat(100)+' 保持公开 API 不变 Bearer private-token'}],rawOutput:'SECRET_RAW_OUTPUT',llmStreamCall:{text:'SECRET_CALL'}});
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'native-context-'));

test('Native summary and checkpoint preserve constraints beyond the preview and strip all duplicate bodies',()=>{
 const dir=temp();try{
  const events=[summary(),event(51,'user/message',{role:'user',source:{kind:'compact-checkpoint',compactionId:'compact-1'},content:[{type:'text',text:'prefix'},{type:'text',text:'保持公开 API 不变'}]})];
  separateHarnessBodies(events,dir);
  for(const e of events){assert.equal(e.body.contextBody.bodyStorageStatus,'stored');assert.equal(e.body.contextBody.compactionId,'compact-1');}
  assert.doesNotMatch(JSON.stringify(events),/private-token|SECRET_RAW_OUTPUT|SECRET_CALL|保持公开/);
  const body=readHarnessBody('alice','s',events[0].body.contextBody.bodyRef,dir)!;
  assert.ok(body.items[0].text.indexOf('保持公开 API 不变')>80);assert.doesNotMatch(body.items[0].text,/private-token/);
  assert.equal(readHarnessBody('bob','s',events[0].body.contextBody.bodyRef,dir),null);
  assert.equal(readHarnessBody('alice','other',events[0].body.contextBody.bodyRef,dir),null);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('Native expiry follows original event time, survives retries and cleanup, and never renews on replay',()=>{
 const dir=temp();try{
  const e=summary();e.eventTimestamp=new Date(now-6*86400000).toISOString();separateHarnessBodies([e],dir);
  const ref=e.body.contextBody.bodyRef;assert.ok(readHarnessBody('alice','s',ref,dir,now+86400000-1));
  const retry=summary();retry.eventTimestamp=e.eventTimestamp;separateHarnessBodies([retry],dir);assert.equal(retry.body.contextBody.bodyRef,ref);
  assert.equal(readHarnessBody('alice','s',ref,dir,now+86400000),null);assert.equal([...cleanupHarnessBodies(dir,now+86400000)].length,1);
  const expired=summary();expired.eventTimestamp=new Date(now-8*86400000).toISOString();separateHarnessBodies([expired],dir);
  assert.equal(expired.body.contextBody.bodyStorageStatus,'expired');assert.doesNotMatch(JSON.stringify(expired),/保持公开/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('Native body validates attachment ownership, rejects malformed expiry, and truncates UTF-8 safely',()=>{
 const dir=temp();try{
  const e=summary(),native=splitNativeContextBody(e.eventType,e.body,'s',50,now)!;
  e.body={...native.body,contextBody:{...native.attachment,sourceSessionId:'other'}};separateHarnessBodies([e],dir);
  assert.equal(e.body.contextBody.bodyStorageStatus,'not-collected');assert.doesNotMatch(JSON.stringify(e),/private-token/);
  const invalid=summary();invalid.body={...native.body,contextBody:{...native.attachment,expiresAt:'invalid'}};assert.doesNotThrow(()=>separateHarnessBodies([invalid],dir));
  const large=summary();large.body.summary='中'.repeat(4000);separateHarnessBodies([large],dir);
  const body=readHarnessBody('alice','s',large.body.contextBody.bodyRef,dir)!;
  assert.equal(large.body.contextBody.truncated,true);assert.ok(Buffer.byteLength(body.items[0].text)<=8192);assert.ok(!body.items[0].text.includes('�'));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('Native body quota admission fails open and never leaves text in the event',()=>{
 const dir=temp();try{
  const suffix='a'.repeat(64)+'-00000000-0000-4000-8000-000000000000.json';const file=path.join(dir,`${now+60000}-${suffix}`);
  const fd=fs.openSync(file,'wx');fs.ftruncateSync(fd,268435456);fs.closeSync(fd);
  const e=summary();separateHarnessBodies([e],dir);assert.equal(e.body.contextBody.bodyStorageStatus,'quota-rejected');assert.doesNotMatch(JSON.stringify(e),/保持公开/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('Aggregation binds source-native text references and projection events by session, sequence and compaction ID',()=>{
 const dir=temp();try{
  const events=[summary(),event(51,'user/message',{source:{kind:'compact-checkpoint',compactionId:'compact-1'},content:'checkpoint'}),event(62,'assistant/message',{turn:3,step:1,message:{role:'assistant',content:[{type:'text',text:'ok'}]}})];
  separateHarnessBodies(events,dir);const record=aggregateDeepSeekHarnessOtelEvents('s',events)!;
  const request=(record.interactions as any[]).flatMap(i=>i.harnessRequests??[])[0];assert.equal(nativeContextBodies(request).length,2);
  request.dshContext={schemaVersion:1,status:'available',source:'dsh-context',version:'0.85.1',sourceSessionId:'s',responseEventSequence:62,turn:3,step:1,approximate:true,total:7,categories:{system:1,tools:1,user:1,inject:1,skill:1,assistant:1,tool:1},events:[{seq:50,kind:'compaction'}]};
  const cards=contextViewEvents([{key:'r',request}]);assert.equal(cards[0].bodies?.length,2);
  request.contextEvents[1].body.contextBody.compactionId='another';assert.equal(contextViewEvents([{key:'r',request}])[0].bodies?.length,1);
  assert.doesNotMatch(JSON.stringify(record),/保持公开|private-token|SECRET_RAW_OUTPUT/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('Queued native attachments lose body text at their fixed expiry',async()=>{
 const {scrubExpiredOutboxBodies}=await import('../scripts/agent-trace-collectors/deepseek-harness/index.js');const dir=temp();
 const v=(x:any):any=>Array.isArray(x)?{arrayValue:{values:x.map(v)}}:x&&typeof x==='object'?{kvlistValue:{values:Object.entries(x).map(([key,value])=>({key,value:v(value)}))}}:{stringValue:String(x)};
 try{const file=path.join(dir,'queued.json');fs.writeFileSync(file,JSON.stringify({agentInsightBodyExpiresAt:new Date(now-1).toISOString(),resourceLogs:[{scopeLogs:[{logRecords:[{body:v({contextBody:{items:[{text:'PRIVATE_QUEUED_TEXT',bodyStatus:'available'}]}})}]}]}]}));scrubExpiredOutboxBodies(dir,now);assert.doesNotMatch(fs.readFileSync(file,'utf8'),/PRIVATE_QUEUED_TEXT/);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('Live exporter sends only redacted bounded native attachments through existing OTLP transport',async()=>{
 const {registerLiveExporter}=await import('../scripts/agent-trace-collectors/deepseek-harness/index.js');
 const {normalizeDeepSeekHarnessOtlpLogs}=await import('../src/lib/ingest/deepseek-harness-otel/otlp-json');
 const dir=temp(),originalFetch=globalThis.fetch,previous={url:process.env.AGENT_INSIGHT_BASE_URL,key:process.env.AGENT_INSIGHT_API_KEY};
 const effects:Array<()=>void|Promise<void>>=[];let listener:any;const sent:any[]=[];
 process.env.AGENT_INSIGHT_BASE_URL='http://local-test.invalid';process.env.AGENT_INSIGHT_API_KEY='test-only-key';
 globalThis.fetch=async(_url:any,init:any)=>{sent.push(JSON.parse(init.body));return Response.json({ok:true})};
 try{
  registerLiveExporter({logger:{warn(){}},on(_name:string,fn:any){listener=fn},effect(fn:any){effects.push(fn())}}, {telemetryDirectory:dir,contextSource:async()=>({status:'not-installed'})});
  await new Promise(resolve=>setImmediate(resolve));
  const e=summary();e.body.summary='Bearer private-token '+'中'.repeat(4000);listener({id:'s'},{type:e.eventType,seq:e.sequence,time:now,data:e.body});
  for(let i=0;i<20&&!sent.length;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(sent.length,1);
  const events=normalizeDeepSeekHarnessOtlpLogs(sent[0],{receivedAt:stamp,authenticatedUser:'alice'});
  assert.equal(events.length,1);assert.doesNotMatch(JSON.stringify(sent),/private-token|SECRET_RAW_OUTPUT|SECRET_CALL/);
  const attachment=events[0].body.contextBody;assert.equal(attachment.items[0].bodyStatus,'truncated');assert.ok(Buffer.byteLength(attachment.items[0].text)<=8192);
  assert.equal(attachment.expiresAt,new Date(now+7*86400000).toISOString());
 }finally{
  for(const cleanup of effects)if(typeof cleanup==='function')await cleanup();globalThis.fetch=originalFetch;
  if(previous.url===undefined)delete process.env.AGENT_INSIGHT_BASE_URL;else process.env.AGENT_INSIGHT_BASE_URL=previous.url;
  if(previous.key===undefined)delete process.env.AGENT_INSIGHT_API_KEY;else process.env.AGENT_INSIGHT_API_KEY=previous.key;
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
