import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import {boundedAppEnv} from './app-environment.mjs';
test('isolated application Node heap stays bounded even when startup sets NODE_OPTIONS',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-app-bound-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const original={...process.env,E2E_ISOLATED_CONTAINER:'0'};assert.equal(boundedAppEnv(root,original),original);
 const env=boundedAppEnv(root,{...original,E2E_ISOLATED_CONTAINER:'1',NODE_OPTIONS:'--max-old-space-size=4096'});
 const r=spawnSync('node',['-p',"require('v8').getHeapStatistics().heap_size_limit/1024/1024"],{env,encoding:'utf8'});assert.equal(r.status,0);assert.ok(Number(r.stdout)<2700,r.stdout);
});
test('the configured heap also reaches forked Next workers that clear execArgv',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-app-fork-bound-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const worker=path.join(root,'worker.cjs');fs.writeFileSync(worker,"console.log(require('v8').getHeapStatistics().heap_size_limit/1024/1024)");
 const env=boundedAppEnv(root,{...process.env,E2E_ISOLATED_CONTAINER:'1',NODE_OPTIONS:'--max-old-space-size=4096'});
 const result=spawnSync('node',['-e',`const c=require('child_process').fork(${JSON.stringify(worker)},[],{execArgv:[],silent:true});c.stdout.pipe(process.stdout);c.stderr.pipe(process.stderr);c.on('exit',code=>process.exitCode=code);`],{env,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.ok(Number(result.stdout)<2700,result.stdout);
});
