import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

test('core generation routes authenticate actor, keep DTOs, and never obtain legacy manager',async()=>{
 const source=readFileSync('src/lib/storage-core/dataset-generation.ts','utf8');
 const requests:Record<string,unknown>[]=[];const dispatched:string[]=[];const upstream={error:undefined as unknown};
 const actor={token:'private-token',workspace:'w',principal:'alice',username:'alice'};
 const loaded={exports:{}};
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const dependencies:Record<string,unknown>={
  './compat':{compatibilityContext:async()=>actor,compatibilityFailure:(error:Error)=>Response.json({error:error.message},{status:503})},
  './server':{readCoreBytes:async(body:ReadableStream)=>new Uint8Array(await new Response(body).arrayBuffer()),requestCore:async(_url:string,opts:{body:string})=>{if(upstream.error)throw upstream.error;const body=JSON.parse(opts.body);requests.push(body);return {data:{value:body.action==='create'?{datasetId:'dataset',jobId:'job'}:body.action==='progress'?{status:'published',datasetId:'dataset'}:{platforms:[],agents:[]}},status:200};}},
  './core-generation-worker':{activateGeneration:(_actor:unknown,id:string)=>{dispatched.push(id);}},
  '@/lib/trace-datasets/sampling/production':{PRODUCTION_POLICY:{version:'frozen',seed:635}},
  '@/server/trace-datasets/catalog':{platformCatalog:()=>new Map()},
 };
 vm.runInNewContext(js,{module:loaded,exports:loaded.exports,require:(id:string)=>{if(!(id in dependencies))throw new Error('Unexpected legacy dependency '+id);return dependencies[id];},Request,Response,URL,URLSearchParams,TextDecoder,Buffer,fetch});
 const api=loaded.exports as {handleCoreDatasetGeneration:(request:Request,action:string,datasetId?:string)=>Promise<Response>};
 const response=await api.handleCoreDatasetGeneration(new Request('http://localhost/api/agent-datasets/trace-generation',{method:'POST',body:JSON.stringify({name:'data',user:'forged',policy:{version:'forged'}})}),'create');
 assert.equal(response.status,202);assert.deepEqual(await response.json(),{datasetId:'dataset',jobId:'job'});
 assert.equal((requests[0].config as Record<string,unknown>).user,undefined);assert.equal(((requests[0].config as Record<string,unknown>).policy as Record<string,unknown>).version,'frozen');
 assert.deepEqual(dispatched,['dataset']);
 await api.handleCoreDatasetGeneration(new Request('http://localhost/api/agent-datasets/dataset/generation'),'progress','dataset');
 assert.deepEqual(dispatched,['dataset','dataset']);
 upstream.error={status:422,code:'SOURCE_NOT_AVAILABLE'};
 const failed=await api.handleCoreDatasetGeneration(new Request('http://localhost/api/agent-datasets/generation-options'),'catalog');
 assert.equal(failed.status,422);assert.equal((await failed.json()).error.code,'SOURCE_NOT_AVAILABLE');
});

test('core worker uses production sampling and publishes actual complete cases without Prisma',async()=>{
 const {runCoreGeneration}=await import('../src/lib/storage-core/core-generation-worker');
 const {PRODUCTION_POLICY}=await import('../src/lib/trace-datasets/sampling/production');
 const actions:string[]=[];let completed:{cases:Array<{input:string;expectedOutput:string}>;summary:{sourceTraces:number;retainedTraces:number}}|undefined;
 const members=[{id:'trace-a',fingerprint:'a'.repeat(64)},{id:'trace-b',fingerprint:'b'.repeat(64)}];
 const rpc=async(action:string,body:Record<string,unknown>)=>{
  actions.push(action);
  if(action==='source_members')return {items:members,next:null};
  if(action==='source'){
   const question=body.traceId==='trace-a'?'Review the first database migration thoroughly':'Review the second database migration and explain differences';
   const answer='The migration includes immutable releases, access controls, and a verified safe transaction.';
   return {revision:body.expectedFingerprint,source:{query:question,finalResult:answer,completed:true,failed:false,isSubagent:false,platform:'opencode',events:[{role:'user',content:question},{role:'assistant',content:answer}]}};
  }
  if(action==='complete'){completed=body as unknown as NonNullable<typeof completed>;return {status:'published'};}
  if(action==='fail')throw new Error('Unexpected failure '+JSON.stringify(body));
  return {renewed:true};
 };
 await runCoreGeneration({jobId:'job',datasetId:'dataset',epoch:1,leaseOwner:'worker',config:{limit:2,policy:PRODUCTION_POLICY}},rpc);
 assert.ok(completed,'real source cases must reach atomic publish');assert.equal(completed.cases.length,2);
 assert.ok(completed.cases.every(row=>row.input.includes('database migration')&&row.expectedOutput.includes('immutable releases')));
 assert.equal(completed.summary.sourceTraces,2);assert.equal(completed.summary.retainedTraces,2);assert.ok(!actions.includes('fail'));
});

test('revoked or stale job aborts source access and never publishes empty success',async()=>{
 const {runCoreGeneration}=await import('../src/lib/storage-core/core-generation-worker');
 const {PRODUCTION_POLICY}=await import('../src/lib/trace-datasets/sampling/production');
 const actions:string[]=[];
 await runCoreGeneration({jobId:'job',datasetId:'dataset',epoch:1,leaseOwner:'worker',config:{limit:1,policy:PRODUCTION_POLICY}},async(action)=>{
  actions.push(action);if(action==='checkpoint')throw Object.assign(new Error('revoked'),{status:403});return {};
 });
 assert.ok(!actions.includes('source'));assert.ok(!actions.includes('complete'));assert.ok(actions.includes('fail'));
});

test('all original generation endpoints branch before touching legacy manager in core mode',async()=>{
 const cases=[['trace-generation/route.ts','POST','create'],['generation-options/route.ts','GET','catalog'],['[id]/generation/route.ts','GET','progress'],['[id]/generation/route.ts','DELETE','release'],['[id]/generation/cancel/route.ts','POST','cancel'],['deletions/[deletionId]/route.ts','GET','deletion']];
 for(const [file,method,action] of cases){
  const loaded={exports:{}};let called='';
  const js=ts.transpileModule(readFileSync('src/app/api/agent-datasets/'+file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const dependencies:Record<string,unknown>={
   '@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},
   '@/lib/storage-core/dataset-generation':{handleCoreDatasetGeneration:async(_request:Request,selected:string)=>{called=selected;return Response.json({selected});}},
   'next/server':{NextResponse:Response},
   '@/server/trace-datasets/http':{traceIdentity:()=>{throw new Error('legacy identity bypass');},generationErrorResponse:()=>{throw new Error('legacy error bypass');}},
   '@/server/trace-datasets/manager':{getTraceDatasetManager:()=>{throw new Error('Prisma generation bypass');}},
   '@/server/trace-datasets/catalog':{},'@/lib/trace-datasets/contracts':{},
  };
  vm.runInNewContext(js,{module:loaded,exports:loaded.exports,require:(id:string)=>{if(!(id in dependencies))throw new Error('Unexpected dependency '+id);return dependencies[id];},Response});
  const api=loaded.exports as Record<string,(request:Request,context:{params:Promise<Record<string,string>>})=>Promise<Response>>;
  await api[method](new Request('http://localhost/api/agent-datasets'),{params:Promise.resolve({id:'dataset',deletionId:'deletion'})});assert.equal(called,action);
 }
});
