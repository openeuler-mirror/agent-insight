import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { verifySignature, normalizeEvent, makeJob, createReceiver } from './receiver.mjs';
import { Queue } from './queue.mjs';

const sha='a'.repeat(40), base='b'.repeat(40), secret='local-test-secret-only';
const event=(head=sha)=>({object_kind:'merge_request',object_attributes:{iid:12,state:'opened',action:'open',target:{path_with_namespace:'gyctl/agent-insight'},last_commit:{id:head}}});
const pr=(head=sha)=>({number:12,state:'open',head:{sha:head,ref:'topic',repo:{full_name:'gyctl/agent-insight'}},base:{sha:base,ref:'master',repo:{full_name:'gyctl/agent-insight'}}});
const signed=body=>'sha256='+createHmac('sha256',secret).update(body).digest('hex');
function queue(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-control-'));const q=new Queue(path.join(root,'queue.sqlite'));t.after(()=>{q.close();fs.rmSync(root,{recursive:true,force:true});});return q;}
test('webhook verifies raw bytes and rejects malformed, missing and wrong signatures',()=>{
 const raw=Buffer.from(JSON.stringify(event()));assert.equal(verifySignature(raw,signed(raw),secret),true);
 for(const sig of [undefined,'sha256=xyz','sha256='+'0'.repeat(64)])assert.equal(verifySignature(raw,sig,secret),false);
 assert.equal(verifySignature(Buffer.from(raw+' '),signed(raw),secret),false);
});
test('only open PR events in the configured target repository may enqueue exact verified commits',()=>{
 const e=normalizeEvent(event(),'gyctl/agent-insight');assert.equal(makeJob(e,pr()).headSha,sha);
 assert.equal(normalizeEvent({...event(),object_kind:'note'},'gyctl/agent-insight'),null);
 assert.equal(normalizeEvent(event(),'openeuler/agent-insight'),null);
 assert.equal(makeJob(e,pr('c'.repeat(40))),null);
 assert.throws(()=>makeJob(e,{...pr(),base:{...pr().base,sha:'master'}}),/SHA/);
});
test('persistent queue deduplicates deliveries, supersedes old commits, and preserves incomplete runs',t=>{
 const q=queue(t);const job=makeJob(normalizeEvent(event(),'gyctl/agent-insight'),pr());
 assert.equal(q.enqueue(job).created,true);assert.equal(q.enqueue(job).created,false);
 assert.equal(q.claim().id,job.id);assert.equal(q.claim(),null);
 const next=makeJob(normalizeEvent(event('c'.repeat(40)),'gyctl/agent-insight'),pr('c'.repeat(40)));
 q.enqueue(next);assert.equal(q.get(job.id).state,'SUPERSEDED');assert.equal(q.finish(job.id,'COMPLETED',{}),false);
 assert.equal(q.claim().id,next.id);q.recover();assert.equal(q.get(next.id).state,'INTERRUPTED');
});
test('receiver exercises actual HTTP signature, verification and dedup without running PR code',async t=>{
 const q=queue(t);let lookups=0;
 const server=createReceiver({secret,repository:'gyctl/agent-insight',queue:q,readPull:async()=>{lookups++;return pr();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url='http://127.0.0.1:'+server.address().port+'/webhook';const body=JSON.stringify(event());
 const send=(sig=signed(body))=>fetch(url,{method:'POST',headers:{'content-type':'application/json','x-gitcode-signature-256':sig},body});
 assert.equal((await send('bad')).status,401);assert.equal(lookups,0);
 assert.equal((await send()).status,202);assert.equal((await send()).status,200);
 assert.equal(q.list().length,1);assert.equal(q.list()[0].state,'QUEUED');
});
test('webhook defaults to real models while keeping explicit mock jobs distinct',()=>{
 const e=normalizeEvent(event(),'gyctl/agent-insight');const real=makeJob(e,pr());const mock=makeJob(e,pr(),{mode:'mock'});assert.equal(real.mode,'real');assert.equal(mock.mode,'mock');assert.notEqual(real.id,mock.id);
});
test('trusted core-five profile is immutable in queue identity and cannot be requested arbitrarily',()=>{
 const e=normalizeEvent(event(),'gyctl/agent-insight');const full=makeJob(e,pr()),five=makeJob(e,pr(),{mode:'real',profile:'core-five'});
 assert.equal(five.profile,'core-five');assert.notEqual(five.id,full.id);assert.throws(()=>makeJob(e,pr(),{profile:'just-pass'}),/profile/);
});
test('same PR version with different approved configuration is a distinct task; event payload cannot select config',async()=>{
 const {loadExecutionConfig}=await import('../shared/config.mjs');const e=normalizeEvent(event(),'gyctl/agent-insight');const first=makeJob(e,pr(),{executionConfig:loadExecutionConfig()}),next=makeJob(e,pr(),{executionConfig:loadExecutionConfig({overrides:{resources:{cpus:3}}})});assert.notEqual(first.id,next.id);assert.equal(first.configHash.length,64);assert.deepEqual(first.caseIds,['001','002','003','004','005']);assert.equal(first.runUt,true);
});
