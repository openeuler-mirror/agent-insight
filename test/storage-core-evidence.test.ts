import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { isStorageCoreEnabled } from '../src/lib/storage-core/mode';

const token='session_'+'E'.repeat(43);
const profile={username:'alice',principal_id:'alice',workspace_id:'w',workspaces:[{workspace_id:'w'}]};
const evidence={format:'agent-insight.trace-evidence',version:1,captured_at:'2026-11-13T00:00:00.000Z',snapshot_hash:'f'.repeat(64),manifest:{workspace_id:'w',trace_id:'internal'},execution:{id:'original-execution',taskId:'original-task',query:'Complete query',finalResult:'Complete output',framework:'opencode'},session:{taskId:'original-task',interactions:[{role:'assistant',content:'body',opaque:{v:0.4}}]}};
const request=()=>new Request('http://localhost/api/agent-datasets/trace-drafts?user=forged',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({user:'forged',taskId:'original-task'})});

test('evidence helper uses authenticated core scope and bounded private endpoint only',async()=>{
 process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';
 const {readTraceEvidence}=await import('../src/lib/storage-core/evidence');let calls=0;
 const result=await readTraceEvidence(request(),{taskId:'original-task'},{fetcher:async(url,options)=>{
  calls++;assert.equal(new Headers(options?.headers).get('authorization'),'Bearer '+token);assert.equal(options?.redirect,'error');
  const u=new URL(String(url));if(u.pathname==='/v1/auth/me')return Response.json(profile);
  assert.equal(u.pathname,'/v1/compat/observe/evidence');assert.equal(u.searchParams.get('workspace_id'),'w');assert.equal(u.searchParams.get('taskId'),'original-task');assert.equal(u.searchParams.has('user'),false);
  return Response.json({value:evidence});
 }});
 assert.equal(result.username,'alice');assert.deepEqual(result.evidence,evidence);assert.equal(calls,2);
});

test('evidence helper rejects missing evidence, mismatched scope and backend failures',async()=>{
 const {readTraceEvidence}=await import('../src/lib/storage-core/evidence');
 for(const value of [{value:{}},{value:{...evidence,manifest:{workspace_id:'other'}}}]){
  await assert.rejects(readTraceEvidence(request(),{taskId:'original-task'},{fetcher:async url=>new URL(String(url)).pathname==='/v1/auth/me'?Response.json(profile):Response.json(value)}));
 }
 for(const status of [401,403,409,413,503]){
  await assert.rejects(readTraceEvidence(request(),{taskId:'original-task'},{fetcher:async url=>new URL(String(url)).pathname==='/v1/auth/me'?Response.json(profile):Response.json({error:'private raw secret'},{status})}),error=>typeof error==='object'&&error!==null&&'status' in error&&error.status===status&&!String(error).includes('private raw secret'));
 }
});

function route(core:boolean,result:unknown={evidence,username:'alice'},failure?:number){
 const exports:Record<string,unknown>={};let oldReads=0;let usage=0;let normalizations=0;
 const dependencies:Record<string,unknown>={
  'next/server':{NextResponse:Response},
  '@/lib/storage-core/mode':{isStorageCoreEnabled:()=>isStorageCoreEnabled({AGENT_INSIGHT_TRACE_STORAGE:core?'core':'legacy'})},
  '@/lib/storage-core/evidence':{TRACE_EVIDENCE_BYTES:16*1024*1024,readTraceEvidence:async()=>{if(failure)throw Object.assign(new Error('private'),{status:failure});return result;}},
  '@/lib/storage-core/compat':{compatibilityFailure:(error:{status?:number})=>Response.json({error:'Storage request failed'},{status:error.status||503})},
  '@/lib/storage-core/server':{readCoreBytes:async(body:ReadableStream<Uint8Array>|null,limit:number)=>{const raw=new Uint8Array(await new Response(body).arrayBuffer());if(raw.length>limit)throw Object.assign(new Error('large'),{status:413});return raw;}},
  '@/lib/usage-analytics/collector':{recordUsageEvent:(event:{user:string})=>{assert.equal(event.user,'alice');usage++;}},
  '@/lib/engine/evaluation/task-artifacts':{extractTaskArtifacts:async(args:{rawInput:string;fallbackOutput:string;interactions:unknown[]})=>({input:args.rawInput,output:args.fallbackOutput,trace:args.interactions,warnings:[]})},
  '@/lib/engine/observability/subagent-inference':{inferSubagentNamesFromInteractions:(rows:unknown[])=>rows},
  '@/lib/storage/prisma':{db:{findExecutions:async()=>{oldReads++;return [{id:'legacy-execution',taskId:'legacy-task',query:'legacy',user:'alice'}]},findSessionByTaskId:async()=>{oldReads++;return {user:'alice',interactions:'[]'}}}},
  '@/lib/shared/interaction-content':{normalizeClaudeCodeInteractionsForStorage:(rows:unknown[])=>{normalizations++;return rows;}}
 };
 const filename='src/app/api/agent-datasets/trace-drafts/route.ts';
 const source=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(source,{exports,require:(name:string)=>{if(!(name in dependencies))throw new Error('Unexpected '+name);return dependencies[name]},Response,Request,Buffer,TextDecoder,Date,console:{error:()=>{}}});
 return {post:exports.POST as (request:Request)=>Promise<Response>,counts:()=>({oldReads,usage,normalizations})};
}

test('original draft DTO is preserved with verified actor and complete opaque interactions',async()=>{
 const h=route(true);const response=await h.post(request());assert.equal(response.status,200);
 assert.deepEqual(await response.json(),{draft:{values:{input:'Complete query',output:'Complete output',trace:evidence.session.interactions},traceSource:{taskId:'original-task',executionId:'original-execution',capturedAt:evidence.captured_at}},warnings:[]});
 assert.deepEqual(h.counts(),{oldReads:0,usage:1,normalizations:0});
});

test('core evidence failure never falls back to legacy data or records success',async()=>{
 for(const status of [401,403,409,413,503]){const h=route(true,undefined,status);assert.equal((await h.post(request())).status,status);assert.deepEqual(h.counts(),{oldReads:0,usage:0,normalizations:0});}
});

test('core draft retains explicit null overrides and existing Claude Code normalization',async()=>{
 const value=structuredClone(evidence);value.execution.query=null as unknown as string;value.execution.finalResult=null as unknown as string;value.execution.framework='claudecode';
 const h=route(true,{evidence:value,username:'alice'});const response=await h.post(request());const data=await response.json();
 assert.equal(data.draft.values.input,'');assert.equal(data.draft.values.output,'');assert.equal(h.counts().normalizations,1);assert.equal(h.counts().oldReads,0);
});

test('mode off preserves the original legacy draft route',async()=>{
 const h=route(false);const response=await h.post(new Request('http://localhost/api/agent-datasets/trace-drafts',{method:'POST',body:JSON.stringify({user:'alice',taskId:'legacy-task'})}));
 assert.equal(response.status,200);assert.equal(h.counts().oldReads,2);assert.equal((await response.json()).draft.traceSource.executionId,'legacy-execution');
});

test('evidence transport failures are unavailable and never expose upstream details',async()=>{
 const {readTraceEvidence}=await import('../src/lib/storage-core/evidence');
 for(const fetcher of [(async()=>{throw new Error('secret network path')}) as typeof fetch,(async()=>new Response('{"username":"bad"}',{status:500})) as typeof fetch]){
  await assert.rejects(readTraceEvidence(request(),{taskId:'original-task'},{fetcher}),error=>typeof error==='object'&&error!==null&&'status'in error&&error.status===503&&!String(error).includes('secret network path'));
 }
});
