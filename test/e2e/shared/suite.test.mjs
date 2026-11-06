import test from 'node:test';
import assert from 'node:assert/strict';
import { executeSuite, parseUtResult, renderSummary } from './suite.mjs';
import { requiredStagesFor } from './core.mjs';

const pass = id => ({ id, status: 'PASS', stages: requiredStagesFor(id).map(id => ({ id, status: 'PASS' })) });
test('suite attempts all active real cases and continues after independent failure', async () => {
  const called = [];
  const report = await executeSuite({ mode: 'real', runCase: async id => { called.push(id); if(id === '002') throw Error('failed'); return pass(id); } });
  assert.deepEqual(called, ['001','002','003','004','006']);
  assert.equal(report.scenarios[1].status, 'FAIL');
  assert.equal(report.scenarios[5].status, 'PASS');
  assert.equal(report.status, 'FAIL');
});
test('unimplemented mock is blocked without calling the real runner', async () => {
  const report = await executeSuite({ mode: 'mock', runCase: () => { throw Error('must not run'); } });
  assert.equal(report.scenarios.filter(s => s.status === 'BLOCKED').length, 5);
  assert.equal(report.status, 'BLOCKED');
});
test('a claimed PASS without required stages cannot pass', async () => {
  const report = await executeSuite({ mode: 'real', selected: ['002'], runCase: async () => ({ status:'PASS', stages:[] }) });
  assert.equal(report.scenarios[1].status, 'PARTIAL');
  assert.notEqual(report.status, 'PASS');
});
test('UT distinguishes full failures, missing summaries, interrupted lower bounds and skipped tests', () => {
  const log = 'ℹ tests 5\nℹ pass 3\nℹ fail 1\nℹ cancelled 0\nℹ skipped 1\nℹ todo 0\n';
  assert.deepEqual(parseUtResult(log, {code:1}).observedSummary, {tests:5,pass:3,fail:1,cancelled:0,skipped:1,todo:0});
  assert.equal(parseUtResult(log,{code:1}).fullSuiteComplete,true);
  assert.equal(parseUtResult(log,{code:null,expired:true}).fullSuiteComplete,false);
  assert.equal(parseUtResult(log,{code:null,expired:true}).interrupted,true);
  assert.equal(parseUtResult('',{code:0}).status,'BLOCKED');
  assert.equal(parseUtResult(log.replace('fail 1','fail 0'),{code:0}).status,'BLOCKED');
});
test('UT report keeps failed case names and source locations without raw stack traces',()=>{
 const result=parseUtResult('test at test/example.test.ts:10:1\n✖ rejects invalid input (1.5ms)\n  Error: private raw stack\nℹ tests 1\nℹ pass 0\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n',{code:1});
 assert.deepEqual(result.failures,[{file:'test/example.test.ts:10:1',title:'rejects invalid input'}]);
 assert.ok(!JSON.stringify(result).includes('private raw stack'));
});
test('suite preserves UT failures and produces a concise escaped summary', async () => {
  const r = await executeSuite({mode:'real',selected:['002'],runCase:async id=>pass(id), runUt:async()=>({status:'FAIL',fullSuiteComplete:true,observedSummary:{tests:1,pass:0,fail:1,skipped:0,cancelled:0},interrupted:false})});
  assert.equal(r.status,'FAIL');r.scenarios[1].reason='<script>bad</script>';
  assert.ok(renderSummary(r).html.includes('&lt;script&gt;'));
  assert.ok(renderSummary(r).markdown.includes('UT'));
});
test('UT with every test skipped has no passing evidence',()=>{
 const result=parseUtResult('ℹ tests 2\nℹ pass 0\nℹ fail 0\nℹ cancelled 0\nℹ skipped 2\nℹ todo 0\n',{code:0});
 assert.equal(result.fullSuiteComplete,true);assert.equal(result.status,'BLOCKED');
});
test('summary exposes observed OOM without reclassifying business failures',()=>{
 const r={mode:'real',status:'FAIL',scenarios:[{id:'003',title:'Skill',status:'FAIL'}],npmTest:{status:'NOT_RUN'},resources:{'memory.events':'oom 2\noom_kill 1\n'}};
 const view=renderSummary(r);assert.match(view.html,/OOM.*1/);assert.match(view.markdown,/OOM.*1/);assert.equal(r.scenarios[0].status,'FAIL');
 assert.doesNotMatch(renderSummary({...r,resources:{'memory.events':'oom 0\noom_kill 0\n'}}).html,/发生 OOM/);
});
test('UT file deadline cannot claim complete execution merely because the runner printed totals',()=>{
 const r=parseUtResult('E2E_UT_FILE_TIMEOUT {"file":"/work/test/leak.test.ts","timeoutMs":300000} test file timeout\nℹ tests 2\nℹ pass 1\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n',{code:1});
 assert.deepEqual(r.fileTimeouts,[{file:'/work/test/leak.test.ts',timeoutMs:300000}]);assert.equal(r.runnerCompleted,true);assert.equal(r.fullSuiteComplete,false);assert.equal(r.interrupted,true);assert.equal(r.countsAreLowerBound,true);assert.equal(r.status,'FAIL');
});
test('standalone report labels manual server snapshots instead of claiming a PR check',()=>{
 const view=renderSummary({runId:'server-run',executionOrigin:'server-isolated-source-snapshot',mode:'real',status:'FAIL',scenarios:[],npmTest:{status:'NOT_RUN'}});
 assert.match(view.html,/服务器源码快照验证（非 Webhook PR 检查）/);assert.match(view.html,/server-run/);assert.match(view.markdown,/服务器源码快照验证/);
});

test('mock suite executes all active adapters without using real model runner', async () => {
 const called=[];
 const report=await executeSuite({mode:'mock',runCase:()=>{throw Error('real fallback forbidden');},runMockCase:async id=>{called.push(id);return pass(id);}});
 assert.deepEqual(called,['001','002','003','004','006']);assert.equal(report.status,'PASS');
});
test('suite records separate UT and E2E timestamps for PR timing',async()=>{
 const r=await executeSuite({mode:'mock',selected:['002'],runMockCase:async id=>pass(id),runUt:async()=>({status:'PASS',fullSuiteComplete:true})});
 assert.ok(r.npmTest.startedAt&&r.npmTest.endedAt);assert.ok(r.e2eStartedAt&&r.e2eEndedAt);assert.ok(r.npmTest.durationMs>=0);assert.ok(r.e2eDurationMs>=0);
});

test('mixed suite dispatches each effective mode without real fallback and exposes modes',async()=>{
 const calls=[];const report=await executeSuite({mode:'mixed',selected:['001','004'],caseModes:{'001':'mock','004':'real'},runMockCase:async id=>{calls.push('mock:'+id);return pass(id)},runCase:async id=>{calls.push('real:'+id);return pass(id)}});assert.deepEqual(calls,['mock:001','real:004']);assert.equal(report.status,'PASS');assert.equal(report.scenarios[0].mode,'mock');assert.equal(report.scenarios[3].mode,'real');assert.match(renderSummary(report).html,/mock/);assert.match(renderSummary(report).html,/real/);
 await assert.rejects(executeSuite({mode:'mixed',selected:['001'],caseModes:{},runCase:async id=>pass(id)}),/mode/i);
});

test('suite compile failure retains report and skips UT and cases',async()=>{
 let executed=0;const report=await executeSuite({mode:'mock',selected:['001'],runBuild:async()=>({status:'FAIL',exitCode:1}),runUt:async()=>{executed++},runMockCase:async()=>{executed++}});
 assert.equal(executed,0);assert.equal(report.status,'FAIL');assert.equal(report.npmTest.status,'NOT_RUN');assert.equal(report.scenarios[0].status,'NOT_RUN');assert.match(renderSummary(report).markdown,/生产编译：失败/);
});
