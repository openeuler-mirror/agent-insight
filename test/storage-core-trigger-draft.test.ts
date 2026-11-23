import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import matter from 'gray-matter';
import ts from 'typescript';

test('frozen direct draft retains the original 18-query prompt and accepts two valid outputs without merging edited items',async()=>{
 const poison=()=>{throw Error('Frozen draft touched current static/model/old dataset');};const calls:Array<{messages:Array<{content:string}>;options:unknown}>=[];const fixtureModule={exports:{}};
 class Message{constructor(public content:string){}}
 const dependencies:Record<string,unknown>={'crypto':{createHash,randomUUID},'gray-matter':matter,'@langchain/core/messages':{HumanMessage:Message,SystemMessage:Message},'@/lib/logger':{createLogger:()=>({log:()=>{},debug:()=>{},warn:()=>{}})},'@/lib/storage/prisma':{prismaRaw:{skill:{findFirst:poison}}},'@/server/skill_trigger_eval_storage':{findTriggerEvalSet:poison},'@/lib/storage/server-config':{getActiveConfig:poison,getUserSettings:poison},'@/lib/shared/model-connection':{isModelConnectionReady:()=>true},'@/lib/engine/skill-generation/shared/model':{createModel:(options:unknown)=>({invoke:async(messages:Array<{content:string}>)=>{calls.push({messages,options});return {content:'```json\n[{"query":" valid one ","shouldTrigger":true},{"query":"valid two","shouldTrigger":false}]\n```'};}})}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/engine/skill-generation/evaluator/runners/draftTriggerEvalSet.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,{module:fixtureModule,exports:fixtureModule.exports,require:(name:string)=>dependencies[name],console,process:{env:{}},Boolean});
 const api=fixtureModule.exports as {draftTriggerEvalSet:(input:unknown)=>Promise<{items:Array<{id:string;query:string;source:string}>;draftedFromSkillHash:string}>};
 let recorded:unknown;const result=await api.draftTriggerEvalSet({user:'legacy-alice',skillName:'checking',replaceUserEdited:true,coreRuntime:{skillContent:{description:'tested v0 description',body:'FROZEN BODY',contentHash:'frozen-hash'},model:{modelId:'local-mock',provider:'custom',headers:{'x-local':'configured'}},itemId:(index:number)=>'stable-'+index,invoke:async(request:unknown,perform:()=>Promise<unknown>)=>{recorded=request;return perform();}}});
 assert.equal(calls.length,1);assert.ok(recorded);assert.match(calls[0].messages[1].content,/请起草 18 条/);assert.match(calls[0].messages[1].content,/tested v0 description/);assert.match(calls[0].messages[1].content,/FROZEN BODY/);assert.deepEqual(JSON.parse(JSON.stringify(result.items.map(row=>({id:row.id,query:row.query,source:row.source})))),[{id:'stable-0',query:'valid one',source:'llm-draft'},{id:'stable-1',query:'valid two',source:'llm-draft'}]);assert.equal(result.draftedFromSkillHash,'frozen-hash');
});
