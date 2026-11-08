/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'generator-completion-'));
fs.writeFileSync(path.join(directory,'SKILL.md'),'---\nname: example\n---\ncomplete generated skill');
let bridge: typeof import('@/lib/skill-generator-opencode-bridge');
let agent: (options: any) => Promise<any>;
let cached: string | undefined;
test.before(async () => {
 const stubs: Record<string, unknown> = {
  '@/lib/engine/general-agent': {runGeneralAgent:(options:any)=>agent(options)},
  '@/lib/engine/general-agent/concurrency-limiter': {withBackgroundOpencodeSlot:(fn:()=>unknown)=>fn()},
  '@/lib/storage/server-config': {getUserSettings:async()=>({configs:[]})},
  '@/lib/engine/general-agent/server-model-config': {},
  '@/lib/engine/general-agent/skills-fs-loader': {fileBasedSkillExists:()=>false},
  '@/lib/engine/general-agent/workspace': {ensureUserWorkspace:()=>directory,ensureSessionWorkspace:()=>directory},
  '@/lib/engine/general-agent/pending-requests': {},
  '@/lib/engine/skill-generation/opencode-agent-cli/opencode-manager': {getOpencodeServerGeneration:()=>1},
  '@/lib/skill-generator/attachments': {listAttachments:()=>[],formatAttachmentsForPrompt:()=>'',UPLOADS_DIR:'uploads'},
  '@/lib/storage/prisma': {prismaRaw:{skillGeneratorSession:{findUnique:async()=>({opencodeSessionId:cached}),update:async()=>({})}}},
 };
 const loader=Module as unknown as {_load:(id:string,...args:unknown[])=>unknown}, original=loader._load;
 loader._load=function(id,...args){return id in stubs?stubs[id]:original.call(this,id,...args)};
 try{bridge=await import('@/lib/skill-generator-opencode-bridge')}finally{loader._load=original}
});
test.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
const result=()=>({workspaceDir:directory,sessionId:'completed',output:'complete',stats:{textDeltaCount:1,toolCallCount:1},interactions:[]});
for(const terminal of ['assistant','idle'])test(`generation ${terminal} completion survives delayed SDK cleanup`,async()=>{
 cached=undefined;
 agent=async run=>{
  run.handlers.onText?.({messageID:'answer',delta:'complete',fullText:'complete'});
  if(terminal==='assistant')run.handlers.onAssistantMessage?.({status:'completed',info:{finish:'stop'}});else run.handlers.onSession?.({phase:'idle'});
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(resolve,700);run.chatOptions?.signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('opencode 执行已中止'))},{once:true})});
  return result();
 };
 const events:string[]=[];await assert.doesNotReject(()=>bridge.streamSkillGeneratorOpencode({user:'test',threadId:'gen-'+terminal,message:'generate',send:mode=>events.push(mode)}));assert.ok(events.includes('done'));assert.ok(!events.includes('error'));
});
test('cached-session fallback retains the same deadline and completion policy',async()=>{
 cached='old-session';let calls=0;
 agent=async run=>{calls++;assert.equal(run.chatOptions?.idleTimeoutMs,0);assert.equal(run.chatOptions?.streamTimeoutMs,900000);if(calls===1)throw new Error('session not found');return result()};
 await bridge.streamSkillGeneratorOpencode({user:'test',threadId:'gen-cache',message:'generate',send:()=>{}});assert.equal(calls,2);cached=undefined;
});
test('generation model failures propagate instead of producing a successful done event',async()=>{
 cached=undefined;agent=async()=>{throw Object.assign(new Error('provider unavailable'),{code:'MODEL_ERROR'})};const events:string[]=[];
 await assert.rejects(()=>bridge.streamSkillGeneratorOpencode({user:'test',threadId:'gen-error',message:'generate',send:mode=>events.push(mode)}),/provider unavailable/);assert.ok(!events.includes('done'));
});
