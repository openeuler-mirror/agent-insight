import assert from 'node:assert/strict';
import test from 'node:test';
test('frozen model credentials are actor-bound, cloned, and scoped only to the current worker',async()=>{
 const scope=await import('../src/lib/storage-core/frozen-model');assert.equal(scope.frozenModelConfiguration('one').active,false);
 const configuration={id:'model',name:'选定模型',model:'original',provider:'openai',apiKey:'isolated-private-key'};
 await scope.runWithFrozenModelConfiguration('one',configuration,async()=>{
  const current=scope.frozenModelConfiguration('one');assert.equal(current.active,true);assert.equal(current.config?.model,'original');current.config!.model='changed';assert.equal(scope.frozenModelConfiguration('one').config?.model,'original');assert.throws(()=>scope.frozenModelConfiguration('two'),/identity|actor/i);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(scope.frozenModelConfiguration('one').config?.apiKey,'isolated-private-key');
 });assert.equal(scope.frozenModelConfiguration('one').active,false);
});
test('an explicitly absent frozen model blocks a later latest-model fallback',async()=>{
 const scope=await import('../src/lib/storage-core/frozen-model');await scope.runWithFrozenModelConfiguration('one',null,async()=>assert.deepEqual(scope.frozenModelConfiguration('one'),{active:true,config:null}));
});

test('the original evaluator recorder uses the current fenced experiment callback and never the legacy writer',async()=>{
 const {withCoreExperiments,prepareCoreExperimentRuntime,requireCoreExperimentContext}=await import('../src/lib/storage-core/experiments');
 const {recordEvaluatorExecution}=await import('../src/lib/engine/evaluation/evaluator-execution-recorder');
 const {getActiveConfig}=await import('../src/lib/storage/server-config');
 const old=process.env.AGENT_INSIGHT_TRACE_STORAGE;process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';let packets=0;
 const request=new Request('http://localhost/api/experiments/exp/run',{method:'POST',headers:{authorization:'Bearer api_'+'R'.repeat(43)},body:'{}'});
 const handle={experiment_id:'exp',run_id:'run',attempt_id:'attempt',fence:'3',lease_owner:'worker'};
 try{await withCoreExperiments(request,()=>prepareCoreExperimentRuntime(requireCoreExperimentContext(),{handle,runplan:{config:{model_selection:null}}},async()=>{
  assert.equal(await getActiveConfig('owner'),null);
  await recordEvaluatorExecution({listMessages:async()=>[]},{taskId:'judge-session',agentName:'judge',user:'owner',query:'含参考答案的评分请求',fallbackOutput:'实际判分完成'});
 }),{fetcher:async(url,options)=>{
  if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json({principal_id:'p',username:'owner',workspace_id:'w',workspaces:[{workspace_id:'w'}]});
  assert.equal(new URL(String(url)).pathname,'/v1/compat/observe/agent-traces');const body=JSON.parse(String(options?.body));assert.equal(body.context.experiment_id,'exp');assert.equal(body.context.experiment_attempt_id,'attempt');assert.equal(body.context.experiment_fence,'3');assert.equal(body.context.experiment_lease_owner,'worker');assert.ok(!String(options?.body).includes('api_'+'R'.repeat(43)));packets++;return Response.json({value:{task_id:'judge-session',state:'indexed'}});
 }});assert.equal(packets,1);}finally{if(old===undefined)delete process.env.AGENT_INSIGHT_TRACE_STORAGE;else process.env.AGENT_INSIGHT_TRACE_STORAGE=old;}
});

test('model selection records a connection fingerprint without persisting URL credentials or query secrets',async()=>{
 const {freezeModelSelection}=await import('../src/lib/storage-core/frozen-model');
 const model={id:'m',name:'测试',model:'selected',provider:'openai',apiKey:'header-key',baseUrl:'https://user:url-password@example.test/v1?api_key=query-secret&version=2'};
 const selected=freezeModelSelection(model);assert.equal(selected?.baseUrl,'https://example.test/v1');assert.match(String(selected?.connection_hash),/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(selected).includes('password'));assert.ok(!JSON.stringify(selected).includes('query-secret'));assert.ok(!JSON.stringify(selected).includes('header-key'));
 assert.notEqual(selected?.connection_hash,freezeModelSelection({...model,baseUrl:model.baseUrl.replace('version=2','version=3')})?.connection_hash);
});

test('diagnosis workers record their own fenced origin without an experiment identity',async()=>{
 const {withCoreExperiments,prepareCoreExperimentRuntime,requireCoreExperimentContext}=await import('../src/lib/storage-core/experiments');
 const {recordEvaluatorExecution}=await import('../src/lib/engine/evaluation/evaluator-execution-recorder');
 const old=process.env.AGENT_INSIGHT_TRACE_STORAGE;process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';let packets=0;
 const request=new Request('http://localhost/api/diagnosis-runs/run',{method:'POST',headers:{authorization:'Bearer api_'+'R'.repeat(43)},body:'{}'});
 const handle={diagnosis_id:'diagnosis',run_id:'diagnosis',attempt_id:'attempt',fence:'3',lease_owner:'worker'};
 try{await withCoreExperiments(request,()=>prepareCoreExperimentRuntime(requireCoreExperimentContext(),{handle,runplan:{config:{model_selection:null}}},async()=>{
  await recordEvaluatorExecution({listMessages:async()=>[]},{taskId:'diagnosis-session',agentName:'judge',user:'owner',query:'诊断输入',fallbackOutput:'实际诊断完成'});
 }),{fetcher:async(url,options)=>{
  if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json({principal_id:'p',username:'owner',workspace_id:'w',workspaces:[{workspace_id:'w'}]});
  const body=JSON.parse(String(options?.body));assert.deepEqual(body.context,{diagnosis_run_id:'diagnosis',diagnosis_attempt_id:'attempt',diagnosis_fence:'3',diagnosis_lease_owner:'worker'});packets++;return Response.json({value:{task_id:'diagnosis-session',state:'indexed'}});
 }});assert.equal(packets,1);}finally{if(old===undefined)delete process.env.AGENT_INSIGHT_TRACE_STORAGE;else process.env.AGENT_INSIGHT_TRACE_STORAGE=old;}
});

test('custom routing headers are frozen by a canonical hash without exposing their values',async()=>{
 const {freezeModelSelection}=await import('../src/lib/storage-core/frozen-model');
 const base={id:'m',name:'custom',provider:'custom',model:'selected',apiKey:'key',baseUrl:'https://example.test/v1'};
 const first=freezeModelSelection({...base,headers:{'X-Tenant':'tenant-a','X-Route':'route-a'}})!;
 const same=freezeModelSelection({...base,apiKey:'rotated-key',headers:{'x-route':'route-a','x-tenant':'tenant-a'}})!;
 const changed=freezeModelSelection({...base,headers:{'X-Tenant':'tenant-b','X-Route':'route-a'}})!;
 assert.equal(first.connection_hash,same.connection_hash);assert.notEqual(first.connection_hash,changed.connection_hash);assert.ok(!JSON.stringify(first).includes('tenant-a'));assert.ok(!JSON.stringify(first).includes('route-a'));
});

test('headerless v1 connection hashes remain readable without accepting new routing headers',async()=>{
 const {createHash}=await import('node:crypto');const {matchesFrozenModelSelection}=await import('../src/lib/storage-core/frozen-model');
 const model={id:'m',name:'model',provider:'custom',model:'selected',baseUrl:'https://example.test/v1',apiKey:'private'};
 const selection={id:'m',connection_hash:createHash('sha256').update(JSON.stringify({provider:model.provider,model:model.model,baseUrl:model.baseUrl})).digest('hex')};
 assert.equal(matchesFrozenModelSelection(model,selection),true);assert.equal(matchesFrozenModelSelection({...model,headers:{'X-Tenant':'added'}},selection),false);assert.equal(matchesFrozenModelSelection({...model,baseUrl:'https://another.test/v1'},selection),false);
});

test('a background runtime composes fresh identity scopes after its original HTTP body was consumed',async()=>{
 const {withCoreExperiments,prepareCoreExperimentRuntime,requireCoreExperimentContext}=await import('../src/lib/storage-core/experiments');
 const request=new Request('http://localhost/api/diagnosis-runs/submit?version=unrelated&view=case&caseId=unrelated',{method:'POST',headers:{authorization:'Bearer api_'+'R'.repeat(43)},body:'{}'});
 const old=process.env.AGENT_INSIGHT_STORAGE_CORE_URL;process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';let ran=false;
 try{await withCoreExperiments(request,async()=>{
  await request.json();assert.equal(request.bodyUsed,true);
  await prepareCoreExperimentRuntime(requireCoreExperimentContext(),{handle:{},runplan:{config:{model_selection:null}}},async()=>{const {requireCoreDatasetContext}=await import('../src/lib/storage-core/datasets');assert.deepEqual([...new URL(requireCoreDatasetContext().request.url).searchParams],[['workspace_id','w']]);ran=true;});
 },{fetcher:async()=>Response.json({principal_id:'p',username:'owner',workspace_id:'w',workspaces:[{workspace_id:'w'}]})});assert.equal(ran,true);
 }finally{if(old===undefined)delete process.env.AGENT_INSIGHT_STORAGE_CORE_URL;else process.env.AGENT_INSIGHT_STORAGE_CORE_URL=old;}
});


test('explicit model protocol is frozen and cannot be replaced on an existing queued selection', async () => {
 const { freezeModelSelection, matchesFrozenModelSelection } = await import('../src/lib/storage-core/frozen-model');
 const config={id:'protocol-test',name:'Protocol',provider:'custom',model:'same-model',apiKey:'',baseUrl:'https://gateway.test/v1'};
 const previous=freezeModelSelection(config)!;
 assert.equal(matchesFrozenModelSelection(config,previous),true);
 const native={...config,protocol:'anthropic' as const};
 assert.notEqual(freezeModelSelection(native)?.connection_hash,previous.connection_hash);
 assert.equal(matchesFrozenModelSelection(native,previous),false);
 assert.equal(matchesFrozenModelSelection(native,freezeModelSelection(native)!),true);
});
