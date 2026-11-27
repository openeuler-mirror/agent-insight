import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {makeJob} from './receiver.mjs';
import {publishResult} from './publish.mjs';
import {runQueuedJob} from './worker-core.mjs';
const probe=await import('./probe.mjs').catch(()=>({}));
const job={id:'f'.repeat(32),repository:'gyctl/agent-insight',pr:1,mode:'probe',headSha:'a'.repeat(40),baseSha:'b'.repeat(40)};
test('probe executes a fixed child without credentials and explicitly leaves business tests unexecuted',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-probe-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 assert.equal(typeof probe.executeProbe,'function');
 const report=await probe.executeProbe(job,dir);
 assert.equal(typeof report.executionHost,'string');assert.ok(report.executionHost.length>0);
 assert.equal(report.status,'PASS');assert.equal(report.kind,'pipeline-probe');assert.equal(report.process.exitCode,0);
 assert.equal(report.process.proof.jobId,job.id);assert.equal(report.businessTestsExecuted,false);
 assert.equal(report.npmTest.status,'NOT_RUN');assert.ok(report.scenarios.every(s=>s.status==='NOT_RUN'));
 const view=probe.renderProbe(report,job);assert.match(view.markdown,/固定子进程探针通过/);assert.match(view.markdown,/执行节点：/);assert.match(view.markdown,/五个业务用例.*未执行/);assert.match(view.markdown,/delivery.json/);assert.doesNotMatch(view.markdown,/评论通过 API 回写并读回核对/);
});
test('probe mode has its own queue identity and cannot be mistaken for real or mock execution',()=>{
 const event={repository:job.repository,pr:1,headSha:job.headSha};
 const pr={number:1,state:'open',head:{sha:job.headSha,repo:{full_name:job.repository}},base:{sha:job.baseSha,repo:{full_name:job.repository}}};
 const item=makeJob(event,pr,{mode:'probe'});assert.equal(item.mode,'probe');assert.notEqual(item.id,makeJob(event,pr).id);
});
test('probe publication uses the existing read-back and dedup path while rejecting invented business passes',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-probe-publish-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 assert.equal(typeof probe.executeProbe,'function');const report=await probe.executeProbe(job,dir);const comments=[];
 const api={repoPath:()=>'/repos/'+job.repository,readPull:async()=>({state:'open',head:{sha:job.headSha},base:{sha:job.baseSha}}),request:async(method,route)=>route.includes('/comments/')?comments[0]:comments,createComment:async(repo,n,body)=>{const c={id:22,body};comments.push(c);return c;}};
 assert.equal((await publishResult(api,job,report)).status,'PUBLISHED');assert.match(comments[0].body,/固定子进程探针通过/);assert.match(comments[0].body,/UT.*未执行/);
 assert.equal((await publishResult(api,job,report)).status,'ALREADY_PUBLISHED');assert.equal(comments.length,1);
 for(const mutate of [r=>r.scenarios[0].status='PASS',r=>r.process.exitCode=1,r=>r.process.proof.jobId='other',r=>r.businessTestsExecuted=true,r=>r.npmTest.status='PASS']){
  const altered=structuredClone(report);mutate(altered);await assert.rejects(()=>publishResult(api,job,altered));
 }
});
test('probe API verification outages retain completed execution or produce a publishable failure report',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-probe-verify-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const before=await runQueuedJob(job,{isCurrent:()=>true,readPull:async()=>{throw Error('temporary API outage');},execute:()=>assert.fail('must not execute before verification')});assert.equal(before.state,'ERROR');assert.equal(before.result.kind,'pipeline-probe');assert.equal(before.result.process.executed,false);probe.assertProbeReport(before.result,job);assert.doesNotMatch(probe.renderProbe(before.result,job).markdown,/子进程执行后/);
 const report=await probe.executeProbe(job,dir);let reads=0;const after=await runQueuedJob(job,{isCurrent:()=>true,readPull:async()=>{if(++reads===2)throw Error('temporary API outage');return {state:'open',head:{sha:job.headSha},base:{sha:job.baseSha}};},execute:async()=>report});assert.equal(after.state,'COMPLETED');assert.equal(after.result,report);assert.equal(after.verificationPending,true);
});
