import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {once} from 'node:events';
import {prisma} from '../../src/lib/storage/prisma';
import {bootstrap} from '../../src/lib/evaluation-harness/catalog';
import {createAsset} from '../../src/lib/evaluation-harness/store';
test('catalog sync preserves historical snapshots and only selects definitions still supplied by that external catalog',async()=>{
 const user='nh-catalog-'+randomUUID(),oldUrl=process.env.EVALUATION_DEMO_URL;
 const content={type:'agent',adapter:'demo',externalId:'a',externalVersion:'external-v1',prompt:'original'};
 let targets=[{assetKey:'a',name:'Agent',version:1,content}];
 const server=http.createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(targets));});server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  process.env.EVALUATION_DEMO_URL=`http://127.0.0.1:${(server.address() as any).port}`;
  const unrelated=await createAsset(user,'target','unrelated','Other',content);
  await bootstrap(user);const first=await prisma.evaluationAssetVersion.findFirstOrThrow({where:{user,assetKey:'a'}});
  targets=[{...targets[0],content:{...content,prompt:'changed by external service'}}];await bootstrap(user);await bootstrap(user);
  const versions=await prisma.evaluationAssetVersion.findMany({where:{user,assetKey:'a'},orderBy:{version:'asc'}});
  assert.equal(versions.length,2);assert.equal(versions[0].contentHash,first.contentHash);assert.equal(versions[0].archived,true);assert.equal(versions[1].archived,false);
  assert.equal((await prisma.evaluationAssetVersion.findUniqueOrThrow({where:{id:unrelated.id}})).archived,false);
  targets=[{...targets[0],content}];await bootstrap(user);assert.equal((await prisma.evaluationAssetVersion.findUniqueOrThrow({where:{id:first.id}})).archived,false);
 }finally{server.close();if(oldUrl)process.env.EVALUATION_DEMO_URL=oldUrl;else delete process.env.EVALUATION_DEMO_URL;await prisma.evaluationAssetVersion.deleteMany({where:{user}});}
});
