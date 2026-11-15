import assert from 'node:assert/strict';
import test from 'node:test';
process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';
const token='api_'+'X'.repeat(43);
const request=(user='forged',method='POST')=>new Request('http://localhost/api/experiments?user='+user,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':'same-operation'},...(method==='GET'?{}:{body:JSON.stringify({user,name:'original',cases:[]})})});
const profile=(name:string)=>({principal_id:name+'-principal',username:name,workspace_id:'w',workspaces:[{workspace_id:'w'}]});

test('Experiment scope binds verified identity and leaves the original DTO body available',async()=>{
 const core=await import('../src/lib/storage-core/experiments');
 await core.withCoreExperiments(request(),async()=>{
  const context=core.requireCoreExperimentContext();assert.equal(context.actor.username,'owner');assert.equal(context.actor.workspace,'w');assert.equal(context.body.user,'forged');assert.equal(context.operationKey,'same-operation');
  assert.equal(await context.request.clone().text(),JSON.stringify(context.body));
 },{fetcher:async()=>Response.json(profile('owner'))});
 assert.equal(core.getCoreExperimentContext(),undefined);
});

test('Experiment RPC carries the same receipt and trusted scope on an exact network retry',async()=>{
 const core=await import('../src/lib/storage-core/experiments');let writes=0;let saved='';
 await core.withCoreExperiments(request(),async()=>{
  const result=await core.requireCoreExperimentContext().rpc('create',{experiment:{name:'original'}});assert.deepEqual(result,{id:'exp'});
 },{fetcher:async(url,options)=>{
  if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json(profile('owner'));
  assert.equal(new Headers(options?.headers).get('authorization'),'Bearer '+token);assert.equal(new URL(String(url)).searchParams.get('workspace_id'),'w');
  writes++;const body=String(options?.body);if(writes===1){saved=body;throw new TypeError('lost response');}assert.equal(body,saved);
  const parsed=JSON.parse(body);assert.equal(parsed.action,'create');assert.equal(parsed.operation_key,'same-operation');assert.equal(parsed.operation_request.body.user,'forged');return Response.json({value:{id:'exp'}});
 }});
 assert.equal(writes,2);
});

test('creation retries resolve committed HTTP receipt before reading a removed latest evaluator',async()=>{
 const core=await import('../src/lib/storage-core/experiments');const actions:string[]=[];
 await core.withCoreExperiments(request(),async()=>{
  assert.deepEqual(await core.createCoreExperimentRecord({name:'latest-card-removed',evaluatorIdsJson:'["deleted"]'}),{id:'original-exp'});
 },{fetcher:async(url,options)=>{
  if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json(profile('owner'));
  const body=JSON.parse(String(options?.body));actions.push(body.action);assert.equal(body.action,'lookup_operation');assert.equal(body.operation_kind,'create');assert.equal(body.operation_key,'same-operation');assert.deepEqual(body.operation_request.body,{user:'forged',name:'original',cases:[]});
  return Response.json({value:{found:true,result:{experiment:{id:'original-exp'}}}});
 }});assert.deepEqual(actions,['lookup_operation']);
});

test('parallel and resumed worker scopes cannot substitute another actor',async()=>{
 const core=await import('../src/lib/storage-core/experiments');const names=await Promise.all(['one','two'].map(name=>core.withCoreExperiments(request(name),async()=>{
  const context=core.requireCoreExperimentContext();await new Promise(resolve=>setImmediate(resolve));assert.equal(core.requireCoreExperimentContext().actor.username,name);
  return core.runWithCoreExperimentContext(context,async()=>core.requireCoreExperimentContext().actor.username);
 },{fetcher:async()=>Response.json(profile(name))})));assert.deepEqual(names,['one','two']);
});

test('the restricted list view can cross an async return while unknown models remain unavailable',async()=>{
 const core=await import('../src/lib/storage-core/experiments');
 const view=await core.withCoreExperimentReadRoute(request('forged','GET'),async()=>core.requireCoreExperimentContext().readView!,{fetcher:async(url)=>new URL(String(url)).pathname==='/v1/auth/me'?Response.json(profile('owner')):Response.json({value:{coverage:'complete',snapshots:[]}})});
 assert.equal((view as unknown as {then?:unknown}).then,undefined);assert.equal((view as unknown as Record<symbol,unknown>)[Symbol.iterator],undefined);
 assert.deepEqual(await view.experiment.findMany(),[]);assert.throws(()=>view.session,/does not cover/);assert.throws(()=>(view as unknown as {invented:unknown}).invented,/does not cover/);
});

test('Experiment errors preserve conflict codes without leaking internal error text',async()=>{
 const core=await import('../src/lib/storage-core/experiments');
 const response=core.coreExperimentFailure(Object.assign(new Error('secret-internal-provider-error'),{status:409}));assert.equal(response.status,409);assert.ok(!(await response.text()).includes('secret-internal'));
 assert.throws(()=>core.requireCoreExperimentContext(),/scope|context/i);
});
