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

const jsonlHeader = { type: 'dataset', schemaVersion: 1, name: '退款客服多轮回归', description: '验证跨轮退款查询', tags: ['回归'] };
const jsonlCase = {
  type: 'case', id: 'refund-001',
  turns: [
    { input: '记住订单号 A1024。' },
    { input: '查询这笔订单。', expectedOutput: ' 处理中 ', expectation: {
      outputMatch: 'contains', requiredTools: [{ name: 'lookup_order', arguments: { order_id: 'A1024' } }], expectedSkill: 'refund-support',
    } },
  ],
};

async function importDatasetJsonl(text: string, authenticated = true) {
  const { POST } = await import('@/app/api/agent-datasets/route');
  return POST(new Request('http://localhost/api/agent-datasets', {
    method: 'POST', body: text,
    headers: { 'Content-Type': 'application/x-ndjson', ...(authenticated && { 'x-witty-api-key': key }) },
  }));
}

test('JSONL 一次创建整套多轮数据集、归属当前用户并发布含逐轮规则的 v1', async () => {
  const text = '\uFEFF' + [jsonlHeader, jsonlCase, { ...jsonlCase, id: 'refund-002' }].map(row => JSON.stringify(row)).join('\r\n') + '\r\n';
  assert.equal((await importDatasetJsonl(text, false)).status, 401);
  const response = await importDatasetJsonl(text);
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));

  const dataset = await prisma.agentEvalDataset.findUniqueOrThrow({ where: { id: result.dataset.id } });
  assert.equal(dataset.user, user);
  assert.equal(dataset.name, jsonlHeader.name);
  assert.equal(dataset.description, jsonlHeader.description);
  assert.deepEqual(JSON.parse(dataset.tagsJson), jsonlHeader.tags);
  const asset = await prisma.evaluationAssetHead.findFirstOrThrow({
    where: { user, kind: 'dataset', businessId: dataset.id }, include: { versions: true, draft: true },
  });
  assert.equal(asset.publishedVersion, 1);
  assert.equal(asset.draft, null);
  assert.deepEqual(asset.versions.map((version: { version: number }) => version.version), [1]);
  const { cases } = JSON.parse(asset.versions[0].contentJson);
  assert.deepEqual(cases.map((item: { id: string }) => item.id), ['refund-001', 'refund-002']);
  assert.equal(cases[0].input, jsonlCase.turns[0].input);
  assert.equal(cases[0].expectedOutput, jsonlCase.turns[1].expectedOutput);
  assert.equal(cases[0].turns[1].expectation.expectedSkill, 'refund-support');
  assert.deepEqual(cases[0].turns[1].expectation.requiredTools, jsonlCase.turns[1].expectation?.requiredTools);
});

test('JSONL 错误指向文件行与字段，前面合法的 Case 不会单独落库', async () => {
  const before = await Promise.all([prisma.agentEvalDataset.count(), prisma.evaluationAssetHead.count()]);
  const trial = [
    { tail: '{broken', field: 'JSON' },
    { tail: JSON.stringify(jsonlCase), field: 'id' },
    { tail: JSON.stringify({ ...jsonlCase, id: 'bad', turns: [{ input: '单轮' }] }), field: 'turns' },
    { tail: JSON.stringify({ ...jsonlCase, id: 'bad', turns: [{ input: '合法' }, { input: ' ' }] }), field: 'turns[2].input' },
  ];
  for (const { tail, field } of trial) {
    const response = await importDatasetJsonl([JSON.stringify(jsonlHeader), JSON.stringify(jsonlCase), '', tail].join('\n'));
    const body = await response.json();
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.equal(body.line, 4);
    assert.equal(body.field, field);
  }
  assert.deepEqual(await Promise.all([prisma.agentEvalDataset.count(), prisma.evaluationAssetHead.count()]), before);
});

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

test('简化逐轮规则经原实验引擎评分并冻结保存，无模型及业务字段依赖',async()=>{
 const {normalizeConversationTurns}=await import('@/lib/evaluation-conversation');
 const {executeResultRow}=await import('@/lib/engine/experiment/run-experiment');
 const turns=normalizeConversationTurns({input:'记住AB',turns:[
  {input:'记住AB',expectedOutput:'ACK',expectation:{outputMatch:'exact',expectedSkill:'memo',requiredTools:[{name:'lookup',arguments:{key:'AB'}}],forbiddenTools:['pay']}},
  {input:'返回',expectedOutput:'AB',expectation:{outputMatch:'contains',forbiddenTools:['pay']}},
 ]});
 const trace='simple-conversation-engine-trace';
 const messages=[{role:'user',content:'记住AB'},{role:'assistant',content:'',tool_calls:[{id:'s',function:{name:'load_skill',arguments:{skill_name:'memo'}}},{id:'t',function:{name:'lookup',arguments:{key:'AB',extra:true}}}]},{role:'tool',tool_call_id:'s',content:'loaded'},{role:'tool',tool_call_id:'t',content:'AB'},{role:'assistant',content:'ACK',tool_calls:[]},{role:'user',content:'返回'},{role:'assistant',content:'答案 AB',tool_calls:[]}];
 await prisma.session.create({data:{taskId:trace,user,interactions:JSON.stringify(messages),endTime:new Date()}});
 await prisma.execution.create({data:{id:trace,taskId:trace,user,query:'记住AB',finalResult:'答案 AB'}});
 const exp=await prisma.experiment.create({data:{user,name:'Simple round rules',status:'running',evaluatorIdsJson:'["preset-conversation-rules"]',cases:{create:{input:'记住AB',actualOutput:'答案 AB',executionId:trace,taskId:trace,caseValuesJson:JSON.stringify({turns})}}},include:{cases:true}});
 const result=await prisma.experimentEvalResult.create({data:{experimentId:exp.id,caseId:exp.cases[0].id,evaluatorId:'preset-conversation-rules',status:'pending'}});
 assert.equal(await executeResultRow(user,result.id),'done');
 const saved=await prisma.experimentEvalResult.findUnique({where:{id:result.id}});
 assert.equal(saved.score,100);assert.equal(saved.verdict,'pass');assert.equal(JSON.parse(saved.pointsJson).length,2);
 const evidence=JSON.parse(saved.evidenceJson);assert.equal(evidence.json.checks.length,7);
 assert(evidence.json.checks.some((check:any)=>check.name==='输出精确匹配'));
 assert(evidence.json.checks.some((check:any)=>check.name==='Skill使用'));
 assert.deepEqual(JSON.parse((await prisma.experimentCase.findUnique({where:{id:exp.cases[0].id}})).caseValuesJson).turns,turns);
});
