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

const home=fs.mkdtempSync(path.join(os.tmpdir(),'versioned-assets-api-'));
fs.mkdirSync(path.join(home,'data'));
const database=path.join(home,'data/witty_insight.db');fs.closeSync(fs.openSync(database,'a'));
process.env.AGENT_INSIGHT_HOME=home;delete process.env.AGENT_INSIGHT_DATA_DIR;process.env.DATABASE_URL='file:'+database;delete process.env.DB_HOST;
execFileSync(process.execPath,[path.resolve('node_modules/prisma/build/index.js'),'db','push','--skip-generate'],{env:process.env,stdio:'pipe'});

let prisma:any, route:any;
const user='versions-api@example.test',key='wi_fixture_versions_api',datasetId='versions-api-dataset';
function request(body?:unknown,query=''){
 return new Request('http://localhost/api/evaluation-assets'+query,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-witty-api-key':key},...(body?{body:JSON.stringify(body)}:{})});
}
test.before(async()=>{
 prisma=(await import('@/lib/storage/prisma')).prismaRaw;
 route=await import('@/app/api/evaluation-assets/route');
 await prisma.user.create({data:{username:user,apiKey:key}});
 await prisma.agentEvalDataset.create({data:{id:datasetId,user,name:'Existing dataset',fieldsJson:'[]',casesJson:JSON.stringify([{id:'one',input:'initial',expectedOutput:'old',tags:[],trajectory:'',evaluationFocus:''}])}});
});
test.after(async()=>{await prisma?.$disconnect();fs.rmSync(home,{recursive:true,force:true});});

test('新版本API不信任user参数或未认证请求',async()=>{
 const response=await route.GET(new Request('http://localhost/api/evaluation-assets?user='+user+'&kind=dataset&businessId='+datasetId));
 assert.equal(response.status,401);
 const other=await route.GET(request(undefined,'?user=other&kind=dataset&businessId=not-owned'));
 assert.equal(other.status,404);
});

test('旧数据首版、单Case草稿发布与历史读取完整闭环',async()=>{
 let response=await route.GET(request(undefined,'?kind=dataset&businessId='+datasetId));
 assert.equal(response.status,200);
 const initial=await response.json();assert.equal(initial.versions.length,1);assert.equal(initial.selectedVersion.version,1);
 response=await route.POST(request({action:'draft-create',kind:'dataset',businessId:datasetId}));assert.equal(response.status,200);
 let {draft}=await response.json();
 response=await route.POST(request({action:'case-save',kind:'dataset',businessId:datasetId,caseId:'one',revision:draft.revision,case:{...draft.content.cases[0],expectedOutput:'new'}}));assert.equal(response.status,200);
 ({draft}=await response.json());
 assert.equal(JSON.parse((await prisma.agentEvalDataset.findUnique({where:{id:datasetId}})).casesJson)[0].expectedOutput,'old');
 response=await route.POST(request({action:'dataset-publish',kind:'dataset',businessId:datasetId,revision:draft.revision,note:'new expected'}));assert.equal(response.status,200);
 const published=await response.json();assert.equal(published.version.version,2);
 const current=await prisma.agentEvalDataset.findUnique({where:{id:datasetId}});assert.equal(JSON.parse(current.casesJson)[0].expectedOutput,'new');
 response=await route.GET(request(undefined,'?kind=dataset&businessId='+datasetId+'&versionId='+initial.selectedVersion.id));
 assert.equal((await response.json()).selectedVersion.content.cases[0].expectedOutput,'old');
});

test('Agent版本登记按平台隔离，相同声明重试不重复增版',async()=>{
 const body={action:'agent-publish',kind:'agent',platform:'opencode',agentName:'build',note:'external change',requestId:'fixture-change-one'};
 let response=await route.POST(request(body));assert.equal(response.status,200);
 const first=await response.json();response=await route.POST(request(body));assert.equal(response.status,200);
 assert.equal((await response.json()).version.id,first.version.id);
 response=await route.POST(request({...body,platform:'pi'}));assert.equal(response.status,200);
 assert.notEqual((await response.json()).head.id,first.head.id);
});

test('逐轮业务规则通过原实验引擎持久化评分点和轮次证据',async()=>{
 const {normalizeConversationTurns}=await import('@/lib/evaluation-conversation');
 const {executeResultRow}=await import('@/lib/engine/experiment/run-experiment');
 const turns=normalizeConversationTurns({input:'记住',turns:[{input:'记住',expectation:{contains:'ACK'}},{input:'回复内容',expectation:{contains:'CODE'}}]});
 const trace='conversation-engine-trace';
 await prisma.session.create({data:{taskId:trace,user,interactions:JSON.stringify([{role:'user',content:'记住'},{role:'assistant',content:'ACK'},{role:'user',content:'回复内容'},{role:'assistant',content:'CODE'}]),endTime:new Date()}});
 await prisma.execution.create({data:{id:trace,taskId:trace,user,query:'记住',finalResult:'CODE'}});
 const exp=await prisma.experiment.create({data:{user,name:'Native rule engine',status:'running',evaluatorIdsJson:'["preset-conversation-rules"]',cases:{create:{input:'记住',actualOutput:'CODE',executionId:trace,taskId:trace,caseValuesJson:JSON.stringify({turns})}}},include:{cases:true}});
 const result=await prisma.experimentEvalResult.create({data:{experimentId:exp.id,caseId:exp.cases[0].id,evaluatorId:'preset-conversation-rules',status:'pending'}});
 assert.equal(await executeResultRow(user,result.id),'done');
 const saved=await prisma.experimentEvalResult.findUnique({where:{id:result.id}});
 assert.equal(saved.score,100);assert.equal(JSON.parse(saved.pointsJson).length,2);assert.match(saved.evidenceJson,/conversation-rules/);
});

test('草稿导入的工具目录字段与Case在同一新版本发布',async()=>{
 const id='catalog-draft-dataset';
 await prisma.agentEvalDataset.create({data:{id,user,name:'Catalog draft',fieldsJson:'[]',casesJson:'[]'}});
 await route.GET(request(undefined,'?kind=dataset&businessId='+id));
 let response=await route.POST(request({action:'draft-create',businessId:id}));let {draft}=await response.json();
 response=await route.POST(request({action:'case-save',businessId:id,caseId:'with-tools',revision:draft.revision,case:{id:'with-tools',input:'q',expectedOutput:'a',values:{input:'q',reference_output:'a',available_tools:[{name:'lookup'}]}}}));
 assert.equal(response.status,200);({draft}=await response.json());
 assert(draft.content.fields.some((field:any)=>field.key==='available_tools'));
 response=await route.POST(request({action:'dataset-publish',businessId:id,revision:draft.revision}));assert.equal(response.status,200);
 const published=await response.json();assert(published.version.content.fields.some((field:any)=>field.key==='available_tools'));
 assert(JSON.parse((await prisma.agentEvalDataset.findUnique({where:{id}})).fieldsJson).some((field:any)=>field.key==='available_tools'));
});
