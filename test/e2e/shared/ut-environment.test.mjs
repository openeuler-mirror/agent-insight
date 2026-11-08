import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import {boundedUtEnv} from './ut-environment.mjs';
test('UT wrapper keeps normal Node calls intact and stops a stuck test file',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-ut-bound-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const env=boundedUtEnv(root,{PATH:process.env.PATH,HOME:root},300);
 assert.equal(spawnSync('node',['-p','2+2'],{env,encoding:'utf8'}).stdout.trim(),'4');
 fs.writeFileSync(path.join(root,'stuck.test.mjs'),"import test from 'node:test';test('stuck',async()=>{setInterval(()=>{},50);await new Promise(()=>{});});");
 const result=spawnSync('node',['--test','stuck.test.mjs'],{env,cwd:root,encoding:'utf8',timeout:4000});assert.equal(result.error,undefined);assert.notEqual(result.status,0);assert.match(result.stdout+result.stderr,/timed out|timeout|cancelled/);
});
test('UT process deadline stops leaked handles after all test callbacks finish',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-ut-leak-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const env=boundedUtEnv(root,{PATH:process.env.PATH,HOME:root},500);
 fs.writeFileSync(path.join(root,'leak.test.mjs'),"import test from 'node:test';test('done',()=>{});setInterval(()=>{},50);");
 const result=spawnSync('node',['--test','leak.test.mjs'],{env,cwd:root,encoding:'utf8',timeout:5000});assert.equal(result.error,undefined);assert.notEqual(result.status,0);assert.match(result.stdout+result.stderr,/E2E_UT_FILE_TIMEOUT/);assert.match(result.stdout+result.stderr,/tests/);
});
