import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import ts from 'typescript';
const nativeRequire=createRequire(import.meta.url);
function harness(fail?:string){
 const calls:string[]=[];const attempts:Record<string,number>={};let runCount=0;const exports:Record<string,unknown>={};
 const turn={session:{id:'chat'},messages:[],turn:{request_key:'req',fence:'2',lease_owner:'worker',revision:'1',state:'streaming'},trace_id:'canonical',opencode_session_id:null,duplicate:false,is_first_user_message:true,workspace_key:'diagnosis-'+'a'.repeat(64)};
 const deps:Record<string,unknown>={
  './compat':{compatibilityContext:async()=>({token:'private',workspace:'ws',username:'trusted-user',principal:'p'}),compatibilityFailure:(e:{status?:number})=>Response.json({error:'failed'},{status:e.status??503}),compatibleRequest:async()=>Response.json({session:null,messages:[]})},
  './evidence':{readTraceEvidence:async()=>({username:'trusted-user',evidence:{snapshot_hash:'a'.repeat(64),manifest:{trace_id:'canonical',workspace_id:'ws'},execution:{id:'original',taskId:'original-task',framework:'opencode',query:'frozen'},session:{interactions:[{content:'exact'}]}}})},
  './server':{readCoreBytes:async(body:ReadableStream<Uint8Array>|null)=>new Uint8Array(await new Response(body).arrayBuffer()),requestCore:async(url:string,options:{body?:string})=>{
   const body=JSON.parse(options.body||'{}');const action=new URL('http://localhost'+url).pathname.split('/').at(-1)!;calls.push(action);attempts[action]=(attempts[action]??0)+1;
   if(fail==='drop-'+action&&attempts[action]===1)throw Object.assign(Error('ambiguous committed response'),{status:502});
   if(action===fail)throw Object.assign(Error('private'),{status:503});
   if(action==='begin'){
    assert.equal(body.message,'Why?');assert.equal(body.executionId,'original-task');assert.equal('user'in body,false);return {data:{value:{...structuredClone(turn),duplicate:fail==='drop-begin',turn:{...turn.turn,lease_owner:body.lease_owner,request_key:body.request_key}}},status:200};
   }
   if(action==='agent-traces')return {data:{value:{task_id:'provider',state:'indexed',batch_refs:[{batch_id:'b'}]}},status:200};
   return {data:{value:{...turn,turn:{...turn.turn,revision:'2'}}},status:200};
  }},
  './diagnosis-stream':nativeRequire('../src/lib/storage-core/diagnosis-stream.ts'),
  './reports':{withCoreReports:async(_r:Request,callback:()=>Promise<unknown>)=>callback()},
  '@/lib/engine/general-agent/runner':{resolveGeneralAgentModel:async(user:string)=>{assert.equal(user,'trusted-user');return {providerID:'fixture',modelID:'fixture',apiKey:'never-persist'};},runGeneralAgent:async(input:any)=>{
   runCount++;assert.equal(input.user,'trusted-user');assert.equal(input.recordTraceAs,'fault-diagnosis-agent');assert.equal(input.trustedModel.apiKey,'never-persist');
   input.handlers.onText({delta:'Answer',fullText:'Answer'});
   await input.recordCoreTrace({record:{task_id:'provider'},rawMessages:[{info:{id:'real'}}]});return {sessionId:'provider',workspaceDir:'/isolated',output:'Answer',stats:{}};
  }},
  '@/lib/engine/general-agent/concurrency-limiter':{withBackgroundOpencodeSlot:(fn:()=>Promise<unknown>)=>fn()},
  '@/lib/shared/interaction-content':{normalizeClaudeCodeInteractionsForStorage:(v:unknown)=>v},
  '@/lib/engine/observability/subagent-inference':{inferSubagentNamesFromInteractions:(v:unknown)=>v},
  '@/lib/usage-analytics/config':{isUsageEnabled:()=>false},
  '@/lib/usage-analytics/collector':{recordUsageEvent:()=>{}},
  '@/lib/agent-insight-paths':{getPreferredInsightDir:()=>'/isolated'},
 };
 const source=ts.transpileModule(fs.readFileSync('src/lib/storage-core/diagnosis.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(source,{exports,require:(name:string)=>deps[name]??(name.startsWith('node:')?nativeRequire(name):(()=>{throw Error('Unexpected '+name)})()),Response,Request,URL,URLSearchParams,fetch,setTimeout,Buffer,TextDecoder,structuredClone,Date,console});
 const post=exports.handleCoreDiagnosisStream as (r:Request,options:unknown)=>Promise<Response>;
 return {post:()=>post(new Request('http://localhost/api/fault/diagnosis/stream',{method:'POST',body:JSON.stringify({user:'forged-owner',message:'Why?',executionId:'original-task',sessionId:null,executionBrief:{query:'untrusted'}})}),{prepare:async(args:any)=>{assert.equal(args.brief.query,'frozen');return {query:'real prompt',system:'system'};},reportContext:async()=>'',workspace:()=>'/isolated'}),calls,runs:()=>runCount};
}
test('verified diagnosis uses frozen evidence, actual caller model and indexed self Trace before done',async()=>{
 const h=harness();const response=await h.post();assert.equal(response.status,200);const wire=await response.text();assert.ok(wire.includes('event: done'));assert.ok(wire.includes('Answer'));assert.equal(h.runs(),1);assert.ok(h.calls.indexOf('agent-traces')<h.calls.indexOf('finish'));assert.ok(!wire.includes('never-persist'));
});
test('storage begin failure starts no Agent and indexed recorder failure never returns done',async()=>{
 const begin=harness('begin');assert.equal((await begin.post()).status,503);assert.equal(begin.runs(),0);
 const recorder=harness('agent-traces');const wire=await(await recorder.post()).text();assert.ok(wire.includes('event: error'));assert.ok(!wire.includes('event: done'));assert.equal(recorder.runs(),1);
});

test('exact retries recover committed begin, checkpoint and finish after a dropped response',async()=>{
 for(const action of ['begin','checkpoint','finish']){
  const h=harness('drop-'+action);const response=await h.post();const wire=await response.text();
  assert.ok(wire.includes('event: done'),action+': '+wire);assert.equal(h.runs(),1);assert.equal(h.calls.filter(v=>v===action).length,2);
 }
});
test('authorization lost after prompt preparation prevents model startup',async()=>{
 const h=harness('renew');const wire=await(await h.post()).text();assert.ok(wire.includes('event: error'));assert.equal(h.runs(),0);
});
