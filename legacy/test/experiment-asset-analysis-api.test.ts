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
import { execFileSync } from 'node:child_process';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'asset-analysis-api-'));
fs.mkdirSync(path.join(home,'data'));
process.env.AGENT_INSIGHT_HOME=home;delete process.env.AGENT_INSIGHT_DATA_DIR;delete process.env.DB_HOST;
const database=path.join(home,'data/witty_insight.db');fs.closeSync(fs.openSync(database,'a'));
process.env.DATABASE_URL='file:'+database;
execFileSync(process.execPath,[path.resolve('node_modules/prisma/build/index.js'),'db','push','--skip-generate'],{env:process.env,stdio:'pipe'});
let prisma:any,route:any;
const user='analysis@example.test',key='wi_analysis_fixture';
test.before(async()=>{
 prisma=(await import('@/lib/storage/prisma')).prismaRaw;
 route=await import('@/app/api/evaluation-assets/experiments/route');
 await prisma.user.create({data:{username:user,apiKey:key}});
 await prisma.experiment.createMany({data:[{user,name:'mine',configSnapshotJson:JSON.stringify({secret:'fixture-no-export',assetVersions:{schemaVersion:1}})},{user:'other@example.test',name:'private-other'},{user,name:'deleted',deletedAt:new Date()}]});
});
test.after(async()=>{await prisma?.$disconnect();fs.rmSync(home,{recursive:true,force:true});});
const request=()=>new Request('http://localhost/api/evaluation-assets/experiments?user=other@example.test',{headers:{'x-witty-api-key':key}});
test('版本分析API只读取当前认证账号，不信任query user，也不输出冻结定义',async()=>{
 assert.equal((await route.GET(new Request('http://localhost/api/evaluation-assets/experiments?user='+user))).status,401);
 const response=await route.GET(request());assert.equal(response.status,200);const result=await response.json();
 assert.deepEqual(result.runs.map((r:any)=>r.name),['mine']);assert.equal(result.meta.truncated,false);
 assert.ok(!JSON.stringify(result).includes('fixture-no-export'));
});
test('持久化实验评分和冻结版本可经过真实API生成可比趋势，保留运行链接',async()=>{
 const asset=(id:string,v=1)=>({businessId:id,versionId:id+v,version:v,contentHash:id+v,definition:{name:id}});
 for(const version of [1,2]){
  const id='scored-analysis-'+version;
  await prisma.execution.create({data:{id:id+'-trace',user,model:'fixture-model',framework:'opencode',clientId:'fixture-client'}});
  await prisma.experiment.create({data:{id,user,name:'scored-'+version,status:'done',agentName:'build',evaluatorIdsJson:'["quality"]',configSnapshotJson:JSON.stringify({traceSource:'generate',executionTarget:{platform:'opencode',workerId:'fixture-client',model:'fixture-model',timeoutSeconds:60},assetVersions:{schemaVersion:1,agent:asset('agent',version),dataset:{...asset('dataset'),definition:{name:'dataset',cases:[{id:'one'}]}},evaluators:{quality:asset('quality')}}}),cases:{create:{input:'same input',referenceOutput:'same output',executionId:id+'-trace',caseValuesJson:JSON.stringify({__agentInsightDatasetCase:{datasetId:'dataset',caseId:'one'}}),traceAttempts:{create:{experimentId:id,attemptNo:1,workerId:'fixture-client',platform:'opencode',agent:'build',model:'fixture-model',timeoutSeconds:60,traceId:id+'-trace',status:'ready'}},results:{create:{experimentId:id,evaluatorId:'quality',status:'done',score:version*30}}}}}});
 }
 const response=await route.GET(request());assert.equal(response.status,200);const result=await response.json();
 const group=result.groups.find((g:any)=>g.variable==='agent'&&g.versionCount===2);
 assert.equal(group.runIds.length,2);assert.deepEqual(result.runs.filter((r:any)=>r.id.startsWith('scored-analysis')).map((r:any)=>r.score).sort(),[30,60]);
 assert.ok(!JSON.stringify(result).includes('same input'));
});
test('真实API隔离重试后的实际模型与客户端，混合Case不可比且不读取其他账号Execution',async()=>{
 const asset=(id:string,v=1)=>({businessId:id,versionId:id+v,version:v,contentHash:id+v,definition:{name:id}});
 const create=async(id:string,version:number,profiles:Array<{model:string;worker:string;owner?:string}>)=>{
  const cases=[];
  for(const [index,profile] of profiles.entries()){
   const trace=id+'-trace-'+index;
   await prisma.execution.create({data:{id:trace,user:profile.owner||user,model:profile.model,framework:'opencode',clientId:profile.worker}});
   cases.push({input:'same input',referenceOutput:'same output',executionId:trace,caseValuesJson:JSON.stringify({__agentInsightDatasetCase:{datasetId:'actual-dataset',caseId:'case-'+index}}),traceAttempts:{create:[{experimentId:id,attemptNo:1,workerId:'old-client',platform:'opencode',agent:'build',model:'fixture-model',timeoutSeconds:60,traceId:'old-trace-'+id+index,status:'ready'},{experimentId:id,attemptNo:2,workerId:profile.worker,platform:'opencode',agent:'build',model:profile.model,timeoutSeconds:60,traceId:trace,status:'ready'}]},results:{create:{experimentId:id,evaluatorId:'quality',status:'done',score:70}}});
  }
  await prisma.experiment.create({data:{id,user,name:id,status:'done',agentName:'build',evaluatorIdsJson:'["quality"]',configSnapshotJson:JSON.stringify({traceSource:'generate',executionTarget:{platform:'opencode',workerId:'fixture-client',model:'fixture-model',timeoutSeconds:60},assetVersions:{schemaVersion:1,agent:asset('actual-agent',version),dataset:{...asset('actual-dataset'),definition:{name:'actual-dataset',cases:profiles.map((_,i)=>({id:'case-'+i}))}},evaluators:{quality:asset('quality')}}}),cases:{create:cases}}});
 };
 await create('actual-first',1,[{model:'fixture-model',worker:'fixture-client'}]);
 await create('actual-model',2,[{model:'changed-model',worker:'fixture-client'}]);
 await create('actual-worker',3,[{model:'fixture-model',worker:'changed-client'}]);
 await create('actual-mixed',4,[{model:'fixture-model',worker:'fixture-client'},{model:'changed-model',worker:'changed-client'}]);
 await create('actual-foreign',5,[{model:'private-other-owner-model',worker:'private-other-owner-client',owner:'other@example.test'}]);
 const response=await route.GET(request());assert.equal(response.status,200);const result=await response.json();
 const groups=result.groups.filter((g:any)=>g.variable==='agent'&&g.runIds.some((id:string)=>id.startsWith('actual-')));
 assert.equal(groups.length,3);assert.ok(groups.every((g:any)=>g.runIds.length===1));
 assert.match(result.runs.find((r:any)=>r.id==='actual-mixed').reason,/实际.*不一致/);
 assert.equal(result.runs.find((r:any)=>r.id==='actual-foreign').comparable,false);
 assert.ok(!JSON.stringify(result).includes('private-other-owner-model'));assert.ok(!JSON.stringify(result).includes('private-other-owner-client'));
 assert.ok(groups.some((g:any)=>g.conditions.some((c:any)=>c.label==='实际执行条件'&&c.value.includes('changed-client'))));
});
test('限定1000条记录并明确截断，OpenGauss不伪称支持新版本分析',async()=>{
 await prisma.experiment.createMany({data:Array.from({length:1001},(_,i)=>({user,name:'run-'+i}))});
 const response=await route.GET(request());const result=await response.json();
 assert.equal(result.runs.length,1000);assert.equal(result.meta.truncated,true);assert.equal(result.meta.limit,1000);
 process.env.DB_HOST='fixture';try{assert.equal((await route.GET(request())).status,501);}finally{delete process.env.DB_HOST;}
});
