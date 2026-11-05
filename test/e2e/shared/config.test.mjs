import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {loadExecutionConfig,validateConfig,configSnapshot,readModelKey} from './config.mjs';
const raw=()=>JSON.parse(fs.readFileSync(new URL('../config.json',import.meta.url)));
test('defaults keep distinct stable accounts, real five cases and UT; profile overrides remain isolated',()=>{
 const pr=loadExecutionConfig({profile:'pr'}),daily=loadExecutionConfig({profile:'daily'});assert.equal(pr.account.username,'test_e2e_pr@example.com');assert.equal(daily.account.username,'test_e2e_daily@example.com');assert.equal(pr.mode,'real');assert.equal(pr.runUt,true);assert.deepEqual(pr.cases,['001','002','003','004','005']);
 const value=raw();value.profiles.pr.mode='mock';value.profiles.pr.model={baseUrl:'https://gateway.example/v1/',modelName:'vendor/custom-model',key:{env:'E2E_CUSTOM_KEY'},options:{}};
 const config=validateConfig(value,'pr');assert.equal(config.model.baseUrl,'https://gateway.example/v1');assert.equal(config.model.modelName,'vendor/custom-model');assert.deepEqual(config.model.options,{});assert.equal(validateConfig(value,'daily').model.modelName,'deepseek-flash');assert.equal(configSnapshot(config).settings.model.key.env,'E2E_CUSTOM_KEY');
});
test('invalid and misspelled settings fail closed; no secret literals or credential URLs',()=>{
 for(const change of [v=>v.defaults.mode='fake',v=>v.defaults.cases=['001','001'],v=>v.defaults.resources.cpus=0,v=>v.defaults.resources.concurrentRuns=2,v=>v.defaults.resources.appHeapMiB=v.defaults.resources.memoryMiB,v=>v.defaults.model.baseUrl='https://secret:password@gateway.example',v=>v.defaults.model.baseUrl='https://gateway.example?key=hidden',v=>v.defaults.model.key='never-store-this',v=>v.defaults.model.modekname='typo',v=>v.profiles.daily.account.username=v.profiles.pr.account.username,v=>v.defaults.timeouts.caseMs=0]){const v=raw();change(v);assert.throws(()=>validateConfig(v,'pr'));}
});
test('configuration fingerprints include mode, model, scope, resources and account; no environment secrets are serialized',()=>{
 const value=raw(),one=configSnapshot(validateConfig(value,'pr'));process.env.E2E_CUSTOM_KEY='never-report-this-value';value.defaults.model.key={env:'E2E_CUSTOM_KEY'};const two=configSnapshot(validateConfig(value,'pr'));assert.notEqual(one.hash,two.hash);assert.ok(!JSON.stringify(two).includes(process.env.E2E_CUSTOM_KEY));delete process.env.E2E_CUSTOM_KEY;
 value.defaults.resources.cpus=3;assert.notEqual(configSnapshot(validateConfig(value,'pr')).hash,two.hash);
});
test('Key references support arbitrary opaque API keys and legacy single-key notes without exposing values',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-key-ref-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'key');fs.writeFileSync(file,'opaque.api-key_123\n');assert.equal(readModelKey({fileEnv:'KEY_FILE'},{KEY_FILE:file}),'opaque.api-key_123');assert.equal(readModelKey({env:'MODEL_KEY'},{MODEL_KEY:'opaque-key'}),'opaque-key');
 fs.writeFileSync(file,'model key: sk-testfixture123\n');assert.equal(readModelKey({file},{}),'sk-testfixture123');assert.throws(()=>readModelKey({env:'ABSENT'},{}),/credential/);assert.throws(()=>readModelKey({env:'BAD'},{BAD:'invalid\nheader'}),/credential/);
});
test('control CLI compatibility flags cannot enqueue a configuration different from the worker file',async()=>{
 const {loadControlConfig}=await import('./config.mjs');assert.equal(loadControlConfig({mode:'real',profile:'core-five'}).mode,'real');assert.throws(()=>loadControlConfig({mode:'mock'}),/config.json/);assert.throws(()=>loadControlConfig({profile:'unknown'}),/profile/);
});
