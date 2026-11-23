import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {classifyEndReason,retryOnTimeout,MAX_TIMEOUT_RETRIES} from '../src/lib/engine/skill-generation/evaluator/runners/triggerEvalRetry';

function fixture(mode:'hit'|'none'|'error'|'recording-error'|'no-session',clock?:{now:number}){
 const events:string[]=[];let count=0;const sessions=new Map<string,unknown>();let serverOptions:Record<string,unknown>|undefined;
 class Client{
  async createSession(input:unknown){events.push('create');if(mode==='no-session')throw Error('session rejected before send');assert.ok((input as {permission:unknown[]}).permission.length>0);const id='session-'+(++count);return {id};}
  async chat(id:string,_input:unknown,callbacks:{onTool:(value:unknown)=>void;onSession:(value:unknown)=>void},options:{signal:AbortSignal}){events.push('model');if(clock)clock.now+=10;sessions.set(id,[{role:'assistant',content:'actual '+mode}]);if(mode==='hit')callbacks.onTool({phase:'end',name:'skill',input:{name:'checking'}});if(mode==='error')callbacks.onSession({phase:'error',sessionID:id,error:{data:{message:'provider denied'}}});if(options.signal.aborted)throw Object.assign(new Error('hit stopped'),{name:'AbortError'});return {text:'accepted'};}
  async abortSession(){events.push('stop');return true;}
  async deleteSession(){events.push('delete');if(clock)clock.now+=2000;return true;}
  async listMessages(id:string){return sessions.get(id);}
 }
 const poison=()=>{throw Error('Frozen runtime accessed current static/model source');};const fixtureModule={exports:{}};const dependencies:Record<string,unknown>={
  'node:fs':fs,'node:path':path,'@/lib/logger':{createLogger:()=>({log:()=>{},warn:()=>{}})},
  '@/lib/engine/skill-generation/opencode-agent-cli/opencode-client':{AgentInsight:Client},
  '@/lib/engine/skill-generation/opencode-agent-cli/opencode-manager':{runWithEphemeralOpencodeServer:async(options:Record<string,unknown>,fn:(url:string)=>Promise<unknown>)=>{serverOptions=options;assert.equal((options.frozenModel as {providerID?:string})?.providerID,'openai-compatible');assert.equal((options.frozenModel as {modelID?:string})?.modelID,'mock');try{return await fn('http://isolated');}finally{events.push('physical-exit');}}},
  '@/lib/engine/general-agent/concurrency-limiter':{withBackgroundOpencodeSlot:(fn:()=>Promise<unknown>)=>fn()},
  '@/lib/storage/prisma':{prismaRaw:{skill:{findMany:poison},skillVersion:{findFirst:poison}}},
  '@/lib/storage/server-config':{getUserSettings:poison},'@/lib/engine/general-agent/server-model-config':{loadServerModelForUser:poison,normalizeProviderID:(value:unknown)=>value},
  '@/lib/internal-agent-tag':{tagOpencodeSession:()=>{}},'@/lib/system-agents':{getSystemAgentId:async()=>null},
  '@/lib/engine/evaluation/evaluator-execution-recorder':{recordEvaluatorExecution:async(client:Client,input:{taskId:string;skillVersion:number})=>{assert.equal(input.skillVersion,0);assert.ok(await client.listMessages(input.taskId));events.push('indexed');if(clock)clock.now+=1000;if(mode==='recording-error')throw Object.assign(new Error('recording unknown'),{coreDeliveryUncertain:true});}},
 };
 class ClockDate extends Date{constructor(value?:number|string){super(typeof value==='string'?Date.parse(value):value??clock?.now??Date.now());}static now(){return clock?.now??Date.now();}}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/engine/skill-generation/evaluator/runners/triggerEval.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:fixtureModule,exports:fixtureModule.exports,require:(name:string)=>name==='./triggerEvalRetry'?{classifyEndReason,retryOnTimeout,MAX_TIMEOUT_RETRIES}:dependencies[name]||{},console,process:{env:{}},Date:clock?ClockDate:Date,AbortController,setTimeout,clearTimeout,Map,Set,Math});
 return {run:(fixtureModule.exports as {runTriggerEvalLive:(input:unknown)=>Promise<{items:Array<Record<string,unknown>>;passRate:number;truePositiveRate:number;falsePositiveRate:number}>}).runTriggerEvalLive,events,options:()=>serverOptions};
}

for(const mode of ['hit','none'] as const)test('frozen live Trigger '+mode+' retains v0 routing materialization and indexes before deleting its Session',async(t)=>{
 const f=fixture(mode),directory=fs.mkdtempSync(path.join(os.tmpdir(),'typed-trigger-live-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const content='---\nname: checking\ndescription: exact frozen description\n---\nPRIVATE SKILL BODY';
 const value=await f.run({user:'legacy-alice',skillName:'checking',skillVersion:0,workspaceRoot:directory,triggerSet:{items:[{id:'one',query:'check',shouldTrigger:mode==='hit'}]},runsPerQuery:1,triggerThreshold:0.5,timeoutMs:5000,concurrency:1,coreRuntime:{model:{id:'frozen',provider:'openai-compatible',model:'mock',apiKey:'',headers:{'x-routing':'local'}},skills:[{name:'checking',version:0,content}],sample:async(_id:string,perform:()=>Promise<unknown>)=>{f.events.push('durable-intent');return perform();}}});
 assert.equal(value.passRate,1);assert.equal(value.truePositiveRate,mode==='hit'?1:0);assert.equal(value.falsePositiveRate,0);assert.equal(value.items[0].runsTotal,1);
 assert.ok(f.events.indexOf('durable-intent')<f.events.indexOf('model'));assert.ok(f.events.indexOf('indexed')<f.events.indexOf('delete'));assert.equal(f.events.at(-1),'physical-exit');assert.equal(f.options()?.captureMode,'core-recorded');assert.equal(f.options()?.requireCleanup,true);assert.equal(Object.hasOwn(f.options()?.frozenModel as object,'apiKey'),false);assert.equal((f.options()?.frozenModel as {headers:Record<string,string>}).headers['x-routing'],'local');
 const materialized=fs.readFileSync(path.join(directory,'.opencode/skills/checking/SKILL.md'),'utf8');assert.match(materialized,/exact frozen description/);assert.ok(!materialized.includes('PRIVATE SKILL BODY'));
});

test('original Trigger decision latency excludes indexed storage and Session deletion waits',async(t)=>{
 const clock={now:1000},f=fixture('none',clock),directory=fs.mkdtempSync(path.join(os.tmpdir(),'typed-trigger-latency-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const value=await f.run({user:'alice',skillName:'checking',skillVersion:0,workspaceRoot:directory,triggerSet:{items:[{id:'one',query:'check',shouldTrigger:false}]},coreRuntime:{model:{id:'frozen',provider:'openai-compatible',model:'mock'},skills:[{name:'checking',version:0,content:'---\nname: checking\ndescription: check\n---\n'}],sample:(_id:string,perform:()=>Promise<unknown>)=>perform()}});
 assert.equal(clock.now,4010);assert.equal(value.items[0].latencyMsAvg,10);
});

test('unknown Trigger Trace recording does not delete the source Session or turn into a routing score',async(t)=>{
 const f=fixture('recording-error'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'typed-trigger-recording-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 await assert.rejects(()=>f.run({user:'alice',skillName:'checking',skillVersion:0,workspaceRoot:directory,triggerSet:{items:[{id:'one',query:'check',shouldTrigger:false}]},coreRuntime:{model:{id:'frozen',provider:'openai-compatible',model:'mock'},skills:[{name:'checking',version:0,content:'---\nname: checking\ndescription: check\n---\n'}],sample:(_id:string,perform:()=>Promise<unknown>)=>perform()}}),/recording unknown/);
 assert.ok(f.events.includes('indexed'));assert.ok(!f.events.includes('delete'));assert.equal(f.events.at(-1),'physical-exit');
});

test('failed Session creation is explicitly unsent after physical exit',async(t)=>{
 const f=fixture('no-session'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'typed-trigger-unsent-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 await assert.rejects(()=>f.run({user:'alice',skillName:'checking',skillVersion:0,workspaceRoot:directory,triggerSet:{items:[{id:'one',query:'check',shouldTrigger:false}]},coreRuntime:{model:{id:'frozen',provider:'openai-compatible',model:'mock'},skills:[{name:'checking',version:0,content:'---\nname: checking\ndescription: check\n---\n'}],sample:(_id:string,perform:()=>Promise<unknown>)=>perform()}}),(error:unknown)=>(error as {code:string}).code==='CORE_TRIGGER_NOT_SUBMITTED');
 assert.ok(!f.events.includes('model'));assert.ok(!f.events.includes('indexed'));assert.equal(f.events.at(-1),'physical-exit');
});
