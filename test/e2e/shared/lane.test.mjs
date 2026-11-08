import test from 'node:test';import assert from 'node:assert/strict';import {laneConfig,newTraceRows} from './lane.mjs';
test('PR and daily retain distinct stable identities and data homes across runs',()=>{
 const a=laneConfig('pr','/tmp/e2e-state'),b=laneConfig('daily','/tmp/e2e-state');assert.equal(a.username,'test_e2e_pr@example.com');assert.equal(b.username,'test_e2e_daily@example.com');assert.notEqual(a.appHome,b.appHome);assert.deepEqual(a,laneConfig('pr','/tmp/e2e-state'));assert.throws(()=>laneConfig('../pr','/tmp/x'));assert.throws(()=>laneConfig('pr','/'));
});
test('history remains queryable but is excluded from this run trace assertions',()=>{
 assert.deepEqual(newTraceRows([{taskId:'old'},{taskId:'new'}],['old']),[{taskId:'new'}]);
});
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {acquireLane} from './lane.mjs';
test('lane lock prevents concurrent runs and next run snapshots data plus payloads',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-lane-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const lane=laneConfig('pr',root);const first=acquireLane(lane,'first');assert.throws(()=>acquireLane(lane,'other'));fs.mkdirSync(path.join(lane.appHome,'payloads'),{recursive:true});fs.writeFileSync(path.join(lane.appHome,'payloads','trace'),'old body');first.release();
 const second=acquireLane(lane,'second');assert.equal(fs.readFileSync(path.join(second.backup,'payloads','trace'),'utf8'),'old body');assert.equal(fs.readFileSync(path.join(lane.appHome,'payloads','trace'),'utf8'),'old body');second.release();
});
test('configured account cannot silently take over a previous lane and keeps its history unchanged',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-lane-identity-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const old=laneConfig('pr',root);acquireLane(old,'old').release();fs.writeFileSync(path.join(old.appHome,'trace'),'keep');
 const changed={...old,username:'test_new@example.com'};assert.throws(()=>acquireLane(changed,'new'),/account/);assert.equal(fs.readFileSync(path.join(old.appHome,'trace'),'utf8'),'keep');assert.ok(!fs.existsSync(path.join(old.home,'run.lock')));
});
