import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const modulePromise = import(pathToFileURL(path.resolve('scripts/agent-trace-collectors/deepseek-harness/retention-soak.mjs')).href);
const start = Date.parse('2026-11-18T09:04:41.601Z');
const config = { capturedAt:new Date(start).toISOString(), expiresAt:new Date(start+604800000).toISOString(), expectedDurationMs:604800000, intervalMs:3600000, cleanupGraceMs:86400000, fileSha256:'original' };
const good = { filePresent:true, fileSha256:'original', apiStatus:200, sentinelPresent:true, expiresAtMatches:true, noStore:true };

test('Real-clock retention assessor requires readable original content before expiry',async()=>{
 const {assessRetentionSample:assess,summarizeRetentionRun:summarize}=await modulePromise;
 assert.equal(assess(config,good,start),'retained-readable');
 assert.equal(assess(config,good,start+604800000-1),'retained-readable');
 assert.equal(assess(config,{...good,filePresent:false},start),'failed-early-deletion');
 assert.equal(assess(config,{...good,fileSha256:'changed'},start),'failed-file-changed');
 for(const field of ['sentinelPresent','expiresAtMatches','noStore']) assert.equal(assess(config,{...good,[field]:false},start),'failed-body-contract');
 assert.equal(assess(config,{...good,apiStatus:410},start),'failed-early-unreadable');
});

test('Expiry requires HTTP410/no-store and eventual physical removal',async()=>{
 const {assessRetentionSample:assess,summarizeRetentionRun:summarize}=await modulePromise;
 const now=start+604800000;
 assert.equal(assess(config,good,now),'failed-readable-after-expiry');
 assert.equal(assess(config,{...good,apiStatus:410},now),'expired-cleanup-pending');
 assert.equal(assess(config,{...good,apiStatus:410,filePresent:false},now),'expired-and-cleaned');
 assert.equal(assess(config,{...good,apiStatus:404,filePresent:false},now),'failed-expiry-contract');
 assert.equal(assess(config,{...good,apiStatus:410,noStore:false},now),'failed-expiry-contract');
});

test('Unavailable service, identity and wrong clock cannot prove retention',async()=>{
 const {assessRetentionSample:assess,summarizeRetentionRun:summarize}=await modulePromise;
 for(const status of [0,500,503])assert.equal(assess(config,{...good,apiStatus:status},start),'inconclusive-service');
 for(const status of [401,403])assert.equal(assess(config,{...good,apiStatus:status},start),'inconclusive-identity');
 assert.equal(assess(config,good,start-1),'inconclusive-clock-or-contract');
 assert.equal(assess({...config,expiresAt:new Date(start+60000).toISOString()},good,start),'inconclusive-clock-or-contract');
});

test('Seven-day result stays pending until expiry and never hides missing hourly samples',async()=>{
 const {assessRetentionSample:assess,summarizeRetentionRun:summarize}=await modulePromise;
 const row=(hours:number,verdict='retained-readable',gapMs=3600000)=>({at:new Date(start+hours*3600000).toISOString(),gapMs,verdict});
 assert.equal(summarize(config,[row(0)]).status,'running');
 const complete=Array.from({length:169},(_,i)=>row(i,i===168?'expired-and-cleaned':'retained-readable'));
 assert.equal(summarize(config,complete).status,'completed-observed');
 assert.equal(summarize(config,[row(0),row(168,'expired-and-cleaned',604800000)]).status,'completed-with-gaps');
 assert.equal(summarize(config,[row(0),row(1,'inconclusive-service'),...complete.slice(2)]).status,'completed-with-gaps');
 assert.equal(summarize(config,[row(0,'failed-early-deletion'),...complete.slice(1)]).status,'failed');
 assert.equal(summarize(config,[row(0),row(192,'expired-cleanup-pending',192*3600000)]).status,'incomplete-after-deadline');
});
