import assert from 'node:assert/strict';
import test from 'node:test';

process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';
const token='api_'+'T'.repeat(43);

test('actual Trigger RPC serialization binds the original HTTP operation across a lost response',async()=>{
 const core=await import('../src/lib/storage-core/experiments');const wire:string[]=[];
 const body={user:'forged',skillVersion:0,triggerSetId:'set'};
 const request=new Request('http://localhost/api/skill-eval/trigger/checking/run',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':'trigger-wire-intent'},body:JSON.stringify(body)});
 await core.withCoreExperiments(request,async()=>{
  const context=core.requireCoreExperimentContext();
  await context.rpc('trigger_begin',{manifest:{kind:'run'},config:{}});
 },{fetcher:async(url,options)=>{
  if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json({principal_id:'alice',username:'legacy-alice',workspace_id:'w',workspaces:[{workspace_id:'w'}]});
  assert.equal(new Headers(options?.headers).get('authorization'),'Bearer '+token);
  wire.push(String(options?.body));const value=JSON.parse(wire.at(-1)!);
  assert.equal(value.action,'trigger_begin');assert.equal(value.operation_key,'trigger-wire-intent');
  assert.deepEqual(value.operation_request,{method:'POST',path:'/api/skill-eval/trigger/checking/run',ifMatch:null,body});
  if(wire.length===1)throw TypeError('lost response');
  return Response.json({value:{run:{id:'durable-run'},experiment_id:'durable-run'}});
 }});
 assert.equal(wire.length,2);assert.equal(wire[0],wire[1]);
});

test('actual draft checkpoint/result/delete RPCs keep original operation metadata and verified frozen-assets signatures',async(t)=>{
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const path=await import('node:path');
 const directory=mkdtempSync(path.join(tmpdir(),'trigger-wire-proof-')),key='a'.repeat(64),file=path.join(directory,'controller-key');writeFileSync(file,key,{mode:0o600});
 const before=process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE;process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=file;t.after(()=>{if(before===undefined)delete process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE;else process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=before;rmSync(directory,{recursive:true,force:true});});
 const core=await import('../src/lib/storage-core/experiments'),controller=await import('../src/lib/storage-core/controller');const sent:string[]=[];
 const request=new Request('http://localhost/api/skill-eval/trigger/checking/draft',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':'draft-wire-intent'},body:JSON.stringify({user:'forged'})});
 await core.withCoreExperiments(request,async()=>{const context=core.requireCoreExperimentContext();for(const [action,payload] of [['trigger_delete_draft',{run_id:'draft'}],['trigger_delete_draft_cleanup',{run_id:'draft',proof:{cleanup:'confirmed'}}],['checkpoint',{trigger_draft:true,checkpoint:{_flow_model_calls:{'0':{state:'intent',request_hash:'b'.repeat(64)}}}}],['complete',{result:{evidence:{json:{coreTriggerDraft:{version:1}}}}}]] as const)await context.rpc(action,payload);},{fetcher:async(url,options)=>{
  if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json({principal_id:'alice',username:'legacy-alice',workspace_id:'w',workspaces:[{workspace_id:'w'}]});
  const raw=String(options?.body),value=JSON.parse(raw);sent.push(value.action);assert.equal(value.operation_key,'draft-wire-intent');assert.equal(value.operation_request.path,'/api/skill-eval/trigger/checking/draft');
  if(value.action!=='trigger_delete_draft')assert.equal(new Headers(options?.headers).get('x-storage-controller-proof'),controller.signControllerPayload(key,'experiment-frozen-assets/v1','alice','w',raw));
  return Response.json({value:{}});
 }});assert.equal(sent.length,4);
});

test('actual experiments transport preserves only the typed Trigger read conflict for the original runs handler',async()=>{
 const core=await import('../src/lib/storage-core/experiments');const {GET}=await import('../src/app/api/skill-eval/trigger/[skillName]/runs/route');const {requestCore}=await import('../src/lib/storage-core/server');
 const before=process.env.AGENT_INSIGHT_TRACE_STORAGE;process.env.AGENT_INSIGHT_TRACE_STORAGE='core';
 try{for(const [status,code,marked] of [[409,'TRIGGER_READ_CHANGED',true],[409,'OTHER_PRIVATE_CODE',false],[403,'TRIGGER_READ_CHANGED',false]] as const){
  const request=new Request('http://localhost/api/skill-eval/trigger/checking/runs?user=forged',{headers:{authorization:'Bearer '+token}});let reads=0;
  const response=await core.withCoreExperiments(request,()=>GET(request,{params:Promise.resolve({skillName:'checking'})}),{fetcher:async(url,options)=>{if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json({principal_id:'alice',username:'legacy-alice',workspace_id:'w',workspaces:[{workspace_id:'w'}]});const body=JSON.parse(String(options?.body));if(body.action==='trigger_scope')return Response.json({value:{authorized:true,operation:'read',principal_id:'alice',workspace_id:'w'}});assert.equal(body.action,'trigger_list');reads++;return Response.json({error:'private internal text',code},{status});}});
  assert.equal(reads,1);assert.equal(response.status,status);assert.equal(response.headers.get('x-storage-retry'),marked?'trigger-read-changed':null);assert.ok(!(await response.text()).includes('private internal text'));
 }
 await assert.rejects(requestCore('/v1/compat/benchmarks?workspace_id=w',{method:'POST',body:'{}'},async()=>Response.json({code:'TRIGGER_READ_CHANGED'},{status:409})),(error:unknown)=>(error as {code?:string}).code===undefined);
 }finally{if(before===undefined)delete process.env.AGENT_INSIGHT_TRACE_STORAGE;else process.env.AGENT_INSIGHT_TRACE_STORAGE=before;}
});
