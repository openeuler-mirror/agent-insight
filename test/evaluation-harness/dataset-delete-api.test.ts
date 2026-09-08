import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {once} from 'node:events';
import {DELETE} from '../../src/app/api/agent-datasets/[id]/route';
import {prisma} from '../../src/lib/storage/prisma';
import {createAsset,getAsset,listAssets,archiveAsset} from '../../src/lib/evaluation-harness/store';
import {createRun,executeRun,runDetail} from '../../src/lib/evaluation-harness/service';
import {datasetCards} from '../../src/components/evaluation-harness/dataset-catalog';
import {BUILTIN_RELIABILITY_DATASET_NAME} from '../../src/lib/agent-dataset-builtin';

const users=['dataset-delete-a-'+randomUUID(),'dataset-delete-b-'+randomUUID()];
const keys=[randomUUID(),randomUUID()];
const content={cases:[{id:'case',name:'Case',turns:[{input:'q',expectedOutput:'ok',expectation:{contains:'ok'}}]}]};
const remove=(id:string,queryUser:string|undefined=users[0],key:string|undefined=keys[0])=>DELETE(new Request('http://localhost/api/agent-datasets/'+id+(queryUser===undefined?'':'?user='+encodeURIComponent(queryUser)),{method:'DELETE',headers:key?{'x-witty-api-key':key}:{}}),{params:Promise.resolve({id})});
test.before(async()=>{for(let i=0;i<users.length;i++)await prisma.user.create({data:{username:users[i],apiKey:keys[i]}});});
test.after(async()=>{
 await prisma.experiment.deleteMany({where:{user:{in:users}}});
 await prisma.evaluationAnalysis.deleteMany({where:{user:{in:users}}});
 await prisma.execution.deleteMany({where:{user:{in:users}}});
 await prisma.session.deleteMany({where:{user:{in:users}}});
 await prisma.evaluationAssetVersion.deleteMany({where:{user:{in:users}}});
 await prisma.agentEvalDataset.deleteMany({where:{user:{in:users}}});
 await prisma.user.deleteMany({where:{username:{in:users}}});
});

test('versioned dataset deletion archives every version and preserves completed experiment evidence',async()=>{
 const server=http.createServer(async(req,res)=>{for await(const _chunk of req){}res.setHeader('content-type','application/json');res.end(JSON.stringify({output:'ok',tools:[]}));});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const first=await createAsset(users[0],'dataset','versioned-delete','可删除业务数据集',content);
  const second=await createAsset(users[0],'dataset','versioned-delete','可删除业务数据集',content);
  const otherOwner=await createAsset(users[1],'dataset','versioned-delete','另一用户的数据集',content);
  const target=await createAsset(users[0],'target','versioned-delete','Agent',{type:'agent',adapter:'http',endpoint:`http://127.0.0.1:${(server.address() as any).port}`,externalId:'agent'});
  const evaluator=await createAsset(users[0],'evaluator','delete-rules','规则',{type:'rules'});
  const runId=await createRun(users[0],{name:'删除前的已完成实验',targetId:target.id,datasetId:first.id,evaluatorIds:[evaluator.id],retries:0});
  const before=await executeRun(users[0],runId);assert.equal(before.experiment.status,'done');assert.equal(before.summary.score,100);
  assert.equal(before.results.length,1);assert.equal(before.experiment.cases.length,1);
  const storedCase=before.experiment.cases[0];assert.ok(storedCase.executionId);assert.equal(storedCase.results.length,1);
  assert.equal(storedCase.results[0].status,'done');assert.equal(storedCase.results[0].score,100);assert.ok(storedCase.results[0].evidenceJson);
  const storedTrace=await prisma.execution.findUnique({where:{id:storedCase.executionId}});assert.ok(storedTrace);
  const response=await remove('versioned-'+second.id);assert.equal(response.status,200);assert.deepEqual(await response.json(),{success:true,archived:true});
  assert.equal((await getAsset(users[0],first.id,'dataset')).archived,true);assert.equal((await getAsset(users[0],second.id,'dataset')).archived,true);
  assert.equal((await getAsset(users[1],otherOwner.id,'dataset')).archived,false);assert.equal((await getAsset(users[0],target.id,'target')).archived,false);
  const visible=datasetCards((await listAssets(users[0])).map((a:any)=>({...a,content:JSON.parse(a.contentJson)})));assert.equal(visible.some(c=>c.versionAssetId===first.id||c.versionAssetId===second.id),false);
  const after=await runDetail(users[0],runId);assert.equal(after.experiment.status,'done');assert.equal(after.summary.score,100);assert.equal(after.manifest.dataset.id,first.id);assert.deepEqual(after.results,before.results);
  assert.deepEqual(after.manifest,before.manifest);assert.deepEqual(after.experiment.cases,before.experiment.cases);
  assert.equal(after.experiment.cases[0].executionId,storedCase.executionId);
  assert.deepEqual(JSON.parse(JSON.stringify(await prisma.execution.findUnique({where:{id:storedCase.executionId}}))),JSON.parse(JSON.stringify(storedTrace)));
 }finally{server.close();}
});

test('versioned deletion authenticates identity and cannot archive another user dataset',async()=>{
 const dataset=await createAsset(users[1],'dataset','protected-owner','另一个用户',content);
 assert.equal((await remove('versioned-'+dataset.id,users[1],keys[0])).status,403);
 assert.equal((await remove('versioned-'+dataset.id,users[0],keys[0])).status,404);
 assert.equal((await remove('versioned-'+dataset.id,users[1],'')).status,401);
 assert.equal((await remove('versioned-'+dataset.id,users[1],'invalid-key')).status,401);
 assert.equal((await getAsset(users[1],dataset.id,'dataset')).archived,false);
 assert.equal((await remove('versioned-missing',users[0],keys[0])).status,404);
 const nonDataset=await createAsset(users[0],'target','not-dataset','Agent',{type:'agent',adapter:'demo',externalId:'agent'});
 assert.equal((await remove('versioned-'+nonDataset.id)).status,404);assert.equal((await getAsset(users[0],nonDataset.id)).archived,false);
});

test('only builtin reliability is protected while ordinary and custom reliability datasets remain deletable',async()=>{
 const builtinVersion=await createAsset(users[0],'dataset','builtin-protected',BUILTIN_RELIABILITY_DATASET_NAME,content);
 assert.equal((await remove('versioned-'+builtinVersion.id)).status,403);assert.equal((await getAsset(users[0],builtinVersion.id)).archived,false);
 for(const definition of [{name:BUILTIN_RELIABILITY_DATASET_NAME,tags:[]},{name:'由内置标记识别',tags:['内置','reliability']}]){
  const id=randomUUID();await prisma.agentEvalDataset.create({data:{id,user:users[0],name:definition.name,tagsJson:JSON.stringify(definition.tags),datasetKind:'reliability'}});
  assert.equal((await remove(id,users[0],'')).status,403);assert.ok(await prisma.agentEvalDataset.findUnique({where:{id}}));
 }
 for(const definition of [{name:'演示业务数据集',tags:['内置'],datasetKind:'ideal_output'},{name:'自建可靠性数据集',tags:['reliability'],datasetKind:'reliability'}]){
  const id=randomUUID();await prisma.agentEvalDataset.create({data:{id,user:users[0],name:definition.name,tagsJson:JSON.stringify(definition.tags),datasetKind:definition.datasetKind}});
  assert.equal((await remove(id,users[1],'')).status,404);assert.equal((await remove(id,users[0],'')).status,200);
  assert.equal(await prisma.agentEvalDataset.findUnique({where:{id}}),null);
 }
 assert.equal((await remove('ordinary-missing','',undefined)).status,400);
});


test('deleted versioned datasets require explicit restoration before publishing new versions',async()=>{
 const dataset=await createAsset(users[0],'dataset','deleted-publish','删除后发布',content);
 await archiveAsset(users[0],dataset.id,true);
 await assert.rejects(()=>createAsset(users[0],'dataset','deleted-publish','删除后发布',content),/已删除.*恢复/);
 assert.equal((await listAssets(users[0])).filter((a:any)=>a.kind==='dataset'&&a.assetKey==='deleted-publish').length,1);
 await archiveAsset(users[0],dataset.id,false);
 const published=await createAsset(users[0],'dataset','deleted-publish','恢复后发布',content);assert.equal(published.version,2);assert.equal(published.archived,false);
 const response=await DELETE(new Request('http://localhost/api/agent-datasets/versioned-'+published.id,{method:'DELETE',headers:{'x-witty-api-key':keys[0]}}),{params:Promise.resolve({id:'versioned-'+published.id})});
 assert.equal(response.status,200);assert.equal((await getAsset(users[0],published.id)).archived,true);
});
