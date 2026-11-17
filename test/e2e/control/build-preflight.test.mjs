import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {compileProduction} from './build-preflight.mjs';import {loadExecutionConfig} from '../shared/config.mjs';
test('direct suite compilation uses its explicit project, identity and isolated environment',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'preflight-direct-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));spawnSync('git',['init','-q'],{cwd:root});fs.writeFileSync(path.join(root,'source'),'source');
 const run=async(bin,args,options)=>{
  assert.equal(options.env.E2E_SUITE_RUN_ID,'direct-suite');assert.equal(options.cwd,root);
  if(bin==='npm'){
   for(const file of ['.next/BUILD_ID','.next/standalone/server.js','.next/standalone/.next/required-server-files.json']){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),file.endsWith('BUILD_ID')?'direct-build':'');}
   fs.mkdirSync(path.join(root,'.next/static'),{recursive:true});
  }
  return {code:0};
 };
 const result=await compileProduction(loadExecutionConfig(),{project:root,runId:'direct-suite',env:{E2E_ISOLATED_CONTAINER:'1',E2E_RUN_ID:'outer-suite'},run});
 assert.equal(result.status,'PASS');const marker=JSON.parse(fs.readFileSync(path.join(root,'exclude/core-e2e/production-build.json')));assert.equal(marker.suiteRunId,'direct-suite');assert.equal(marker.buildId,'direct-build');
});
