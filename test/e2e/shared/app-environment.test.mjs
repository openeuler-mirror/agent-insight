import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import {boundedAppEnv} from './app-environment.mjs';
test('isolated application Node heap stays bounded even when startup sets NODE_OPTIONS',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-app-bound-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const original={...process.env,E2E_ISOLATED_CONTAINER:'0'};assert.equal(boundedAppEnv(root,original),original);
 const env=boundedAppEnv(root,{...original,E2E_ISOLATED_CONTAINER:'1',NODE_OPTIONS:'--max-old-space-size=4096'});
 const r=spawnSync('node',['-p',"require('v8').getHeapStatistics().heap_size_limit/1024/1024"],{env,encoding:'utf8'});assert.equal(r.status,0);assert.ok(Number(r.stdout)<2700,r.stdout);
});
