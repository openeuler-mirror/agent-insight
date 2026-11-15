import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

function load(file:string,dependencies:Record<string,unknown>){const module={exports:{}};const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;vm.runInNewContext(code,{module,exports:module.exports,require:(name:string)=>{if(!(name in dependencies))throw Error('Unexpected dependency '+name);return dependencies[name];},process,Request,Response,URL,URLSearchParams,Buffer,Map,Set,Date,JSON,Promise,structuredClone,setTimeout,clearTimeout,setInterval,clearInterval,setImmediate,console:{warn:()=>{},error:()=>{},log:()=>{}}});return module.exports as Record<string,Function>;}

function startupFixture(core:boolean){
 const legacy:string[]=[];let starts=0;const noop=async()=>{};
 const api=load('src/instrumentation-node.ts',{
  'node:fs':{existsSync:()=>false},'node:path':path,'child_process':{spawn:()=>{throw Error('unexpected subprocess');}},'@/lib/env':{getAgentInsightHome:()=>'/isolated'},
  '@/lib/storage-core/mode':{isStorageCoreEnabled:()=>core},'@/lib/storage-core/experiment-background':{startCoreExperimentBackground:()=>{starts++;}},
  '@/lib/engine/experiment/cancellation-service':{startExperimentCancellationWatchdog:()=>legacy.push('cancel-watchdog')},
  '@/lib/system-agents':{ensureAllSystemAgents:noop},'@/server/builtin-example/ensure-example-file':{ensureExampleMessagesFile:()=>''},
  '@/lib/engine/skill-generation/opencode-agent-cli/opencode-manager':{registerExitHandlers:()=>{},sweepOrphanedOpencodeProcesses:()=>{}},
  '@/lib/storage/prisma':{prismaRaw:new Proxy({},{get:(_target,key)=>{legacy.push(String(key));return {updateMany:async()=>({count:0})};}})},
  '@/lib/grayscale/startup-reap':{reapStaleGrayscaleRunsAtStartup:async()=>{legacy.push('grayscale');return 0;}},
  '@/lib/benchmark/scheduler':{startBenchmarkRunWatchdog:()=>legacy.push('benchmark-watchdog'),reapStaleBenchmarkRuns:async()=>{legacy.push('benchmark-reap');return 0;},resumeBenchmarkDispatchesAtStartup:async()=>{legacy.push('benchmark-resume');return 0;}},
  '@/lib/benchmark/evaluation-scheduler':{startBenchmarkEvaluationWatchdog:()=>legacy.push('benchmark-eval-watchdog'),reapStaleBenchmarkEvaluations:async()=>{legacy.push('benchmark-eval-reap');return 0;},resumeBenchmarkEvaluationDispatchesAtStartup:async()=>{legacy.push('benchmark-eval-resume');return 0;}},
  '@/lib/benchmark/evaluation-continuation-service':{resumeBenchmarkEvaluationContinuations:async()=>{legacy.push('benchmark-eval-continue');return 0;}},
  '@/lib/ingest/otel-consumer/consumer':{startOtelSpoolConsumer:()=>{}},'@/lib/infra/poller':{startInfraPoller:()=>{}},
  '@/lib/engine/experiment/experiment-watch':{startExperimentWatcher:()=>legacy.push('experiment-watch')},'@/server/trace-datasets/manager':{startTraceDatasetManager:()=>{}},
 });
 return {api,legacy,get starts(){return starts;}};
}

test('core startup preserves old evaluation, grayscale and benchmark data without starting their legacy reapers',async()=>{const fixture=startupFixture(true);await fixture.api.setupNodeRuntime();assert.deepEqual(fixture.legacy,[]);assert.equal(fixture.starts,1);});

test('legacy startup retains its original reapers, resumers and watchers',async()=>{const fixture=startupFixture(false);await fixture.api.setupNodeRuntime();assert.equal(fixture.starts,0);for(const name of ['cancel-watchdog','trajectoryEvalResult','skillTriggerEvalRun','grayscale','benchmark-watchdog','benchmark-reap','benchmark-resume','benchmark-eval-watchdog','benchmark-eval-reap','benchmark-eval-resume','benchmark-eval-continue','experiment-watch'])assert.ok(fixture.legacy.includes(name),name);});

test('restart identity loading authenticates configured credentials and keeps the legacy model owner separate',async()=>{
 const {configuredCoreBackgroundActors}=await import('@/lib/storage-core/compat');
 const root=mkdtempSync(path.join(os.tmpdir(),'core-background-'));const file=path.join(root,'actors.json');const token='api_'+'A'.repeat(43),revoked='api_'+'B'.repeat(43);
 const previous={file:process.env.AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE,url:process.env.AGENT_INSIGHT_STORAGE_CORE_URL};
 process.env.AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE=file;process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';
 writeFileSync(file,JSON.stringify({version:1,core_origin:'http://127.0.0.1:19000',bindings:[{legacy_username:'old-model-owner',legacy_api_key_sha256:'a'.repeat(64),principal_id:'p',workspace_id:'w',credential:token},{legacy_username:'revoked',legacy_api_key_sha256:'b'.repeat(64),principal_id:'revoked',workspace_id:'w',credential:revoked}]}),{mode:0o600});
 let requests=0;const fetcher:typeof fetch=async(_url,options)=>{requests++;if(new Headers(options?.headers).get('authorization')==='Bearer '+revoked)return Response.json({error:'Unauthorized'},{status:401});return Response.json({principal_id:'p',username:'core-owner',workspaces:[{workspace_id:'w'}]});};
 try{const result=await configuredCoreBackgroundActors({fetcher});assert.equal(requests,2);assert.equal(result.actors.length,1);assert.equal(result.actors[0].username,'old-model-owner');assert.equal(result.actors[0].principalUsername,'core-owner');assert.deepEqual(result.failures,[401]);chmodSync(file,0o644);await assert.rejects(configuredCoreBackgroundActors({fetcher}),error=>(error as {status:number}).status===503);}
 finally{if(previous.file===undefined)delete process.env.AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE;else process.env.AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE=previous.file;if(previous.url===undefined)delete process.env.AGENT_INSIGHT_STORAGE_CORE_URL;else process.env.AGENT_INSIGHT_STORAGE_CORE_URL=previous.url;rmSync(root,{recursive:true,force:true});}
});

function backgroundFixture(){
 const actor={token:'api_'+'A'.repeat(43),workspace:'w',principal:'p',username:'old-model-owner',principalUsername:'core-owner'};const calls:Array<{action:string;payload?:Record<string,unknown>}>=[];
 const source={current_run_id:'original-run',experiment:{id:'watch',user:'core-owner',scope:'',type:'single',status:'draft',watchMode:true,watchEnabledAt:'2026-11-14T00:00:00Z',agentName:'agent',cases:[] as Array<Record<string,unknown>>,evaluatorIdsJson:'["preset-text-exact-match"]',configSnapshotJson:'{}'},revision:'1'};
 let denyOrdinary=false;let benchmarkCancellations:Array<{id:string}>=[];let startFailures=0;let rows:Record<string,unknown>[]=[];let enabled=true;let head:Record<string,unknown>=source;let heads:Record<string,unknown>[]=[head];let pending:Record<string,unknown>|null=null;let cancellations:Record<string,unknown>[]=[];
 const context={actor,operationKey:'authenticated',options:{},request:new Request('http://localhost/internal'),body:{},rpc:async(action:string,payload:Record<string,unknown>={})=>{
  calls.push({action,payload});if(denyOrdinary&&['list','cancellations'].includes(action))throw Object.assign(new Error('read is not granted'),{status:403});if(action==='list')return enabled?heads:[];if(action==='read')return heads.find(row=>(row.experiment as {id:string}).id===payload.experiment_id)||head;if(action==='cancellations')return cancellations;
  if(action==='case_upsert'){const item=payload.case as Record<string,unknown>;const selected=heads.find(row=>(row.experiment as {id:string}).id===payload.experiment_id)||head;const items=(selected.experiment as {cases:Array<Record<string,unknown>>}).cases;const exists=items.some(row=>row.id===item.id);if(!exists)items.push(item);return {...selected,case_id:item.id,reused:exists};}
  if(action==='claim'){const handle=pending;pending=null;return handle;}if(action==='load_work')return {handle:payload,execution_request:{kind:'fi'}};
  throw Error('Unexpected '+action);
 }};
 let current=context;let benchmarkGate:Promise<void>=Promise.resolve();
 const deps:Record<string,unknown>={
  'node:crypto':{createHash:require('node:crypto').createHash,randomUUID:()=> 'worker'},
  './compat':{configuredCoreBackgroundActors:async()=>({actors:[actor],failures:[]})},
  './experiments':{withCoreConfiguredExperiments:async(_actor:unknown,fn:Function)=>fn(),requireCoreExperimentContext:()=>current,runWithCoreExperimentContext:async(ctx:typeof context,fn:Function)=>{const previous=current;current=ctx;try{return await fn();}finally{current=previous;}}},
  './experiment-traces':{readCoreExperimentTraces:async()=>rows},
  './experiment-cancellation':{reconcileCoreCancellation:async(_ctx:unknown,id:string)=>{calls.push({action:'cleanup',payload:{id}});}},
  './experiment-assets':{startCoreExperiment:async(_ctx:unknown,id:string,options:Record<string,unknown>)=>{calls.push({action:'direct-start',payload:{id,...options}});for(const item of source.experiment.cases)if((options.caseIds as string[]).includes(String(item.id)))item.results=[{status:'done'}];}},
  './experiment-worker':{activateExperimentWork:async()=>{calls.push({action:'activate'});}},
  './experiment-trace-worker':{runCoreTraceWork:async()=>calls.push({action:'execute-ordinary'})},
  './experiment-fi-worker':{runCoreFiWork:async()=>calls.push({action:'execute-fi'})},
  '@/lib/benchmark/core-cancellation':{readPendingCoreBenchmarkCancellations:async(_context:unknown,limit:number,afterId?:string)=>{calls.push({action:'benchmark-cancellation-scan',payload:{limit,afterId}});return benchmarkCancellations.filter(row=>row.id>(afterId||'')).slice(0,limit);},reconcileCoreBenchmarkCancellation:async(_context:unknown,id:string)=>{calls.push({action:'benchmark-cleanup',payload:{id}});return {id,status:'pending'};}},
  '@/lib/benchmark/core-runtime':{resumeCoreBenchmarkIntents:async(options:Record<string,unknown>)=>{assert.equal(current.actor.username,'old-model-owner');calls.push({action:'benchmark-intents',payload:options});await benchmarkGate;return {completed:0,deferred:0};}},
  '@/lib/engine/experiment/run-experiment':{addEvalExperimentCase:async(_id:string,item:Record<string,unknown>)=>{assert.equal(current.actor.username,'old-model-owner');const existing=source.experiment.cases.find(row=>row.taskId===item.taskId);if(existing)return null;const row={id:'case-'+item.taskId,...item};source.experiment.cases.push(row);calls.push({action:'append',payload:row});return row.id;},startEvalExperimentCases:async(id:string,caseIds:string[],user:string)=>{if(startFailures-->0)throw Object.assign(new Error('temporary plan failure'),{status:503});calls.push({action:'score',payload:{id,caseIds,user}});for(const item of source.experiment.cases)if(caseIds.includes(String(item.id)))item.results=[{status:'done'}];return {completion:Promise.resolve()};}},
 };
 return {api:()=>load('src/lib/storage-core/experiment-background.ts',deps),calls,source,denyOrdinaryReads:()=>{denyOrdinary=true;},setBenchmarkCancellations:(value:Array<{id:string}>)=>{benchmarkCancellations=value;},setBenchmarkGate:(value:Promise<void>)=>{benchmarkGate=value;},failStart:()=>{startFailures=1;},setRows:(value:Record<string,unknown>[])=>{rows=value;},setHeads:(value:Record<string,unknown>[])=>{heads=value;},setHead:(value:Record<string,unknown>)=>{head=value;heads=[head];},setCancellations:(value:Record<string,unknown>[])=>{cancellations=value;},setPending:(value:Record<string,unknown>|null)=>{pending=value;},disable:()=>{enabled=false;}};
}

const observed={user:'core-owner',agentName:'agent',task_id:'late-task',upload_id:'late-exec',timestamp:'2026-11-14T00:01:00Z',trace_completed_at:'2026-11-14T00:02:00Z',trace_status:'success',agentOwnership:'user',is_subagent:false,query:'late input',final_result:'late answer'};

test('background watch rescans late completion, deduplicates by durable Case and stops adding after watch is disabled',async()=>{
 const f=backgroundFixture();const manager=f.api().createCoreExperimentBackground();f.setRows([{...observed,trace_status:'running',trace_completed_at:null}]);
 await manager.scan();await manager.waitForIdle();assert.equal(f.calls.filter(row=>row.action==='case_upsert').length,0);
 f.setRows([observed]);await manager.scan();await manager.waitForIdle();await manager.scan();await manager.waitForIdle();
 assert.equal(f.calls.filter(row=>row.action==='case_upsert').length,1);assert.equal(f.calls.filter(row=>row.action==='score').length,1);
 f.source.experiment.watchMode=false;f.setRows([observed,{...observed,task_id:'new-task',upload_id:'new-exec'}]);await manager.scan();await manager.waitForIdle();assert.equal(f.calls.filter(row=>row.action==='case_upsert').length,1);
});

test('direct auto-watch appends frozen request metadata and schedules actual evaluator slots without latest-definition reads',async()=>{
 const f=backgroundFixture();f.source.experiment.scope='trajectory-direct';f.source.experiment.evaluatorIdsJson='["__direct_trajectory__:custom-original"]';
 f.source.experiment.cases.push({id:'placeholder',directTrajectory:{id:'placeholder',datasetId:'',caseId:'',rawAnalysisJson:JSON.stringify({selectedEvaluators:['custom-original'],selectedEvaluatorNames:['Original'],autoWatch:true,watchedAgent:'agent',watchPlaceholder:true,customEvaluatorSnapshots:{schemaVersion:1,cards:{'custom-original':{id:'custom-original',name:'Original'}}}})}});
 f.setRows([observed]);const manager=f.api().createCoreExperimentBackground();await manager.scan();await manager.waitForIdle();
 const writes=f.calls.filter(row=>row.action==='case_upsert');assert.equal(writes.length,1);assert.equal(writes[0].payload?.only_if_new,true);
 const packet=(writes[0].payload?.case as {directTrajectory:{rawAnalysisJson:string}}).directTrajectory;const metadata=JSON.parse(packet.rawAnalysisJson);assert.equal(metadata.customEvaluatorSnapshots.cards['custom-original'].name,'Original');assert.equal(metadata.watchPlaceholder,undefined);
 assert.deepEqual(f.calls.find(row=>row.action==='direct-start')?.payload?.evaluatorIds,['__direct_trajectory__:custom-original']);assert.equal(f.calls.filter(row=>row.action==='activate').length,1);
 await manager.scan();await manager.waitForIdle();assert.equal(f.calls.filter(row=>row.action==='case_upsert').length,1);
});

test('restart recovery claims existing execution work and resumes its frozen FI kind without constructing a new RunPlan',async()=>{
 const f=backgroundFixture();f.source.experiment.watchMode=false;f.source.experiment.status='running';f.setPending({experiment_id:'watch',run_id:'original-run',attempt_id:'new-fence-attempt',fence:'7',lease_owner:'worker'});
 let clock=1000;const manager=f.api().createCoreExperimentBackground({now:()=>clock});await manager.scan();await manager.waitForIdle();assert.equal(f.calls.some(row=>row.action==='claim'),false);clock+=30001;await manager.scan();await manager.waitForIdle();assert.equal(f.calls.filter(row=>row.action==='execute-fi').length,1);assert.equal(f.calls.filter(row=>row.action==='activate').length,1);assert.equal(f.calls.some(row=>['start','execute_start','direct-start'].includes(row.action)),false);assert.equal(f.calls.find(row=>row.action==='claim')?.payload?.recovery_only_if_idle,true);
});


test('a durable auto-watch Case whose RunPlan start was interrupted is resumed on the next tick',async()=>{
 const f=backgroundFixture();f.failStart();f.setRows([observed]);const manager=f.api().createCoreExperimentBackground();await manager.scan();await manager.waitForIdle();assert.equal(f.source.experiment.cases.length,1);assert.equal(f.calls.filter(row=>row.action==='score').length,0);
 await manager.scan();await manager.waitForIdle();assert.equal(f.source.experiment.cases.length,1);assert.equal(f.calls.filter(row=>row.action==='score').length,1);
});

test('generic recovery leaves Benchmark Harness work to its dedicated domain',async()=>{
 const f=backgroundFixture();f.source.experiment.scope='benchmark';f.source.experiment.status='running';f.source.experiment.watchMode=false;f.setPending({experiment_id:'watch',run_id:'benchmark-run',attempt_id:'attempt',fence:'2',lease_owner:'worker'});const manager=f.api().createCoreExperimentBackground();await manager.scan();await manager.waitForIdle();assert.equal(f.calls.some(row=>['claim','activate','execute-fi'].includes(row.action)),false);
});


test('original cancellation service exports require a trusted core actor and never inspect old cancellation rows',async()=>{
 let old=0;const calls:unknown[]=[];const legacy=new Proxy({},{get(){old++;throw Error('Legacy mutation forbidden');}});const context={actor:{username:'owner'}};
 const api=load('src/lib/engine/experiment/cancellation-service.ts',{
  'node:crypto':{randomUUID:()=> 'id'},'@/lib/storage/prisma':{prisma:legacy},'@/lib/reliability/command-bus':{},'@/lib/reliability/control-dispatch':{},
  '@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},'@/lib/storage-core/experiments':{requireCoreExperimentContext:()=>context},
  '@/lib/storage-core/experiment-cancellation':{cancelCoreExperimentExecution:async(_ctx:unknown,id:string,options:unknown)=>{calls.push([id,options]);return {id:'cancel',status:'pending'};},reconcileCoreCancellation:async(_ctx:unknown,id:string)=>{calls.push(id);return {id,status:'completed'};}},
 });
 await assert.rejects(api.deleteExperimentExecution('forged','exp'),error=>(error as {status:number}).status===403);
 assert.equal((await api.deleteExperimentExecution('owner','exp','case')).status,'pending');assert.equal((await api.reconcileCancellation('cancel')).status,'completed');assert.equal(old,0);assert.deepEqual(JSON.parse(JSON.stringify(calls)),[['exp',{caseId:'case'}],'cancel']);
});


test('background watch rotates across experiments so a busy head cannot monopolize the worker budget',async()=>{
 const f=backgroundFixture();const other=structuredClone(f.source);other.experiment.id='watch-two';f.setHeads([f.source,other]);f.setRows(Array.from({length:5},(_,index)=>({...observed,task_id:'task-'+index,upload_id:'execution-'+index})));
 const manager=f.api().createCoreExperimentBackground({concurrency:1});await manager.scan();await manager.waitForIdle();await manager.scan();await manager.waitForIdle();
 assert.deepEqual(f.calls.filter(row=>row.action==='score').map(row=>row.payload?.id),['watch','watch-two']);
});


test('privileged background actors coordinate only their own cancellation receipts',async()=>{
 const f=backgroundFixture();f.source.experiment.watchMode=false;f.setCancellations([{id:'foreign',user:'another-owner'},{id:'own',user:'core-owner'}]);const manager=f.api().createCoreExperimentBackground();await manager.scan();await manager.waitForIdle();assert.deepEqual(f.calls.filter(row=>row.action==='cleanup').map(row=>row.payload?.id),['own']);assert.equal(f.calls.find(row=>row.action==='cancellations')?.payload?.owned_only,true);assert.equal(f.calls.find(row=>row.action==='cancellations')?.payload?.oldest_first,true);
});


test('the background actor also resumes bounded Benchmark intents without legacy watchdogs',async()=>{
 const f=backgroundFixture();f.source.experiment.watchMode=false;const manager=f.api().createCoreExperimentBackground();
 await manager.scan();await manager.waitForIdle();const calls=f.calls.filter(row=>row.action==='benchmark-intents');assert.equal(calls.length,1);assert.equal(calls[0].payload?.limit,1);
});


test('an outstanding Benchmark transport does not occupy ordinary watch capacity or duplicate its intent worker',async()=>{
 const f=backgroundFixture();let release!:()=>void;f.setBenchmarkGate(new Promise<void>(resolve=>{release=resolve;}));f.setRows([observed]);
 const manager=f.api().createCoreExperimentBackground({concurrency:1});
 try{
  await manager.scan();for(let tick=0;tick<100&&!f.calls.some(row=>row.action==='score');tick++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.filter(row=>row.action==='score').length,1);
  await manager.scan();assert.equal(f.calls.filter(row=>row.action==='benchmark-intents').length,1);
 }finally{release();await manager.waitForIdle();}
});


test('restart recovers Benchmark supplemental scoring without claiming Harness execution work',async()=>{
 const f=backgroundFixture();f.source.experiment.scope='benchmark';f.source.experiment.status='running';f.source.experiment.watchMode=false;
 let clock=1000;const manager=f.api().createCoreExperimentBackground({now:()=>clock});await manager.scan();await manager.waitForIdle();clock+=30001;await manager.scan();await manager.waitForIdle();
 assert.equal(f.calls.filter(row=>row.action==='activate').length,1);assert.equal(f.calls.some(row=>['claim','execute-fi','execute-ordinary','score','direct-start'].includes(row.action)),false);
});


test('delete-only background actors resume their durable Benchmark cleanup before ordinary reads and rotate the cursor',async()=>{
 const f=backgroundFixture();f.denyOrdinaryReads();f.setBenchmarkCancellations([{id:'a'},{id:'b'}]);const manager=f.api().createCoreExperimentBackground({concurrency:1});
 await manager.scan();await manager.waitForIdle();assert.deepEqual(f.calls.filter(row=>row.action==='benchmark-cleanup').map(row=>row.payload?.id),['a','b']);
 await manager.scan();await manager.waitForIdle();const scans=f.calls.filter(row=>row.action==='benchmark-cancellation-scan');assert.equal(scans[1].payload?.afterId,'b');
 await manager.scan();await manager.waitForIdle();assert.equal(f.calls.filter(row=>row.action==='benchmark-cancellation-scan')[2].payload?.afterId,undefined);
});
