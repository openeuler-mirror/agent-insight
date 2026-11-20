import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {activateIsolatedHome} from './helpers/isolated-home';
import os from 'node:os';
import path from 'node:path';
import {createIsolatedDatabase} from './helpers/isolated-database';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'core-dataset-adapter-'));
const restore=activateIsolatedHome(home);
const database=createIsolatedDatabase();
test.after(async()=>{const {prismaRaw}=await import('./helpers/historical-prisma');await prismaRaw.$disconnect();database.dispose();restore();fs.rmSync(home,{recursive:true,force:true});});
const token='session_'+'D'.repeat(43);
const profile={username:'alice',principal_id:'alice',workspace_id:'w',workspaces:[{workspace_id:'w'}]};
const record={id:'dataset',user:'alice',name:'同名',description:'',targetAgent:'',targetSkill:'',tags:[],fields:[],cases:[{id:'case',input:'完整输入',expectedOutput:'答案',evaluationFocus:'',tags:[],trajectory:'',values:{'小数':0.25,flag:false}}],datasetKind:'ideal_output' as const,createdAt:'2026-11-13T00:00:00Z',updatedAt:'2026-11-13T00:00:00Z'};
const snapshot={dataset:record,revision:'7',lifecycle_revision:'1',release_id:'release-7',etag:'"dataset-7"'};
const request=(method='GET',headers:HeadersInit={},body?:unknown)=>new Request('http://localhost/api/agent-datasets?workspace_id=w&user=forged',{method,headers:{authorization:'Bearer '+token,...headers},...(body?{body:JSON.stringify(body)}:{})});
async function api(){
 process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';
 assert.ok(fs.existsSync('src/lib/storage-core/datasets.ts'),'trusted Dataset repository context must exist');
 return import('../src/lib/storage-core/datasets');
}
test('Dataset context follows the verified principal across asynchronous calls',async()=>{
 const m=await api();assert.equal(m.getCoreDatasetContext(),undefined);
 await m.withCoreDatasets(request(),async()=>{await Promise.resolve();assert.equal(m.requireCoreDatasetContext().actor.username,'alice');}, {fetcher:async()=>Response.json(profile)});
 assert.equal(m.getCoreDatasetContext(),undefined);assert.throws(()=>m.requireCoreDatasetContext());
});
test('an HTTP DELETE represented by an empty body stream still has no JSON payload',async()=>{
 const m=await api();let called=false;
 const input=new Request('http://localhost/api/agent-datasets/dataset?workspace_id=w',{method:'DELETE',body:'',headers:{authorization:'Bearer '+token}});
 assert.ok(input.body);
 await m.withCoreDatasets(input,async()=>{called=true;assert.deepEqual(m.requireCoreDatasetContext().body,{});},{fetcher:async()=>Response.json(profile)});
 assert.ok(called);
});
test('shared server identity resolution accepts its ordinary single-request call',async()=>{
 const {compatibilityContext}=await import('../src/lib/storage-core/compat');await api();const originalFetch=globalThis.fetch;
 globalThis.fetch=async()=>Response.json(profile);
 try{assert.equal((await compatibilityContext(request())).username,'alice');}finally{globalThis.fetch=originalFetch;}
});
test('generation transport preserves only the bounded safe error code and status',async()=>{
 await api();const {requestCore}=await import('../src/lib/storage-core/server');
 await assert.rejects(requestCore('/v1/compat/datasets/generation?workspace_id=w',{token,method:'POST',body:'{}'},async()=>Response.json({code:'REQUEST_EXPIRED',error:'private diagnostic detail'},{status:410})),(cause:unknown)=>{
  assert.ok(cause instanceof Error&&'status'in cause&&cause.status===410);assert.equal((cause as Error&{code?:string}).code,'REQUEST_EXPIRED');assert.doesNotMatch((cause as Error).message,/private diagnostic detail/);return true;
 });
});
test('Dataset reads use authenticated workspace and retain arbitrary JSON values',async()=>{
 const m=await api();let seen=false;
 await m.withCoreDatasets(request(),async()=>{
  const saved=await m.findCoreDataset('dataset');assert.deepEqual(saved?.cases[0].values,record.cases[0].values);assert.equal(saved?._storageEtag,snapshot.etag);
 },{fetcher:async(url,options)=>{
  if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json(profile);
  seen=true;assert.equal(new URL(String(url)).pathname,'/v1/compat/datasets');assert.equal(new URL(String(url)).searchParams.get('workspace_id'),'w');
  const body=JSON.parse(String(options?.body));assert.equal(body.action,'get');assert.equal(body.dataset_id,'dataset');assert.equal('user'in body,false);
  assert.equal(new Headers(options?.headers).get('authorization'),'Bearer '+token);return Response.json({value:snapshot});
 }});assert.ok(seen);
});
test('the Case detail repository requests a single Case projection',async()=>{
 const m=await api();let projected=false;
 const input=new Request('http://localhost/api/agent-datasets/dataset?workspace_id=w&view=case&caseId=case',{headers:{authorization:'Bearer '+token}});
 await m.withCoreDatasets(input,()=>m.findCoreDataset('dataset'),{fetcher:async(url,options)=>{
  if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json(profile);
  const body=JSON.parse(String(options?.body));assert.equal(body.view,'case');assert.equal(body.case_id,'case');projected=true;return Response.json({value:snapshot});
 }});assert.ok(projected);
});
test('Dataset version navigation requests bounded summaries instead of every historical Case body',async()=>{
 const m=await api();assert.equal(typeof m.listCoreDatasetVersions,'function');const {cases,...metadata}=record;
 const input=new Request('http://localhost/api/agent-datasets/dataset?workspace_id=w&view=versions',{headers:{authorization:'Bearer '+token}});
 await m.withCoreDatasets(input,async()=>{
  const rows=await m.listCoreDatasetVersions('dataset');assert.equal(rows[0].revision,'7');assert.equal('cases'in rows[0].dataset,false);
 },{fetcher:async(url,options)=>{
  if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json(profile);
  const body=JSON.parse(String(options?.body));assert.equal(body.action,'versions');assert.equal(body.view,'summary');return Response.json({value:[{...snapshot,dataset:{...metadata,caseCount:cases.length}}]});
 }});
});
test('stale or absent editing ETag never reaches a Dataset write',async()=>{
 const m=await api();
 for(const [etag,status]of [[undefined,428],['"dataset-6"',409]] as const){
  let writes=0;
  await m.withCoreDatasets(request('PATCH',etag?{'if-match':etag}:{},{id:'dataset'}),async()=>{
   await m.findCoreDataset('dataset');await assert.rejects(m.saveCoreDataset(structuredClone(record)),(e:unknown)=>Boolean(e&&typeof e==='object'&&'status'in e&&e.status===status));
  },{fetcher:async(url,options)=>{
   if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json(profile);
   const body=JSON.parse(String(options?.body));if(body.action==='save')writes++;return Response.json({value:snapshot});
  }});assert.equal(writes,0);
 }
});
test('ambiguous submission retries exactly the same Dataset operation and body',async()=>{
 const m=await api();const bodies:string[]=[];let calls=0;
 await m.withCoreDatasets(request('PATCH',{'if-match':snapshot.etag,'idempotency-key':'same-operation'},{id:'dataset',cases:record.cases}),async()=>{
  await m.findCoreDataset('dataset');await m.saveCoreDataset(structuredClone(record));
 },{fetcher:async(url,options)=>{
  if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json(profile);
  const body=JSON.parse(String(options?.body));if(body.action==='get')return Response.json({value:snapshot});
  bodies.push(String(options?.body));if(++calls===1)throw new TypeError('connection lost after commit');return Response.json({value:snapshot});
 }});assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);assert.equal(JSON.parse(bodies[0]).expected_revision,'7');assert.equal(JSON.parse(bodies[0]).operation_request.ifMatch,snapshot.etag);
});
test('core mode without a trusted repository scope rejects reads and writes before Prisma',async()=>{
 const storage=await import('../src/server/agent_datasets_storage');const {prismaRaw}=await import('./helpers/historical-prisma');
 process.env.AGENT_INSIGHT_TRACE_STORAGE='core';const before=await prismaRaw.agentEvalDataset.count();
 try{
  const rejected=(cause:unknown)=>Boolean(cause&&typeof cause==='object'&&'status'in cause&&cause.status===503);
  await assert.rejects(storage.readUserAgentDatasets('alice'),rejected);
  await assert.rejects(storage.createAgentDatasetRecord({...record,id:'must-not-shadow'}),rejected);
  assert.equal(await prismaRaw.agentEvalDataset.count(),before);
 }finally{delete process.env.AGENT_INSIGHT_TRACE_STORAGE;}
});
test('builtin catalog projection keeps stable Case IDs while applying new catalog contents',async()=>{
 const m=await api();
 await m.withCoreDatasets(request(),async()=>{
  const first=m.registerCoreBuiltinDataset({...record,id:'',cases:[{...record.cases[0],id:'random-a',values:{fault_injection_type:'fault',submode:'one'}}]});
  const changed=m.registerCoreBuiltinDataset({...first,cases:[{...first.cases[0],input:'new label'},{...first.cases[0],id:'random-b',values:{fault_injection_type:'fault',submode:'two'}}]},first.cases);
  const repeat=m.registerCoreBuiltinDataset({...first,cases:[{...first.cases[0],input:'new label'},{...first.cases[0],id:'random-c',values:{fault_injection_type:'fault',submode:'two'}}]},first.cases);
  assert.equal(changed.cases[0].id,first.cases[0].id);assert.equal(changed.cases[1].id,repeat.cases[1].id);assert.equal(changed._storageEtag,repeat._storageEtag);
  const rows=await m.listCoreDatasets('summary');assert.equal(rows[0].caseCount,2);assert.equal('cases'in rows[0],false);
 },{fetcher:async(url)=>new URL(String(url)).pathname==='/v1/auth/me'?Response.json(profile):Response.json({value:[]})});
});
test('the shared Dataset repository reads and writes core without touching legacy rows',async()=>{
 const {prismaRaw}=await import('./helpers/historical-prisma');
  await prismaRaw.agentEvalDataset.create({data:{id:'legacy-sentinel',user:'alice',name:'Old Dataset'}});
  const storage=await import('../src/server/agent_datasets_storage');const m=await api();const actions:string[]=[];
  await m.withCoreDatasets(request('POST',{},record),async()=>{
   const rows=await storage.readUserAgentDatasets('forged');assert.equal(rows.length,1);assert.equal(rows[0].id,record.id);
   const saved=structuredClone(record);await storage.createAgentDatasetRecord(saved);assert.equal(saved.id,record.id);
  },{fetcher:async(url,options)=>{
   if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json(profile);
   const body=JSON.parse(String(options?.body));actions.push(body.action);return Response.json({value:body.action==='list'?[record]:snapshot});
  }});
  assert.deepEqual(actions,['list','save']);assert.equal(await prismaRaw.agentEvalDataset.count(),1);
  assert.equal((await prismaRaw.agentEvalDataset.findUniqueOrThrow({where:{id:'legacy-sentinel'}})).name,'Old Dataset');
});
test('the original Dataset POST binds the authenticated actor and never writes Prisma in core mode',async()=>{
 const {POST}=await import('../src/app/api/agent-datasets/route');
 const {prismaRaw}=await import('./helpers/historical-prisma');
 const originalFetch=globalThis.fetch;process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_USAGE_ENABLED='0';
 let saves=0;
 globalThis.fetch=async(url,options)=>{
  if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json(profile);
  const body=JSON.parse(String(options?.body));
  if(body.action==='lookup')return Response.json({value:null});
  assert.equal(body.action,'save');saves++;assert.equal(body.record.user,'alice');
  return Response.json({value:{...snapshot,dataset:{...body.record,user:'alice'}}});
 };
 try{
  const before=await prismaRaw.agentEvalDataset.count();
  const response=await POST(request('POST',{}, {user:'forged',name:'new',cases:[]}));
  assert.equal(response.status,200);assert.equal((await response.json()).dataset.user,'alice');assert.equal(saves,1);
  assert.equal(await prismaRaw.agentEvalDataset.count(),before);
 }finally{globalThis.fetch=originalFetch;delete process.env.AGENT_INSIGHT_TRACE_STORAGE;}
});
test('deleting a generated Dataset uses the fenced core job protocol',async()=>{
 const filename=path.resolve('src/app/api/agent-datasets/[id]/route.ts');const actual=createRequire(filename);const exports:Record<string,unknown>={};
 const source=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const dependencies:Record<string,unknown>={
  '@/server/trace-datasets/manager':{getTraceDatasetManager:async()=>{throw Error('Legacy manager is forbidden');}},
  '@/server/trace-datasets/http':{traceIdentity:async()=> 'alice',guardTraceDataset:async()=>false},
 };
 vm.runInNewContext(source,{exports,require:(name:string)=>name in dependencies?dependencies[name]:actual(name),Response,Request,URL,console,process},{filename});
 const remove=exports.DELETE as (request:Request,context:{params:Promise<{id:string}>})=>Promise<Response>;
 const originalFetch=globalThis.fetch;process.env.AGENT_INSIGHT_TRACE_STORAGE='core';let removed=false;
 globalThis.fetch=async(url,options)=>{
  const target=new URL(String(url));if(target.pathname==='/v1/auth/me')return Response.json(profile);
  const body=JSON.parse(String(options?.body));
  if(body.action==='lookup')return Response.json({value:null});
  if(body.action==='get')return Response.json({value:{...snapshot,dataset:{...record,generationSource:'trace',generationStatus:'published'}}});
  assert.equal(target.pathname,'/v1/compat/datasets/generation');assert.equal(body.action,'remove');assert.equal(body.expectedRevision,'7');removed=true;
  return Response.json({value:{deletionId:'deletion',status:'deleting'}});
 };
 try{
  const input=new Request('http://localhost/api/agent-datasets/dataset?workspace_id=w&user=forged',{method:'DELETE',headers:{authorization:'Bearer '+token,'if-match':snapshot.etag}});
  const response=await remove(input,{params:Promise.resolve({id:'dataset'})});assert.equal(response.status,202);assert.ok(removed);
 }finally{globalThis.fetch=originalFetch;delete process.env.AGENT_INSIGHT_TRACE_STORAGE;}
});
test('concurrent backflow retries against the latest Dataset instead of replacing another append',async()=>{
 const {POST}=await import('../src/app/api/agent-datasets/backflow/route');
 const originalFetch=globalThis.fetch;process.env.AGENT_INSIGHT_TRACE_STORAGE='core';
 let changed=false;let saved:typeof record|undefined;const actions:string[]=[];
 const current={...record,fields:[{id:'input',key:'input',label:'Input',type:'text'}],cases:[] as typeof record.cases};
 globalThis.fetch=async(url,options)=>{
  if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json(profile);
  const body=JSON.parse(String(options?.body));actions.push(body.action);if(body.action==='lookup')return Response.json({value:null});
  if(body.action==='get')return Response.json({value:{...snapshot,dataset:current,revision:changed?'8':'7',etag:changed?'"dataset-8"':snapshot.etag}});
  assert.equal(body.action,'save');
  if(!changed){changed=true;current.cases.push({...record.cases[0],id:'other-case',input:'other append'});return Response.json({error:'State conflict'},{status:409});}
  saved=body.record;assert.equal(body.expected_revision,'8');return Response.json({value:{...snapshot,dataset:body.record,revision:'9',etag:'"dataset-9"',operation_result:body.operation_result}});
 };
 try{
  const response=await POST(new Request('http://localhost/api/agent-datasets/backflow?workspace_id=w',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({user:'forged',mode:'existing',datasetId:'dataset',cases:[{values:{input:'new append'}}]})}));
  assert.equal(response.status,200,JSON.stringify({body:await response.clone().json(),actions,changed}));assert.equal((await response.json()).inserted,1);assert.equal(saved?.cases.length,2);assert.equal(saved?.cases[0].input,'other append');
 }finally{globalThis.fetch=originalFetch;delete process.env.AGENT_INSIGHT_TRACE_STORAGE;}
});
test('duplicate-only backflow records its exact reply without creating a new Dataset version',async()=>{
 const {POST}=await import('../src/app/api/agent-datasets/backflow/route');const originalFetch=globalThis.fetch;process.env.AGENT_INSIGHT_TRACE_STORAGE='core';
 const source={taskId:'source',capturedAt:'2026-11-13T00:00:00Z'};
 const current={...record,fields:[{id:'input',key:'input',label:'Input',type:'text'}],cases:[{...record.cases[0],traceSource:source}]};
 let stored:unknown;const actions:string[]=[];
 globalThis.fetch=async(url,options)=>{
  if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json(profile);
  const body=JSON.parse(String(options?.body));actions.push(body.action);
  if(body.action==='lookup')return Response.json({value:stored||null});
  if(body.action==='get')return Response.json({value:{...snapshot,dataset:current}});
  assert.equal(body.action,'record_operation');assert.equal(body.expected_revision,'7');stored={...snapshot,dataset:current,operation_result:body.operation_result};return Response.json({value:stored});
 };
 const input=()=>new Request('http://localhost/api/agent-datasets/backflow?workspace_id=w',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':'duplicates-only'},body:JSON.stringify({user:'forged',mode:'existing',datasetId:'dataset',cases:[{values:{input:'same source'},traceSource:source}]})});
 try{
  const first=await POST(input());assert.equal(first.status,200);const body=await first.json();assert.equal(body.inserted,0);assert.equal(body.skippedDuplicates,1);
  const replay=await POST(input());assert.deepEqual(await replay.json(),body);assert.deepEqual(actions,['lookup','get','record_operation','lookup']);
 }finally{globalThis.fetch=originalFetch;delete process.env.AGENT_INSIGHT_TRACE_STORAGE;}
});
