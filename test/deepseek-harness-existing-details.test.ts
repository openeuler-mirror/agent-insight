import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {normalizeExistingContextDetails,normalizeDshContextEvent} from '../scripts/agent-trace-collectors/deepseek-harness/dsh-context-details.mjs';
import {validateDshContext} from '../src/lib/ingest/deepseek-harness-otel/context-membership';
import {readHarnessBody,separateHarnessBodies} from '../src/lib/ingest/deepseek-harness-otel/body-store';
import {DshExistingDetails} from '../src/components/observe/DshExistingDetails';
const counts={system:1,tools:2,user:3,inject:4,skill:5,assistant:6,tool:7};
const event={seq:181,data:{turn:7,step:1}};
const details=()=>normalizeExistingContextDetails('s',event,7,{ok:true,value:{viewNodes:[{seq:168,cat:'inject',name:'compact-checkpoint',text:'Bearer private-token'}, {seq:180,cat:'tool',tokens:3}],viewHeader:{seq:170,tools:[{name:'bash',tokens:10}]}}},{ok:true,value:{parts:{nodes:{nodes:[],archive:[{seq:17,cat:'tool',gone:168,tokens:20}]}}}});
const projection=(d:any)=>({schemaVersion:1,status:'available',source:'dsh-context',version:'0.85.1',sourceSessionId:'s',responseEventSequence:181,turn:7,step:1,approximate:true,total:28,categories:counts,details:d});
test('existing views preserve metadata and short source previews without claiming full bodies',()=>{
 const d=details();assert.ok(d.items);assert.equal(d.items.length,3);assert.equal(d.items[0].text,'Bearer private-token');assert.equal(d.items[1].bodyStatus,'source-body-unavailable');assert.equal(d.fullRequestBodyAvailable,false);
 assert.equal(d.items[2].gone,168);assert.equal(d.header.tools[0].name,'bash');
 const metadata=validateDshContext(projection(d),'s',181,7,1)!.details;
 assert.ok(metadata);assert.equal(JSON.stringify(metadata).includes('private-token'),false);
 assert.equal(validateDshContext(projection({...d,sourceSessionId:'other'}),'s',181,7,1)!.details,undefined);
});
test('event details preserve native plugin from/to and counts but exclude arbitrary detail text',()=>{
 assert.deepEqual(normalizeDshContextEvent({seq:192,kind:'model',from:'flash',to:'pro',detail:'PRIVATE',count:3}),{seq:192,kind:'model',count:3,from:'flash',to:'pro'});
});
test('projected previews use governed body storage, redaction, binding and expiry',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-existing-'));
 try{
  const d=details(),e:any={user:'alice',sourceSessionId:'s',eventType:'agent-insight/context',body:{responseEventSequence:181,turn:7,step:1,dshContext:projection(d)}};
  separateHarnessBodies([e],dir);const meta=e.body.dshContext.details;
  assert.equal(meta.bodyStorageStatus,'stored');assert.equal(JSON.stringify(e).includes('private-token'),false);
  const body=readHarnessBody('alice','s',meta.bodyRef,dir)!;assert.ok(body);assert.equal(body.items[0].text.includes('private-token'),false);
  assert.equal(readHarnessBody('bob','s',meta.bodyRef,dir),null);
  assert.equal(readHarnessBody('alice','s',meta.bodyRef,dir,Date.now()+8*86400000),null);
  const invalid:any={...e,body:{responseEventSequence:180,turn:7,step:1,dshContext:projection(details())}};
  separateHarnessBodies([invalid],dir);assert.equal(invalid.body.dshContext.details.status,'incompatible-or-unbound');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('first render never displays preview body before authorized loading',()=>{
 const request:any={sourceSessionId:'s',eventSequence:181,turn:7,step:1,dshContext:validateDshContext(projection(details()),'s',181,7,1)};
 const html=renderToStaticMarkup(React.createElement(DshExistingDetails,{request,taskId:'task',zh:true}));
 assert.match(html,/80 字符/);assert.match(html,/鉴权加载已有片段/);assert.doesNotMatch(html,/private-token/);assert.match(html,/归档替换点/);
});

test('expired existing-source preview text is scrubbed from queued payloads',async()=>{
 const {scrubExpiredOutboxBodies}=await import('../scripts/agent-trace-collectors/deepseek-harness/index.js');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-preview-queue-'));
 const v=(value:any):any=>Array.isArray(value)?{arrayValue:{values:value.map(v)}}:value&&typeof value==='object'?{kvlistValue:{values:Object.entries(value).map(([key,value])=>({key,value:v(value)}))}}:{stringValue:String(value)};
 try{const file=path.join(dir,'event.json');fs.writeFileSync(file,JSON.stringify({agentInsightBodyExpiresAt:'2000-01-01T00:00:00Z',resourceLogs:[{scopeLogs:[{logRecords:[{body:v({dshContext:{details:{items:[{itemId:'preview',text:'PRIVATE_QUEUE_BODY',bodyStatus:'source-preview'}]}}})}]}]}]}));
  scrubExpiredOutboxBodies(dir);const text=fs.readFileSync(file,'utf8');assert.equal(text.includes('PRIVATE_QUEUE_BODY'),false);assert.ok(text.includes('expired'));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
