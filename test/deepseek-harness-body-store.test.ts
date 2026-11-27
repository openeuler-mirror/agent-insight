import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { cleanupHarnessBodies, readHarnessBody, saveHarnessBody, separateHarnessBodies } from '../src/lib/ingest/deepseek-harness-otel/body-store';

const manifest = () => ({ schemaVersion: 1, sourceSessionId: 's', bindingStatus: 'bound', attemptId: randomUUID(), expiresAt: new Date(Date.now()+60000).toISOString(), response: { sourceSessionId: 's', eventSequence: 18 }, items: [{ itemId: 'm', text: 'Keep APIs unchanged', bodyStatus: 'available', storedBytes: 19 }] });

test('Seven-day maximum expiry cannot be extended by retries and deletion respects the exact boundary', () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'harness-seven-days-')),now=Date.now(),ttl=7*86400000;
 try {
  const m={...manifest(),expiresAt:new Date(now+ttl*3).toISOString()};
  saveHarnessBody('alice',m,dir,now);
  saveHarnessBody('alice',m,dir,now+ttl/2);
  assert.ok(readHarnessBody('alice','s',m.attemptId,dir,now+ttl-1));
  assert.equal(readHarnessBody('alice','s',m.attemptId,dir,now+ttl),null);
  assert.equal([...cleanupHarnessBodies(dir,now+ttl-1)].length,0);
  assert.equal([...cleanupHarnessBodies(dir,now+ttl,true)][0].kind,'skipped');
  assert.equal([...cleanupHarnessBodies(dir,now+ttl)][0].kind,'deleted');
  assert.equal(fs.readdirSync(dir).length,0);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('Platform global byte and file ceilings are enforced without allocating huge bodies', () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'harness-global-'));const expiry=Date.now()+60000;
 try {
  const large=path.join(dir,`${expiry}-${'a'.repeat(64)}-${randomUUID()}.json`);
  const fd=fs.openSync(large,'wx');fs.ftruncateSync(fd,268435456);fs.closeSync(fd);
  assert.throws(()=>saveHarnessBody('alice',manifest(),dir),/quota/);fs.unlinkSync(large);
  for(let i=0;i<4096;i++)fs.writeFileSync(path.join(dir,`${expiry}-${'a'.repeat(64)}-${randomUUID()}.json`),'');
  assert.throws(()=>saveHarnessBody('alice',manifest(),dir),/quota/);
  assert.equal(fs.existsSync(path.join(dir,'.write.lock')),false);
  assert.equal([...cleanupHarnessBodies(dir,expiry)].length,4096);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('Platform bodies isolate owners, deduplicate retries and reject conflicting attempts', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'harness-platform-'));
 try {
  const m=manifest(); saveHarnessBody('alice',m,root); saveHarnessBody('alice',m,root);
  assert.equal(fs.readdirSync(root).length,1);
  assert.equal(readHarnessBody('bob','s',m.attemptId,root),null);
  assert.equal(readHarnessBody('alice','child',m.attemptId,root),null);
  assert.equal(readHarnessBody('alice','s',m.attemptId,root).items[0].text,m.items[0].text);
  assert.throws(()=>saveHarnessBody('alice',{...m,items:[{...m.items[0],text:'different'}]},root),/Conflicting/);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('Platform expiry refuses reads before physical cleanup and respects dry run', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'harness-expiry-'));
 try {
  const m=manifest();saveHarnessBody('alice',m,root);
  const after=Date.now()+120000;
  assert.equal(readHarnessBody('alice','s',m.attemptId,root,after),null);
  [...cleanupHarnessBodies(root,after,true)];assert.equal(fs.readdirSync(root).length,1);
  [...cleanupHarnessBodies(root,after)];assert.equal(fs.readdirSync(root).length,0);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('Platform limits UTF8 item bytes, total request bytes and session serialized bytes', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'harness-capacity-'));
 try {
  const m=manifest();
  assert.throws(()=>saveHarnessBody('alice',{...m,items:[{text:'中'.repeat(3000)}]},root),/item body/);
  assert.throws(()=>saveHarnessBody('alice',{...m,items:Array.from({length:33},()=>({text:'x'.repeat(8192)}))},root),/request body/);
  const large={...m,items:Array.from({length:32},()=>({text:'x'.repeat(8192)}))};
  for(let i=0;i<3;i++)saveHarnessBody('alice',{...large,attemptId:randomUUID()},root);
  assert.throws(()=>saveHarnessBody('alice',{...large,attemptId:randomUUID()},root),/quota/);
  assert.equal(fs.existsSync(path.join(root,'.write.lock')),false);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('OTLP separation stores bodies while keeping plaintext out of spool metadata', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'harness-split-'));
 try {
  const m=manifest();const event={user:'alice',sourceSessionId:'s',sequence:18,body:{contextMembership:m}};
  separateHarnessBodies([event],root);
  assert.equal(JSON.stringify(event).includes('Keep APIs unchanged'),false);
  assert.equal((event.body.contextMembership as any).bodyRef,m.attemptId);
  assert.ok(readHarnessBody('alice','s',m.attemptId,root));
  const wrong={user:'alice',sourceSessionId:'s',sequence:19,body:{contextMembership:manifest()}};
  separateHarnessBodies([wrong],root);
  assert.equal((wrong.body.contextMembership as any).bodyRef,null);
  assert.equal(JSON.stringify(wrong).includes('Keep APIs unchanged'),false);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('Optional body storage failure never rejects the core telemetry event', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'harness-body-failure-'));
 try {
  fs.writeFileSync(path.join(root,'.write.lock'),'busy');
  const event={user:'alice',sourceSessionId:'s',sequence:18,body:{contextMembership:manifest(),message:{content:'Core response remains'}}};
  separateHarnessBodies([event],root);
  assert.equal(event.body.message.content,'Core response remains');
  assert.equal((event.body.contextMembership as any).bodyStorageStatus,'busy');
  assert.equal(JSON.stringify(event).includes('Keep APIs unchanged'),false);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('Concurrent platform admission stays within serialized session quota', async () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'harness-body-concurrent-'));
 const {spawn}=await import('node:child_process');
 const {pathToFileURL}=await import('node:url');
 const url=pathToFileURL(path.resolve('src/lib/ingest/deepseek-harness-otel/body-store.ts')).href;
 try {
  const code=`const {saveHarnessBody}=await import(process.argv[1]);const {randomUUID}=await import('node:crypto');try{saveHarnessBody('alice',{sourceSessionId:'s',attemptId:randomUUID(),expiresAt:new Date(Date.now()+60000).toISOString(),items:Array.from({length:32},()=>({text:'x'.repeat(8192)}))},process.argv[2]);}catch(e){if(e.code!=='EEXIST'&&!e.message.includes('quota'))throw e;}`;
  await Promise.all(Array.from({length:8},()=>new Promise<void>((resolve,reject)=>{
   const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code,url,root],{cwd:process.cwd(),stdio:'pipe'});
   let error='';child.stderr.on('data',b=>error+=b);child.on('error',reject);child.on('exit',n=>n===0?resolve():reject(new Error(error)));
  })));
  const all=fs.readdirSync(root).filter(f=>f.endsWith('.json'));
  assert.ok(all.length>=1&&all.length<=3);
  assert.ok(all.reduce((n,f)=>n+fs.statSync(path.join(root,f)).size,0)<=1048576);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('Cleanup removes aged interrupted body writes and preserves recent temporary files', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'harness-temp-'));
 try {
  const old=path.join(root,randomUUID()+'.tmp'),recent=path.join(root,randomUUID()+'.tmp');
  fs.writeFileSync(old,'expired sensitive body');fs.writeFileSync(recent,'recent');
  const prior=new Date(Date.now()-8*86400000);fs.utimesSync(old,prior,prior);
  const results=[...cleanupHarnessBodies(root)];
  assert.equal(fs.existsSync(old),false);assert.equal(fs.existsSync(recent),true);
  assert.equal(results[0].kind,'deleted');assert.ok(results[0].bytes>0);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('UTF8 body admission validates exact single and request boundaries and exact expiry', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'harness-boundaries-'));
 try {
  for(const n of [8191,8192])saveHarnessBody('alice',{...manifest(),attemptId:randomUUID(),items:[{text:'x'.repeat(n)}]},root);
  assert.throws(()=>saveHarnessBody('alice',{...manifest(),items:[{text:'x'.repeat(8193)}]},root),/item body/);
  const m=manifest();saveHarnessBody('alice',m,root);const end=Date.parse(m.expiresAt);
  assert.ok(readHarnessBody('alice','s',m.attemptId,root,end-1));assert.equal(readHarnessBody('alice','s',m.attemptId,root,end),null);
  assert.equal(saveHarnessBody('alice',m,root,end+1),null);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('Unknown context versions and malformed members cannot break or leak into core telemetry',()=>{
 for(const context of [{schemaVersion:99,items:[{text:'must not reach spool'}]},{schemaVersion:1,items:[null]}]){
  const event={user:'alice',sourceSessionId:'s',sequence:18,body:{message:{content:'normal response'},contextMembership:context}};
  separateHarnessBodies([event]);
  assert.equal(event.body.message.content,'normal response');
  assert.equal((event.body.contextMembership as any).bodyStorageStatus,'incompatible-schema');
  assert.equal(JSON.stringify(event).includes('must not reach spool'),false);
 }
});
