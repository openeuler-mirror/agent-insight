/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {NextRequest} from 'next/server';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'versioned-backing-guard-'));fs.mkdirSync(path.join(home,'data'));
const database=path.join(home,'data/witty_insight.db');fs.closeSync(fs.openSync(database,'a'));
process.env.AGENT_INSIGHT_HOME=home;delete process.env.AGENT_INSIGHT_DATA_DIR;delete process.env.DB_HOST;process.env.DATABASE_URL='file:'+database;
execFileSync(process.execPath,[path.resolve('node_modules/prisma/build/index.js'),'db','push','--skip-generate'],{env:process.env,stdio:'pipe'});
let prisma:any,engine:any,route:any;
const require=createRequire(import.meta.url),generalPath=require.resolve('@/lib/engine/general-agent'),originalGeneral=require.cache[generalPath];
const user='versioned-backing@example.test',key='wi_backing_fixture';
const params={user,name:'Backing task',evaluatorIds:['preset-conversation-rules'],scope:'skill-case-analysis'};
test.before(async()=>{
 prisma=(await import('@/lib/storage/prisma')).prismaRaw;engine=await import('@/lib/engine/experiment/run-experiment');route=await import('@/app/api/experiments/eval-traces/route');
 await prisma.user.create({data:{username:user,apiKey:key}});
});
test.after(async()=>{if(originalGeneral)require.cache[generalPath]=originalGeneral;else delete require.cache[generalPath];await prisma?.$disconnect();fs.rmSync(home,{recursive:true,force:true});});
test('任意冻结资产声明的实验不能被ensureEvalExperiment当作专用backing容器',async()=>{
 for(const assetVersions of [{schemaVersion:1,dataset:{versionId:'dataset-version'}},{schemaVersion:1,agent:{versionId:'agent-version'}},{},null]){
  const experiment=await prisma.experiment.create({data:{user,name:'Frozen',configSnapshotJson:JSON.stringify({assetVersions})}});
  await assert.rejects(engine.ensureEvalExperiment({...params,existingId:experiment.id}),(error:any)=>error.status===409&&error.code==='ASSET_BACKING_FORBIDDEN'&&/原实验详情.*新版本/.test(error.message));
  assert.equal((await prisma.experiment.findUnique({where:{id:experiment.id}})).configSnapshotJson,JSON.stringify({assetVersions}));
 }
});
test('原有无版本backing仍复用；其他账号的existingId不被复用或改写',async()=>{
 const legacy=await prisma.experiment.create({data:{user,name:'Legacy',scope:'skill-case-analysis',configSnapshotJson:'{"customEvaluatorSnapshots":{"schemaVersion":1,"cards":{}}}'}});
 assert.equal(await engine.ensureEvalExperiment({...params,existingId:legacy.id}),legacy.id);
 const other=await prisma.experiment.create({data:{user:'other@example.test',name:'Other user',configSnapshotJson:'{"assetVersions":{"schemaVersion":1}}'}});
 const owned=await engine.ensureEvalExperiment({...params,existingId:other.id});assert.notEqual(owned,other.id);
 assert.equal((await prisma.experiment.findUnique({where:{id:owned}})).user,user);
 assert.equal((await prisma.experiment.findUnique({where:{id:other.id}})).name,'Other user');
});
test('eval-traces明确409拒绝复用冻结普通实验，保留原Case和参考答案',async()=>{
 const experiment=await prisma.experiment.create({data:{user,name:'Versioned ordinary experiment',configSnapshotJson:JSON.stringify({assetVersions:{schemaVersion:1,dataset:{businessId:'dataset',versionId:'v1',definition:{cases:[{id:'allowed',input:'question',expectedOutput:'frozen reference'}]}}}}),cases:{create:{taskId:'existing-trace',input:'question',referenceOutput:'frozen reference'}}}});
 for(const createOnly of [true,false]){
  const response=await route.POST(new Request('http://localhost/api/experiments/eval-traces',{method:'POST',headers:{'content-type':'application/json','x-witty-api-key':key},body:JSON.stringify({user,experimentId:experiment.id,evaluators:['preset-conversation-rules'],createOnly,taskIds:['outside-trace']})}));
  assert.equal(response.status,409);const body=await response.json();assert.equal(body.code,'ASSET_BACKING_FORBIDDEN');assert.match(body.error,/原实验详情/);
 }
 const cases=await prisma.experimentCase.findMany({where:{experimentId:experiment.id}});assert.equal(cases.length,1);assert.equal(cases[0].referenceOutput,'frozen reference');
});
test('Grayscale重执行在早期检查及事务claim前拒绝冻结数据集，不覆盖已有Case',async()=>{
 require.cache[generalPath]={id:generalPath,filename:generalPath,loaded:true,exports:{runGeneralAgent:()=>assert.fail('不得运行Agent')}} as any;
 const grayscale=await import('@/app/api/debug/grayscale-tasks/[taskId]/route');
 const skill=await prisma.skill.create({data:{user,name:'backing-skill',versions:{create:{version:1,content:'# Fixture'}}},include:{versions:true}});
 const dataset=await prisma.agentEvalDataset.create({data:{id:'retry-dataset',user,name:'Changed current dataset',casesJson:JSON.stringify([{id:'case-x',input:'changed input',expectedOutput:'changed reference'}])}});
 const frozen=await prisma.experiment.create({data:{user,name:'Frozen Skill Trace experiment',scope:'skill-workbench',preset:'use-case',status:'failed',configSnapshotJson:'{"assetVersions":{"schemaVersion":1,"dataset":{"versionId":"frozen-v1"}}}',cases:{create:{input:'frozen input',datasetInput:'frozen input',referenceOutput:'frozen reference'}}},include:{cases:true}});
 const task=await prisma.grayscaleTask.create({data:{user,skillId:skill.id,skillName:skill.name,skillVersion:1,skillVersionId:skill.versions[0].id,taskName:'Legacy backing task',configJson:JSON.stringify({skillId:skill.id,versionAId:'__NONE__',versionBId:skill.versions[0].id,boundSide:'b',executionSides:['b'],linkedDatasetIds:[dataset.id],evalExperimentId:frozen.id,evaluators:['preset-conversation-rules'],runCount:1,repeatRounds:1}),caseStatesJson:JSON.stringify({'case-x':{a:{status:'fail',runs:[]},b:{status:'fail',runs:[{status:'fail',runIndex:1,roundIndex:1,caseId:'case-x',experimentCaseId:frozen.cases[0].id}]}}})}});
 const find=prisma.experiment.findFirst,transaction=prisma.$transaction;
 let claims=0,transactions=0;
 prisma.$transaction=(work:any,...options:any[])=>typeof work!=='function'?transaction.call(prisma,work,...options):transaction.call(prisma,(tx:any)=>{
  transactions++;
  return work(new Proxy(tx,{get(target,key){if(key==='grayscaleTask')return new Proxy(target.grayscaleTask,{get(delegate,method){if(method==='updateMany')return()=>{claims++;throw new Error('UNEXPECTED_RETRY_CLAIM');};return delegate[method];}});return target[key];}}));
 },...options);
 try{
  for(const simulateConcurrentChange of [false,true]){
   prisma.experiment.findFirst=async(args:any)=>{const row=await find(args);return simulateConcurrentChange&&args.where?.scope==='skill-workbench'&&args.select?.configSnapshotJson?{...row,configSnapshotJson:'{}'}:row;};
   const response=await grayscale.POST(new NextRequest('http://localhost/api/debug/grayscale-tasks/'+task.id,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({user,action:'retry-execution',caseId:'case-x',side:'b',runIndex:1})}),{params:Promise.resolve({taskId:task.id})});
   assert.equal(response.status,409);assert.match((await response.json()).error,/冻结|固定.*版本/);
  }
  assert.equal(claims,0);assert.equal(transactions,1);
 }finally{prisma.experiment.findFirst=find;prisma.$transaction=transaction;}
 const unchanged=await prisma.experimentCase.findUnique({where:{id:frozen.cases[0].id}});
 assert.equal(unchanged.input,'frozen input');assert.equal(unchanged.referenceOutput,'frozen reference');
 assert.equal(await prisma.experimentTraceAttempt.count({where:{experimentId:frozen.id}}),0);
});
