import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Queue} from './queue.mjs';import {executeProbe} from './probe.mjs';
const {probeCycle,recoverStaleLock}=await import('./probe-daemon-core.mjs').catch(()=>({}));
const job={id:'a'.repeat(32),repository:'gyctl/agent-insight',pr:1,mode:'probe',headSha:'b'.repeat(40),baseSha:'c'.repeat(40)};
test('persistent probe retries publication after an outage without rerunning completed work',async t=>{
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-daemon-')),queue=new Queue(path.join(state,'queue.sqlite'));t.after(()=>{queue.close();fs.rmSync(state,{recursive:true,force:true});});queue.enqueue(job);let executions=0,attempts=0,now=10000;
 const options={queue,state,now:()=>now,runWorker:async()=>{executions++;const current=queue.claim();const work=path.join(state,'jobs',current.id);fs.mkdirSync(work,{recursive:true});const report=await executeProbe(current,work);fs.writeFileSync(path.join(work,'report.json'),JSON.stringify(report));queue.finish(current.id,'COMPLETED',report);},publish:async()=>{attempts++;if(attempts===1)throw Error('temporary API outage');return {status:'PUBLISHED',commentId:9};}};
 assert.equal(typeof probeCycle,'function');await probeCycle(options);assert.equal(executions,1);assert.equal(attempts,1);assert.equal(fs.existsSync(path.join(state,'jobs',job.id,'delivery.json')),false);
 await probeCycle(options);assert.equal(attempts,1);now+=60001;await probeCycle(options);assert.equal(attempts,2);assert.equal(executions,1);assert.equal(JSON.parse(fs.readFileSync(path.join(state,'jobs',job.id,'delivery.json'))).status,'PUBLISHED');await probeCycle(options);assert.equal(attempts,2);
});
test('probe daemon refuses business jobs before launching any worker',async t=>{
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-daemon-mode-')),queue=new Queue(path.join(state,'queue.sqlite'));t.after(()=>{queue.close();fs.rmSync(state,{recursive:true,force:true});});queue.enqueue({...job,mode:'real'});
 assert.equal(typeof probeCycle,'function');await assert.rejects(()=>probeCycle({queue,state,runWorker:()=>assert.fail('must not run'),publish:()=>assert.fail('must not publish')}),/probe/);
});
test('lock recovery removes only dead task locks and refuses live or malformed owners',t=>{
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-daemon-lock-'));t.after(()=>fs.rmSync(state,{recursive:true,force:true}));const file=path.join(state,'worker.lock');fs.writeFileSync(file,'12345');assert.equal(typeof recoverStaleLock,'function');assert.throws(()=>recoverStaleLock(state,'worker.lock',()=>true),/running/);assert.ok(fs.existsSync(file));assert.equal(recoverStaleLock(state,'worker.lock',()=>false),true);fs.writeFileSync(file,'broken');assert.throws(()=>recoverStaleLock(state,'worker.lock',()=>false),/Invalid/);assert.throws(()=>recoverStaleLock(state,'../unrelated',()=>false),/Invalid/);
});
test('publication recovers a committed queue result if a crash happened before report file creation',async t=>{
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-daemon-report-')),queue=new Queue(path.join(state,'queue.sqlite'));t.after(()=>{queue.close();fs.rmSync(state,{recursive:true,force:true});});queue.enqueue(job);queue.claim();const work=path.join(state,'jobs',job.id);fs.mkdirSync(work,{recursive:true});const report=await executeProbe(job,work);queue.finish(job.id,'COMPLETED',report);let delivered=0;
 await probeCycle({queue,state,runWorker:()=>assert.fail('completed probe must not run twice'),publish:async(j,r)=>{assert.equal(r.runId,report.runId);delivered++;return {status:'PUBLISHED',commentId:10};}});assert.equal(delivered,1);assert.equal(JSON.parse(fs.readFileSync(path.join(work,'report.json'))).status,'PASS');
});
test('publication repairs truncated report and delivery files from the committed queue result',async t=>{
 for(const damaged of ['report.json','delivery.json']){
  const state=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-daemon-truncated-')),queue=new Queue(path.join(state,'queue.sqlite'));t.after(()=>{queue.close();fs.rmSync(state,{recursive:true,force:true});});queue.enqueue(job);queue.claim();const work=path.join(state,'jobs',job.id);fs.mkdirSync(work,{recursive:true});const report=await executeProbe(job,work);queue.finish(job.id,'COMPLETED',report);fs.writeFileSync(path.join(work,'report.json'),JSON.stringify(report));fs.writeFileSync(path.join(work,damaged),'{');let calls=0;
  await probeCycle({queue,state,runWorker:()=>assert.fail('must not rerun'),publish:async()=>{calls++;return {status:'ALREADY_PUBLISHED',commentId:12};}});assert.equal(calls,1);assert.equal(JSON.parse(fs.readFileSync(path.join(work,'delivery.json'))).commentId,12);
 }
});
test('real daemon publishes completed real jobs and never reruns them for a delivery retry',async t=>{
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-real-daemon-')),queue=new Queue(path.join(state,'queue.sqlite'));t.after(()=>{queue.close();fs.rmSync(state,{recursive:true,force:true});});const real={...job,mode:'real',profile:'core-five'};queue.enqueue(real);let executions=0,deliveries=0;
 const options={queue,state,allowedModes:['probe','real'],runWorker:async()=>{executions++;const claimed=queue.claim();queue.finish(claimed.id,'COMPLETED',{status:'FAIL',selected:['001','002','003','004','005']});},publish:async(j,r)=>{deliveries++;assert.equal(j.mode,'real');assert.equal(r.status,'FAIL');return {status:'PUBLISHED',commentId:44};}};
 await probeCycle(options);await probeCycle(options);assert.equal(executions,1);assert.equal(deliveries,1);
});
