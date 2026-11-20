import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {activateIsolatedHome} from './helpers/isolated-home';
import {createIsolatedDatabase} from './helpers/isolated-database';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'core-evaluator-'));
const restore=activateIsolatedHome(home);const database=createIsolatedDatabase();
test.after(async()=>{const {prismaRaw}=await import('./helpers/historical-prisma');await prismaRaw.$disconnect();database.dispose();restore();fs.rmSync(home,{recursive:true,force:true});});
const token='session_'+'E'.repeat(43);
const profile={username:'alice',principal_id:'alice',workspace_id:'w',workspaces:[{workspace_id:'w'}]};
const card={id:'custom-a',name:'judge',source:'custom',evaluatorType:'LLM',category:'res',llmConfig:{model:'fixture',systemPrompt:'Judge {{output}}'},opaque:{中文:[0.25,false,null]}};
const snapshot={evaluators:[card],releases:[{evaluator_id:'custom-a',asset_id:'asset',release_id:'release',content_hash:'a'.repeat(64),origin:'user'}],etag:'"evaluators:list:1"',list_release_id:'list-release'};
const request=(method='GET',headers:HeadersInit={},body?:unknown)=>new Request('http://localhost/api/user-evaluators?workspace_id=w&user=forged',{method,headers:{authorization:'Bearer '+token,...headers},...(body?{body:JSON.stringify(body)}:{})});
async function api(){
 process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';assert.ok(fs.existsSync('src/lib/storage-core/evaluators.ts'),'trusted Evaluator repository is required');
 return import('../src/lib/storage-core/evaluators');
}

test('Evaluator reads and freezes bind the verified principal without using caller username',async()=>{
 const m=await api();const actions:string[]=[];
 await m.withCoreEvaluators(request(),async()=>{
  assert.equal(m.requireCoreEvaluatorContext().actor.username,'alice');assert.deepEqual(await m.readCoreEvaluators(),[card]);
  assert.equal((await m.freezeCoreEvaluators(['custom-a'])).releases[0].release_id,'release');
 },{fetcher:async(url,init)=>{
  if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json(profile);
  assert.equal(new URL(String(url)).searchParams.get('workspace_id'),'w');assert.equal(new Headers(init?.headers).get('authorization'),'Bearer '+token);
  const body=JSON.parse(String(init?.body));actions.push(body.action);assert.equal(body.user,undefined);
  return Response.json({value:body.action==='freeze'?{schemaVersion:1,cards:{'custom-a':card},releases:snapshot.releases,list_etag:snapshot.etag}:snapshot});
 }});assert.deepEqual(actions,['read','freeze']);
});
test('missing edit baseline is rejected before any Evaluator save RPC',async()=>{
 const m=await api();let writes=0;
 await m.withCoreEvaluators(request('PUT',{}, {user:'forged',evaluators:[card]}),async()=>{
  await assert.rejects(m.saveCoreEvaluators([card]),error=>!!error&&typeof error==='object'&&'status'in error&&error.status===428);
 },{fetcher:async(url)=>{if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json(profile);writes++;return Response.json({value:snapshot});}});
 assert.equal(writes,0);
});
test('background actor context is revalidated and preserves frozen safe release references',async()=>{
 const m=await api();await m.runWithCoreEvaluatorActor({token,workspace:'w',principal:'alice',username:'alice'},async()=>{
  assert.equal(m.requireCoreEvaluatorContext().actor.principal,'alice');
 },{fetcher:async()=>Response.json(profile)});
 await assert.rejects(m.runWithCoreEvaluatorActor({token,workspace:'w',principal:'forged',username:'alice'},async()=>{}, {fetcher:async()=>Response.json(profile)}));
});

test('core storage without actor scope fails before legacy evaluator migration or Prisma writes',async()=>{
 const {readUserCustomEvaluators,writeUserCustomEvaluators}=await import('../src/server/user_evaluators_storage');
 const {prismaRaw}=await import('./helpers/historical-prisma');const before=await prismaRaw.customEvaluatorList.count();process.env.AGENT_INSIGHT_TRACE_STORAGE='core';
 try{
  const denied=(error:unknown)=>!!error&&typeof error==='object'&&'status'in error&&error.status===503;
  await assert.rejects(readUserCustomEvaluators('forged'),denied);await assert.rejects(writeUserCustomEvaluators('forged',[card]),denied);
  assert.equal(await prismaRaw.customEvaluatorList.count(),before);
 }finally{delete process.env.AGENT_INSIGHT_TRACE_STORAGE;}
});
test('original evaluator PUT ignores caller user, preserves normalized JSON and never registers a legacy Agent',async()=>{
 const {PUT}=await import('../src/app/api/user-evaluators/route');const {prismaRaw}=await import('./helpers/historical-prisma');await api();
 const old=globalThis.fetch;process.env.AGENT_INSIGHT_TRACE_STORAGE='core';let saved=false;const before=await prismaRaw.customEvaluatorList.count();
 globalThis.fetch=async(url,init)=>{
  if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json(profile);
  const body=JSON.parse(String(init?.body));if(body.action==='lookup')return Response.json({value:null});if(body.action==='read')return Response.json({value:snapshot});
  assert.equal(body.action,'save');saved=true;assert.equal(body.expected_etag,snapshot.etag);assert.equal(body.operation_request.body.user,'forged');assert.deepEqual(body.evaluators[0].opaque,card.opaque);
  return Response.json({value:{...snapshot,evaluators:body.evaluators,etag:'"evaluators:list:2"'}});
 };
 try{
  const response=await PUT(request('PUT',{'if-match':snapshot.etag},{user:'forged',evaluators:[card]}));assert.equal(response.status,200);assert.ok(saved);assert.equal(response.headers.get('etag'),'"evaluators:list:2"');
  assert.equal(await prismaRaw.customEvaluatorList.count(),before);assert.equal(await prismaRaw.registeredAgent.count(),0);
 }finally{globalThis.fetch=old;delete process.env.AGENT_INSIGHT_TRACE_STORAGE;}
});
test('freeze refuses missing Skill snapshot bytes instead of trusting their claimed hash',async()=>{
 const m=await api();const withSkill={...card,llmConfig:{...card.llmConfig,skills:[{name:'missing',snapshotHash:'a'.repeat(64)}]}};
 await m.withCoreEvaluators(request(),async()=>{
  await assert.rejects(m.freezeCoreEvaluators(['custom-a']));
 },{fetcher:async(url)=>new URL(String(url)).pathname==='/v1/auth/me'?Response.json(profile):Response.json({value:{schemaVersion:1,cards:{'custom-a':withSkill},releases:snapshot.releases,list_etag:snapshot.etag}})});
});

function componentAction(name:string,context:Record<string,unknown>){
 const file=ts.createSourceFile('EvaluatorsCenter.tsx',fs.readFileSync('src/components/EvaluatorsCenter.tsx','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let text='';
 const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text===name&&node.initializer)text=node.initializer.getText(file);ts.forEachChild(node,visit);};visit(file);assert.ok(text);
 const source=ts.transpileModule('const action='+text+';', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 return vm.runInNewContext(source+'\naction',{...context});
}
test('Evaluator creation binds the draft list and ETag captured before another save',async()=>{
 const old={user:'alice',cards:[card],etag:'"v1"'};let seen:RequestInit|undefined;
 const context={user:'alice',creating:false,llmDraft:{name:'newjudge',description:'',systemPrompt:'judge',points:[],skills:[],category:'res'},activeModel:null,
  evaluatorDraftSnapshot:{current:old},evaluatorSnapshot:{...old,etag:'"v2"',cards:[]},customEvaluators:[],
  isValidCustomEvaluatorName:()=>true,findUnsupportedCustomEvaluatorVariables:()=>[],normalizeEvaluatorPoints:()=>[],setCreating:()=>{},setError:()=>{},
  apiFetch:async(_url:string,init:RequestInit)=>{seen=init;return Response.json({error:'conflict'},{status:409});},
 };
 const evaluatorWriteHeaders=componentAction('evaluatorWriteHeaders',context);
 await componentAction('finalizeLlmEvaluator',{...context,evaluatorWriteHeaders})();
 assert.equal(new Headers((seen as RequestInit|undefined)?.headers).get('if-match'),'"v1"');
 const body=JSON.parse(String((seen as RequestInit|undefined)?.body));assert.equal(body.evaluators.length,2);assert.equal(body.evaluators[1].id,'custom-a');
});
test('Evaluator deletion uses the displayed list snapshot and omits version only for legacy reads',async()=>{
 let seen:RequestInit|undefined;const context={user:'alice',customEvaluators:[card],evaluatorSnapshot:{user:'alice',cards:[card],etag:'"v1"'},
  globalThis:{confirm:()=>true},setError:()=>{},setEvaluatorSnapshot:()=>{},setCustomEvaluators:()=>{},setCustomPage:()=>{},
  apiFetch:async(_url:string,init:RequestInit)=>{seen=init;return Response.json({error:'conflict'},{status:409});},
 };
 const evaluatorWriteHeaders=componentAction('evaluatorWriteHeaders',context);
 await componentAction('deleteCustomEvaluator',{...context,evaluatorWriteHeaders})(card);
 assert.equal(new Headers((seen as RequestInit|undefined)?.headers).get('if-match'),'"v1"');
 assert.equal(new Headers(evaluatorWriteHeaders({user:'alice',cards:[]})).get('if-match'),null);
});

test('private retry envelope does not halve the public evaluator authoring byte budget',async()=>{
 const m=await api();const cards=Array.from({length:6},(_,index)=>({...card,id:'custom-'+index,opaque:{text:'x'.repeat(768*1024)}}));let sent=false;
 await m.withCoreEvaluators(request('PUT',{'if-match':snapshot.etag},{evaluators:cards}),async()=>{
  await m.saveCoreEvaluators(cards);
 },{fetcher:async(url,init)=>{
  if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json(profile);
  sent=true;assert.ok(Buffer.byteLength(String(init?.body))>8*1024*1024);
  return Response.json({value:{...snapshot,evaluators:cards,releases:cards.map(item=>({...snapshot.releases[0],evaluator_id:item.id}))}});
 }});assert.ok(sent);
});

test('background actor preserves the authenticated legacy Skill owner after bearer revalidation',async()=>{
 const m=await api();await m.runWithCoreEvaluatorActor({token,workspace:'w',principal:'alice',username:'legacy-alice'},async()=>{
  assert.equal(m.requireCoreEvaluatorContext().actor.username,'legacy-alice');
 },{fetcher:async()=>Response.json(profile)});
});
test('GET normalizes actor identity and returns its own read ETag',async()=>{
 const m=await api();const response=await m.withCoreEvaluatorRoute(request(),async normalized=>{
  assert.equal(new URL(normalized.url).searchParams.get('user'),'alice');
  return Response.json(await m.readCoreEvaluators());
 },{fetcher:async url=>new URL(String(url)).pathname==='/v1/auth/me'?Response.json(profile):Response.json({value:snapshot})});
 assert.equal(response.status,200);assert.equal(response.headers.get('etag'),snapshot.etag);assert.deepEqual(await response.json(),[card]);
});
test('PUT rejects missing and stale versions before invoking legacy normalization',async()=>{
 const m=await api();let normalized=0;const actions:string[]=[];
 const options={fetcher:async(url:RequestInfo|URL,init?:RequestInit)=>{
  if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json(profile);
  actions.push(JSON.parse(String(init?.body)).action);return Response.json({error:'stale'},{status:409});
 }};
 const next=async()=>{normalized++;return Response.json({});};
 const missing=await m.withCoreEvaluatorRoute(request('PUT',{}, {evaluators:[card]}),next,options);
 assert.equal(missing.status,428);assert.deepEqual(actions,[]);
 const stale=await m.withCoreEvaluatorRoute(request('PUT',{'if-match':'"old"'}, {evaluators:[card]}),next,options);
 assert.equal(stale.status,409);assert.deepEqual(actions,['lookup']);assert.equal(normalized,0);
});
test('exact PUT replay returns its receipt before expired import-token normalization',async()=>{
 const m=await api();const actions:string[]=[];
 const response=await m.withCoreEvaluatorRoute(request('PUT',{'if-match':'"old"','idempotency-key':'import-retry'}, {evaluators:[{id:'custom-a',importToken:'expired'}]}),async()=>{throw Error('normalization must not run');},{fetcher:async(url,init)=>{
  if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json(profile);
  const body=JSON.parse(String(init?.body));actions.push(body.action);assert.equal(body.operation_key,'import-retry');assert.equal(body.operation_request.body.evaluators[0].importToken,'expired');return Response.json({value:snapshot});
 }});
 assert.equal(response.status,200);assert.equal(response.headers.get('etag'),snapshot.etag);assert.deepEqual((await response.json()).evaluators,[card]);assert.deepEqual(actions,['lookup']);
});
