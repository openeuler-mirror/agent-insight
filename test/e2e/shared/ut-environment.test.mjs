import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import {boundedUtEnv} from './ut-environment.mjs';
test('UT profiling preserves failure status and exposes only relative file performance data',async t=>{
 const {readUtFileMetrics}=await import('./ut-environment.mjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-ut-profile-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const project=path.join(root,'source');fs.mkdirSync(path.join(project,'test'),{recursive:true});
 fs.writeFileSync(path.join(project,'test/a.test.ts'),"const test=require('node:test');test('private-sentinel-should-not-be-exported',()=>{throw Error('private-fixture-detail');});");
 fs.writeFileSync(path.join(project,'test/b.test.ts'),"const test=require('node:test');test('pass',()=>{});");
 const metricsFile=path.join(root,'private/files.ndjson');
 const env=boundedUtEnv(root,{PATH:process.env.PATH,HOME:root},5000,2,{project,metricsFile});
 const result=spawnSync('node',['--test','test/a.test.ts','test/b.test.ts'],{env,cwd:project,encoding:'utf8',timeout:15000});
 assert.equal(result.status,1,result.stdout+result.stderr);
 const metrics=readUtFileMetrics(metricsFile);
 assert.equal(metrics.startedFiles,2,result.stdout+result.stderr);assert.equal(metrics.completedFiles,2);assert.equal(metrics.failedFiles,1);assert.equal(metrics.incompleteFiles,0);
 assert.deepEqual(metrics.files.map(row=>row.file).sort(),['test/a.test.ts','test/b.test.ts']);
 assert.ok(metrics.files.every(row=>row.durationMs>0&&row.cpuMs>=0&&row.maxRssBytes>0));
 assert.doesNotMatch(JSON.stringify(metrics),/private-sentinel|private-fixture|"pid"/);assert.ok(!JSON.stringify(metrics).includes(root));
 assert.equal(fs.statSync(metricsFile).mode&0o777,0o600);
});
test('UT profiling distinguishes incomplete files and rejects invalid concurrency before execution',async t=>{
 const {readUtFileMetrics}=await import('./ut-environment.mjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-ut-incomplete-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'files.ndjson');
 fs.writeFileSync(file,JSON.stringify({event:'start',pid:1,file:'test/a.test.ts'})+'\n'+JSON.stringify({event:'start',pid:2,file:'../private.test.ts'})+'\nnot-json\n');
 const metrics=readUtFileMetrics(file);assert.equal(metrics.startedFiles,1);assert.equal(metrics.completedFiles,0);assert.equal(metrics.incompleteFiles,1);
 for(const cpus of [0,-1,NaN,Infinity])assert.throws(()=>boundedUtEnv(root,{PATH:process.env.PATH},5000,cpus),/concurrency/i);
});
test('four file slots can rendezvous concurrently and are observed in the profile',async t=>{
 const {readUtFileMetrics}=await import('./ut-environment.mjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-ut-four-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const project=path.join(root,'source');fs.mkdirSync(path.join(project,'test'),{recursive:true});
 const files=['a','b','c','d'].map(name=>`test/${name}.test.ts`);
 for(const [index,file]of files.entries())fs.writeFileSync(path.join(project,file),`const test=require('node:test'),fs=require('node:fs');test('rendezvous',async()=>{fs.writeFileSync('ready-${index}','');while(fs.readdirSync('.').filter(name=>name.startsWith('ready-')).length<4)await new Promise(resolve=>setTimeout(resolve,10));});`);
 const metricsFile=path.join(root,'private/files.ndjson'),env=boundedUtEnv(root,{PATH:process.env.PATH,HOME:root},5000,4,{project,metricsFile});
 const result=spawnSync('node',['--test',...files],{env,cwd:project,encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(readUtFileMetrics(metricsFile).maxActiveFiles,4);
});
test('UT files execute within the configured concurrency budget without skipping files',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-ut-concurrency-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const files=['a.test.mjs','b.test.mjs','c.test.mjs'];
 const source="import test from 'node:test';import fs from 'node:fs';test('exclusive budget slot',async()=>{const fd=fs.openSync('active.lock','wx');try{await new Promise(resolve=>setTimeout(resolve,400));}finally{fs.closeSync(fd);fs.unlinkSync('active.lock');}});";
 for(const file of files)fs.writeFileSync(path.join(root,file),source);
 const env=boundedUtEnv(root,{PATH:process.env.PATH,HOME:root},5000,1);
 const result=spawnSync('node',['--test',...files],{env,cwd:root,encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/(?:#|ℹ) pass 3/);assert.ok(!fs.existsSync(path.join(root,'active.lock')));
});
test('UT wrapper keeps normal Node calls intact and stops a stuck test file',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-ut-bound-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const env=boundedUtEnv(root,{PATH:process.env.PATH,HOME:root},300);
 assert.equal(spawnSync('node',['-p','2+2'],{env,encoding:'utf8'}).stdout.trim(),'4');
 fs.writeFileSync(path.join(root,'stuck.test.mjs'),"import test from 'node:test';test('stuck',async()=>{setInterval(()=>{},50);await new Promise(()=>{});});");
 const result=spawnSync('node',['--test','stuck.test.mjs'],{env,cwd:root,encoding:'utf8',timeout:4000});assert.equal(result.error,undefined);assert.notEqual(result.status,0);assert.match(result.stdout+result.stderr,/timed out|timeout|cancelled/);
});
test('UT process deadline stops leaked handles after all test callbacks finish',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-ut-leak-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const env=boundedUtEnv(root,{PATH:process.env.PATH,HOME:root},500);
 fs.writeFileSync(path.join(root,'leak.test.mjs'),"import test from 'node:test';test('done',()=>{process.env.E2E_UT_CHECKPOINT='after-callback';});setInterval(()=>{},50);");
 const result=spawnSync('node',['--test','leak.test.mjs'],{env,cwd:root,encoding:'utf8',timeout:5000});assert.equal(result.error,undefined);assert.notEqual(result.status,0);assert.match(result.stdout+result.stderr,/E2E_UT_FILE_TIMEOUT/);assert.match(result.stdout+result.stderr,/tests/);assert.match(result.stdout+result.stderr,/"checkpoint":"after-callback"/);
});
