import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { runWithTrustedCoreAgentContext } from '../src/lib/engine/general-agent/trusted-context';

function load(file:string,dependencies:Record<string,unknown>){
 const filename=path.resolve(file);const actual=createRequire(filename);const exports:Record<string,unknown>={};
 const source=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
 vm.runInNewContext(source,{exports,require:(name:string)=>name in dependencies?dependencies[name]:actual(name),process,Buffer,console,Date,setTimeout,clearTimeout,structuredClone},{filename});
 return exports;
}

test('AgentDebug writes inputs and reads final report from the same frozen workspace used by its Agent',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'core-report-workspace-'));const trusted=path.join(root,'trusted');const legacy=path.join(root,'legacy');fs.mkdirSync(trusted);fs.mkdirSync(legacy);
 let oldWorkspaceCalls=0;let agentCalls=0;
 const context={trustedWorkspaceDir:trusted,trustedModel:{providerID:'fixture',modelID:'frozen'},recordCoreTrace:async()=>{}};
 try{
  const runtimeModule=load('src/lib/engine/agent-debug/runner.ts',{
   '@/lib/engine/general-agent/workspace':{ensureSessionWorkspace:()=>{oldWorkspaceCalls++;return legacy;}},
   '@/lib/engine/general-agent/skills-fs-loader':{mountFileBasedSkillResources:()=>({mountPoint:null}),loadFileBasedSkillPrompt:()=> 'fixture system'},
   '@/lib/engine/general-agent':{runGeneralAgent:async()=>{
    agentCalls++;assert.equal(fs.existsSync(path.join(trusted,'.agent-insight/agent-debug-input.json')),true,'Agent must receive the input file in its own frozen directory');
    fs.writeFileSync(path.join(trusted,'.agent-insight/agent-debug-final.json'),JSON.stringify({triage:{category:'normal',shortCircuited:false,fatalDiagnosis:null},stepRecords:[],phase1Grid:[],issues:[],findings:[],rootCause:null}));
   }},
  });
  const run=runtimeModule.runAgentDebugDiagnosis as (args:Record<string,unknown>)=>Promise<{status:string}>;
  const result=await runWithTrustedCoreAgentContext(context,()=>run({execution:{id:'trace'},interactions:[{role:'assistant',content:'complete evidence'}],user:'alice'}));
  assert.equal(result.status,'done');assert.equal(agentCalls,1);assert.equal(oldWorkspaceCalls,0);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('frozen Skills extraction receives supplied interactions and never reads legacy ExecutionMatch or Session',async()=>{
 let oldReads=0;let extracts=0;const interactions=[{role:'assistant',content:'immutable original'}];
 const runtimeModule=load('src/lib/engine/evaluation/key-action-trace-analysis.ts',{
  '@/lib/storage/prisma':{db:{findExecutionMatch:async()=>{oldReads++;throw Error('legacy trace read');}}},
  '@/lib/engine/observability/flow-parser':{analyzeDynamicOnly:async()=>{oldReads++;throw Error('legacy session read');},extractFrozenTraceSteps:async(value:unknown)=>{extracts++;assert.deepEqual(value,interactions);return [{name:'LLM extracted business step',dialogStartIndex:0,dialogEndIndex:0,type:'action'}];}},
 });
 const loadSteps=runtimeModule.loadActualExtractedTraceSteps as (task:string,user:string,interactions:unknown[])=>Promise<{status:string;steps:Array<{name:string}>}>;
 const result=await runWithTrustedCoreAgentContext({trustedWorkspaceDir:'/tmp/private-frozen',trustedModel:{providerID:'fixture',modelID:'frozen'},recordCoreTrace:async()=>{}},()=>loadSteps('task','alice',interactions));
 assert.equal(result.status,'ok');assert.equal(result.steps[0].name,'LLM extracted business step');assert.equal(extracts,1);assert.equal(oldReads,0);
});

test('frozen dynamic extraction keeps the original LLM prompt and waits for indexed self-Trace recording',async()=>{
 const abort=new AbortController();let oldReads=0;let providerCalls=0;let recorded=false;let returned=false;
 let release!:()=>void;let notify!:()=>void;const entered=new Promise<void>(resolve=>{notify=resolve;});
 const runtimeModule=load('src/lib/engine/observability/flow-parser.ts',{
  '@/lib/storage/prisma':{db:new Proxy({},{get:()=>()=>{oldReads++;throw Error('old Trace storage read');}})},
  '@/lib/storage/server-config':{getActiveConfig:async()=>{oldReads++;throw Error('model config reread');}},
  '@/lib/logger/server':{isLogEnabled:()=>false,sanitizeLogValue:(value:unknown)=>value},
  'openai':{OpenAI:class{
   apiKey:string;chat:{completions:{create:(input:Record<string,unknown>,options?:{signal?:AbortSignal})=>Promise<Record<string,unknown>>}};
   constructor(options:{apiKey:string;baseURL:string}){this.apiKey=options.apiKey;assert.equal(options.baseURL,'http://frozen-model.invalid/v1');
    this.chat={completions:{create:async(input,options)=>{providerCalls++;assert.equal(input.model,'frozen-model');assert.equal(options?.signal,abort.signal);return {choices:[{message:{content:JSON.stringify({steps:[{name:'LLM business action',description:'original semantic extraction',type:'action',dialogStartIndex:0,dialogEndIndex:0}]})}}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}};}}};
   }
  }},
 });
 assert.equal(typeof runtimeModule.extractFrozenTraceSteps,'function','frozen extraction must reuse the real LLM batching pipeline');
 const extract=runtimeModule.extractFrozenTraceSteps as (interactions:unknown[],user:string)=>Promise<Array<{name:string}>>;
 const pending=runWithTrustedCoreAgentContext({trustedWorkspaceDir:'/tmp/private-frozen',trustedModel:{providerID:'openai',modelID:'frozen-model',apiKey:'fixture-secret',baseURL:'http://frozen-model.invalid/v1'},cancelSignal:abort.signal,recordCoreTrace:async payload=>{
  assert.ok(JSON.stringify(payload.rawMessages).includes('immutable source'));assert.equal(JSON.stringify(payload).includes('fixture-secret'),false);notify();await new Promise<void>(resolve=>{release=resolve;});recorded=true;
 }},()=>extract([{role:'assistant',content:'immutable source'}],'alice').then(value=>{returned=true;return value;}));
 await entered;assert.equal(returned,false);release();const steps=await pending;
 assert.equal(steps[0].name,'LLM business action');assert.equal(recorded,true);assert.equal(providerCalls,1);assert.equal(oldReads,0);
});

test('large frozen extraction bounds model concurrency while preserving every batch result',async()=>{
 let active=0;let peak=0;let calls=0;let recorded=0;
 const runtimeModule=load('src/lib/engine/observability/flow-parser.ts',{
  '@/lib/storage/prisma':{db:{}},'@/lib/storage/server-config':{getActiveConfig:async()=>{throw Error('unexpected config read');}},
  '@/lib/logger/server':{isLogEnabled:()=>false,sanitizeLogValue:(value:unknown)=>value},
  'openai':{OpenAI:class{apiKey='fixture';chat={completions:{create:async()=>{const index=calls++;active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,3));active--;return {choices:[{message:{content:JSON.stringify({steps:[{name:`batch-${index}`,description:'LLM business step',type:'action',dialogStartIndex:index*10,dialogEndIndex:index*10+9}]})}}]};}}};}},
 });
 const extract=runtimeModule.extractFrozenTraceSteps as (rows:unknown[],user:string)=>Promise<Array<{name:string}>>;
 const result=await runWithTrustedCoreAgentContext({trustedWorkspaceDir:'/tmp/private-frozen',trustedModel:{providerID:'fixture',modelID:'frozen'},recordCoreTrace:async()=>{recorded++;}},()=>extract(Array.from({length:65},(_,index)=>({role:'assistant',content:`immutable ${index}`})),'alice'));
 assert.equal(calls,7);assert.equal(recorded,7);assert.ok(peak<=4,`at most four frozen extraction requests may run together, got ${peak}`);assert.equal(result.length,7);
 assert.deepEqual(Array.from(result,step=>step.name),Array.from({length:7},(_,index)=>`batch-${index}`));
});
