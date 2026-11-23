import { getModelClientConfig } from '../src/lib/server/model-client';
import {configuredModelFetchFixture} from './helpers/storage-core-vm';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {AsyncLocalStorage} from 'node:async_hooks';
function moduleAt(path:string,deps:Record<string,unknown>){const module={exports:{}};vm.runInNewContext(ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:(name:string)=>name==='@/lib/server/model-client'?{getModelClientConfig}:name==='@/lib/server/configured-model-fetch'?{configuredModelFetch:configuredModelFetchFixture}:deps[name]||{},JSON,structuredClone,Map,Set,console});return module.exports as Record<string,Function>;}
test('direct Skill context and missing-flow parse use frozen catalog and ephemeral parsed flow',async()=>{
 const catalog=moduleAt('src/lib/eval/frozen-skill-catalog.ts',{'node:async_hooks':{AsyncLocalStorage}});let legacy=0;let parses=0;let options:unknown;
 const algorithm=moduleAt('src/lib/engine/evaluation/key-action-trace-analysis.ts',{'@/lib/storage/prisma':{db:new Proxy({},{get(){legacy++;throw Error('Live Skill storage forbidden');}})},'@/lib/eval/frozen-skill-catalog':catalog,'@/lib/engine/observability/skill-scope':{getRootSkillFromInteractions:()=>null},'@/lib/engine/observability/flow-parser':{parseSkillFlow:async(_content:string,_id:string,_version:number,_user:string,config:unknown)=>{parses++;options=config;return {success:true,flow:{steps:[{id:'step',name:'Frozen action',description:'frozen',weight:1}]},mermaidCode:'flowchart TD'};},extractKeyActionsFromFlow:()=>[{id:'action',content:'frozen',weight:1,controlFlowType:'required'}]}});
 assert.equal(typeof catalog.withFrozenSkillCatalog,'function');await catalog.withFrozenSkillCatalog([{id:'skill-id',name:'Skill',user:'alice',activeVersion:2,versions:[{version:2,content:'frozen complete SKILL content'}],parsedFlows:[]}],'alice',async()=>{
  const context=await algorithm.loadTaskCompletionSkillContext({skill:'Skill',skillVersion:2},[],'alice');assert.equal(context.invokedSkills[0].content,'frozen complete SKILL content');
  const reference=await algorithm.buildSkillKeyActionReference({skill:'Skill',skillVersion:2},'alice',[]);assert.equal(reference.status,'ok');assert.deepEqual(JSON.parse(JSON.stringify(options)),{persist:false});
  assert.equal((await algorithm.buildSkillKeyActionReference({skill:'Skill',skillVersion:2},'alice',[])).status,'ok');assert.equal(parses,1);
 });assert.equal(legacy,0);
});

test('flow parsing persist:false preserves original parsing output and performs no old database writes',async()=>{
 let writes=0;
 const api=moduleAt('src/lib/engine/observability/flow-parser.ts',{'openai':{OpenAI:class {apiKey='fixture';chat={completions:{create:async()=>({choices:[{message:{content:JSON.stringify({steps:[{id:'one',name:'one',description:'step',type:'action',weight:1,dependencies:[]}]})}}]})}};}},'@/lib/engine/general-agent/trusted-context':{getTrustedCoreAgentContext:()=>undefined},'@/lib/storage/server-config':{getActiveConfig:async()=>({apiKey:'fixture',model:'fixture',baseUrl:'http://invalid'})},'@/lib/shared/model-connection':{isModelConnectionReady:()=>true},'@/lib/server/model-fetch':{getModelFetch:()=>undefined},'@/lib/storage/prisma':{db:{upsertParsedFlow:async()=>{writes++;}}},'@/lib/env':{resolveAgentInsightDataPath:()=>'/unavailable'},'@/prompts/flow-parse-prompt':{generateFlowParsePrompt:()=> 'parse'},'@/lib/logger/server':{isLogEnabled:()=>false}});
 const frozen=await api.parseSkillFlow('full skill','skill',2,'alice',{persist:false});assert.equal(frozen.success,true);assert.equal(frozen.flow.steps[0].controlFlowType,'required');assert.equal(writes,0);
 assert.equal((await api.parseSkillFlow('full skill','skill',2,'alice')).success,true);assert.equal(writes,2);
});
