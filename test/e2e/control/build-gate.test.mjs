import test from 'node:test';import assert from 'node:assert/strict';
import {gateProductionBuild} from './build-gate.mjs';
import {loadExecutionConfig} from '../shared/config.mjs';
const config=loadExecutionConfig(),options={executionConfig:config,testedSha:'a'.repeat(40),job:{id:'gate',runId:'gate',mode:'mixed',caseIds:config.cases}};
test('failed compilation stops UT and every E2E before any group is started',async()=>{
 let calls=0;const report=await gateProductionBuild(options,{build:async()=>({status:'FAIL',exitCode:1,reason:'compiler error'}),run:async()=>{calls++;throw Error('must not run')}});
 assert.equal(calls,0);assert.equal(report.status,'FAIL');assert.equal(report.productionBuild.status,'FAIL');assert.equal(report.npmTest.status,'NOT_RUN');assert.ok(report.scenarios.every(row=>row.status==='NOT_RUN'));assert.match(report.scenarios[0].reason,/编译/);
});
test('compilation success is retained in final report and passed to the runtime',async()=>{
 const build={status:'PASS',buildId:'one',sourceFingerprint:'f'.repeat(64),artifactDirectory:'/artifact'};let count=0;
 const report=await gateProductionBuild(options,{build:async()=>build,run:async input=>{count++;assert.equal(input.productionBuild,build);return {status:'PASS'}}});
 assert.equal(count,1);assert.equal(report.productionBuild.buildId,'one');assert.equal(report.productionBuild.artifactDirectory,undefined);
});
test('preflight failure does not read credentials or run later steps',async()=>{
 const report=await gateProductionBuild(options,{build:async()=>{throw Error('image unavailable')},run:()=>assert.fail()});assert.equal(report.status,'BLOCKED');assert.equal(report.npmTest.status,'NOT_RUN');
});
test('later controller failure still retains the completed production build result',async()=>{
 const report=await gateProductionBuild(options,{build:async()=>({status:'PASS',buildId:'one'}),run:async()=>{throw Error('runtime preparation failed')}});assert.equal(report.productionBuild.status,'PASS');assert.equal(report.productionBuild.buildId,'one');assert.equal(report.status,'BLOCKED');assert.equal(report.npmTest.status,'BLOCKED');
});
