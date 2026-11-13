import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {AsyncResource} from 'node:async_hooks';
import vm from 'node:vm';
import ts from 'typescript';
import { activateIsolatedHome } from './helpers/isolated-home';
import { getTrustedCoreAgentContext } from '../src/lib/engine/general-agent/trusted-context';
import test from 'node:test';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'core-report-handler-'));
const restore=activateIsolatedHome(home);
test.after(()=>{restore();fs.rmSync(home,{recursive:true,force:true});});

const token='session_'+'R'.repeat(43);
const request=()=>new Request('http://localhost/api/report?workspace_id=w&user=forged',{headers:{authorization:'Bearer '+token}});
const profile={username:'alice',principal_id:'alice',workspace_id:'w',workspaces:[{workspace_id:'w'}]};
async function api(){
 assert.equal(fs.existsSync('src/lib/storage-core/reports.ts'),true,'trusted report context must exist');
 return import('../src/lib/storage-core/reports');
}
test('report context binds verified actor and workspace across asynchronous callbacks',async()=>{
 process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';
 const m=await api();assert.equal(m.getCoreReportContext(),undefined);
 await m.withCoreReports(request(),async()=>{
  await Promise.resolve();const ctx=m.requireCoreReportContext();
  assert.equal(ctx.actor.username,'alice');assert.equal(ctx.actor.workspace,'w');assert.equal(ctx.actor.token,token);
 },{fetcher:async()=>Response.json(profile)});
 assert.equal(m.getCoreReportContext(),undefined);
 assert.throws(()=>m.requireCoreReportContext());
});
test('report reads use bounded authenticated core calls and never caller supplied identity',async()=>{
 const m=await api();let seen=false;
 await m.withCoreReports(request(),async()=>{
  const result=await m.readCoreStoredReport('root','agent-debug');assert.equal(result.row,null);
 },{fetcher:async(url,options)=>{
  const target=new URL(String(url));
  if(target.pathname==='/v1/auth/me')return Response.json(profile);
  seen=true;assert.equal(target.pathname,'/v1/compat/observe/reports/agent-debug');assert.equal(target.searchParams.get('executionId'),'root');assert.equal(target.searchParams.get('workspace_id'),'w');assert.equal(target.searchParams.has('user'),false);assert.equal(new Headers(options?.headers).get('authorization'),'Bearer '+token);
  return Response.json({value:{row:null,payload:null,progress:null}});
 }});
 assert.equal(seen,true);
});


async function reportHarness(options:{badReceipt?:boolean;denyProgress?:boolean;cached?:boolean;waitForAbort?:boolean;failHeartbeatAt?:number;ambiguous?:boolean;skills?:boolean}={}){
 process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';
 let heartbeatCallback:(()=>void)|undefined;
 const interval=options.waitForAbort?((callback:()=>void,delay:number)=>{assert.equal(delay,15000);heartbeatCallback=AsyncResource.bind(callback);return {unref:()=>{}};}):setInterval;
 const clear=options.waitForAbort?(()=>{heartbeatCallback=undefined;}):clearInterval;
 const filename=path.resolve('src/lib/storage-core/report-handlers.ts');const actual=createRequire(filename);const exports:Record<string,unknown>={};
 const trusted=actual('@/lib/engine/general-agent/trusted-context') as typeof import('../src/lib/engine/general-agent/trusted-context');
 const dependencies:Record<string,unknown>={
  './diagnosis':{diagnosisWorkspace:()=>{throw Error('unexpected workspace preparation');}},
  '@/lib/engine/general-agent/runner':{...trusted,resolveGeneralAgentModel:async()=>{throw Error('unexpected model reread');}},
  '@/lib/engine/general-agent/concurrency-limiter':{withBackgroundOpencodeSlot:async()=>{throw Error('unexpected slot');}},
 };
 const source=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
 vm.runInNewContext(source,{exports,require:(name:string)=>name in dependencies?dependencies[name]:actual(name),process,Buffer,Response,Request,URLSearchParams,URL,TextDecoder,Date,Error,AbortController,console,setTimeout,clearTimeout,setInterval:interval,clearInterval:clear,structuredClone},{filename});
 const handler=exports as unknown as typeof import('../src/lib/storage-core/report-handlers');
 let value:{row:Record<string,unknown>|null;payload:Record<string,unknown>|null;progress:unknown}={row:null,payload:null,progress:null};
 let privateLease='';const mutationRequests:string[]=[];const receipts=new Map<string,string>();let beginResponseLost=false;let progressResponseLost=false;let terminalResponseLost=false;let calls=0;let modelCalls=0;let executions=0;let indexed=0;let progressWrites=0;let cancelled=false;
 let notifyStarted!:()=>void;const started=new Promise<void>(resolve=>{notifyStarted=resolve;});
 const evidence={format:'agent-insight.trace-evidence',version:1,captured_at:'2026-11-13T00:00:00Z',snapshot_hash:'f'.repeat(64),manifest:{workspace_id:'w',trace_id:'internal'},execution:{id:'root',taskId:'task',query:'full original',framework:'opencode'},session:{taskId:'task',interactions:[{role:'assistant',content:'evidence'}]}};
 if(options.cached)value={row:{id:'report',executionId:'root',status:'done',revision:'2',interactionsHash:'a'.repeat(64)},payload:{status:'done',stats:{}},progress:null};
 const fetcher:typeof fetch=async(url,init)=>{
  const target=new URL(String(url));const method=init?.method||'GET';calls++;
  assert.equal(new Headers(init?.headers).get('authorization'),'Bearer '+token);
  if(target.pathname==='/v1/auth/me')return Response.json(profile);
  if(target.pathname.endsWith('/evidence'))return Response.json({value:evidence});
  if(target.pathname.endsWith('/agent-traces')){
   const body=JSON.parse(String(init?.body));assert.equal(body.context.parent_trace_id,'internal');assert.equal(body.context.report_run_id,'report');assert.equal(body.context.report_lease_token,privateLease);indexed++;
   return Response.json({value:{state:options.badReceipt?'accepted':'indexed',task_id:body.record.task_id}});
  }
  if(method==='POST'){
   const raw=String(init?.body);const body=JSON.parse(raw);mutationRequests.push(raw);assert.equal(body.user,undefined);assert.equal(body.expectedSnapshotHash,'f'.repeat(64));
   if(options.ambiguous&&beginResponseLost){assert.equal(raw,mutationRequests[0]);return Response.json({value:{...value,cached:false,busy:false,leaseToken:privateLease}});}
   if(options.cached)return Response.json({value:{...value,cached:true,busy:false}});
   privateLease=body.leaseToken;assert.match(privateLease,/^[A-Za-z0-9_-]{43}$/);
   value={row:{id:'report',executionId:'root',status:'running',revision:'1',interactionsHash:body.interactionsHash},payload:body.payload||null,progress:null};
   if(options.ambiguous&&!beginResponseLost){beginResponseLost=true;throw Error('begin commit response lost');}
   return Response.json({value:{...value,cached:false,busy:false,leaseToken:privateLease}});
  }
  if(method==='PATCH'){
   const raw=String(init?.body);const body=JSON.parse(raw);mutationRequests.push(raw);assert.equal(typeof body.requestKey,'string');
   if(receipts.has(body.requestKey)){assert.equal(receipts.get(body.requestKey),raw);return Response.json({value});}
   assert.equal(body.leaseToken,privateLease);assert.equal(String(body.revision),String(value.row?.revision),'checkpoints must serialize exact revisions');
   if(body.progress){progressWrites++;if(body.progress.events?.some((event:{key?:string})=>event.key==='done'))assert.equal(body.status,'done','completion progress and the report must publish atomically');}
   if(body.progress&&(options.denyProgress||(options.failHeartbeatAt!==undefined&&progressWrites>=options.failHeartbeatAt)))return Response.json({error:'denied'},{status:403});
   value={row:{...value.row,status:body.status||value.row?.status,revision:String(BigInt(String(value.row?.revision))+1n),errorMessage:body.errorMessage||null},payload:body.payload??value.payload,progress:body.progress??value.progress};
   receipts.set(body.requestKey,raw);
   if(options.ambiguous&&(!body.status&&!progressResponseLost||body.status==='done'&&!terminalResponseLost)){if(body.status)terminalResponseLost=true;else progressResponseLost=true;throw Error('patch commit response lost');}
   return Response.json({value});
  }
  return Response.json({value});
 };
 const call=()=>handler.handleCoreReport(new Request('http://localhost/api/report?workspace_id=w',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({user:'forged',...(options.skills?{force:true}:{})})}),'root',options.skills?'skills-analysis':'agent-debug',{
  fetcher,model:async user=>{assert.equal(user,'alice');modelCalls++;return {providerID:'fixture',modelID:'frozen-model',apiKey:'private-model-key'};},workspace:()=>home,
  background:async(run,user)=>{assert.equal(user,'alice');await run();},
  execute:async input=>{
   executions++;notifyStarted();assert.equal(input.user,'alice');assert.equal(getTrustedCoreAgentContext()?.trustedModel.modelID,'frozen-model');
   if(options.waitForAbort)await new Promise<void>((_resolve,reject)=>{input.runtime.cancelSignal!.addEventListener('abort',()=>{cancelled=true;reject(input.runtime.cancelSignal!.reason);},{once:true});});
   await input.runtime.recordCoreTrace({record:{task_id:'report-agent',user:'alice',framework:'opencode',interactions:[{role:'assistant',content:'actual report reasoning'}]},rawMessages:[{role:'assistant',content:'original provider'}]});
   return {status:'done',stats:{stepCount:1,issueCount:0,llmCallCount:1,durationMs:1},findings:[]};
  },
 });
 const settle=async()=>{const deadline=Date.now()+4000;while(Date.now()<deadline&&value.row?.status==='running')await new Promise(resolve=>setTimeout(resolve,5));assert.notEqual(value.row?.status,'running');};
 return {call,settle,started,heartbeat:()=>heartbeatCallback?.(),state:()=>value,counts:()=>({calls,modelCalls,executions,indexed,progressWrites,cancelled,beginResponseLost,progressResponseLost,terminalResponseLost})};
}

test('public report generation binds frozen evidence, persists progress, and publishes only after indexed Agent Trace',async()=>{
 const h=await reportHarness();const response=await h.call();assert.equal(response.status,202);
 const body=await response.json();assert.equal(body.reportId,'report');assert.equal(JSON.stringify(body).includes('private-lease'),false);
 await h.settle();assert.equal(h.state().row?.status,'done');assert.equal(h.counts().indexed,1);assert.equal(h.counts().executions,1);
 assert.deepEqual(h.state().payload?.coreTraceReceipts,[{state:'indexed',task_id:'report-agent'}]);
 assert.equal(JSON.stringify(h.state().payload).includes('private-model-key'),false);assert.equal(JSON.stringify(h.state().payload).includes(token),false);
});
test('unindexed self-Trace cannot produce a successful report',async()=>{
 const h=await reportHarness({badReceipt:true});assert.equal((await h.call()).status,202);await h.settle();assert.equal(h.state().row?.status,'failed');assert.equal(h.state().payload,null);
});
test('denied initial progress prevents actual Agent execution',async()=>{
 const h=await reportHarness({denyProgress:true});assert.equal((await h.call()).status,202);await h.settle();assert.equal(h.counts().executions,0);assert.equal(h.state().row?.status,'failed');
});
test('cached report reads do not require model or workspace preparation',async()=>{
 const h=await reportHarness({cached:true});const response=await h.call();assert.equal(response.status,200);assert.equal((await response.json()).cached,true);assert.equal(h.counts().modelCalls,0);assert.equal(h.counts().executions,0);
});

test('silent report Agents renew their lease and checkpoint failures abort the actual running Agent',async()=>{
  const h=await reportHarness({waitForAbort:true,failHeartbeatAt:4});assert.equal((await h.call()).status,202);await h.started;
  h.heartbeat();
  const deadline=Date.now()+2000;while(h.counts().progressWrites<3&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(h.counts().progressWrites,3,'a silent model must still renew its publication lease');assert.equal(h.counts().cancelled,false);
  h.heartbeat();await h.settle();assert.equal(h.counts().cancelled,true);assert.equal(h.state().row?.status,'failed');
});

test('ambiguous report mutations retry identical private operation bodies without replaying conflicts',async()=>{
 const m=await api();const bodies:string[]=[];let committed=false;
 await m.withCoreReports(request(),async()=>{
  const value=await m.coreReportRequest('agent-debug',{method:'POST',body:{executionId:'root'}});assert.equal(value.row?.id,'report');
 },{fetcher:async(url,init)=>{
  if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json(profile);
  const raw=String(init?.body);bodies.push(raw);const body=JSON.parse(raw);
  assert.match(body.leaseToken,/^[A-Za-z0-9_-]{43}$/);assert.equal(typeof body.requestKey,'string');
  if(!committed){committed=true;throw Error('commit response lost');}
  return Response.json({value:{row:{id:'report',executionId:'root',status:'running',revision:'1',interactionsHash:'a'.repeat(64)},payload:null,progress:null,leaseToken:body.leaseToken}});
 }});
 assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);
 let conflicts=0;
 await m.withCoreReports(request(),async()=>{
  await assert.rejects(m.coreReportRequest('agent-debug',{method:'PATCH',reportId:'report',body:{revision:'1',leaseToken:'L'.repeat(43),progress:{}}}),error=>!!error&&typeof error==='object'&&'status'in error&&error.status===409);
 },{fetcher:async(url)=>new URL(String(url)).pathname==='/v1/auth/me'?Response.json(profile):(conflicts++,Response.json({error:'conflict'},{status:409}))});
 assert.equal(conflicts,1);
});


test('committed begin, progress and terminal response loss recover one actual Agent job',async()=>{
 const h=await reportHarness({ambiguous:true});assert.equal((await h.call()).status,202);await h.settle();
 assert.equal(h.state().row?.status,'done');assert.equal(h.counts().executions,1);assert.equal(h.counts().indexed,1);
 assert.equal(h.counts().beginResponseLost,true);assert.equal(h.counts().progressResponseLost,true);assert.equal(h.counts().terminalResponseLost,true);assert.equal(h.counts().cancelled,false);
});
test('original Skills generation force body reserves and runs through the same authenticated pipeline',async()=>{
 const h=await reportHarness({skills:true});const response=await h.call();assert.equal(response.status,202);await h.settle();assert.equal(h.state().row?.status,'done');assert.equal(h.counts().executions,1);
});
