/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createIsolatedDatabase } from './helpers/isolated-database';
import { ensureTestApiUsers, testRequest } from './helpers/api-auth';

const database=createIsolatedDatabase();
const {prisma}=require('../src/lib/storage/prisma');
const trace=require('../src/lib/engine/experiment/trace-generation');
const client=require('../scripts/reliability-client.cjs');
const conversation={version:1,turns:[{id:'first',input:'记住随机值 alpha-51'},{id:'second',input:'复述刚才的随机值'}]};
test.after(async()=>{await prisma.$disconnect();database.dispose();});

test('执行端拒绝泄露的预期字段以及不支持多轮的平台',async()=>{
  assert.throws(()=>client.normalizeExecutionConversation({...conversation,turns:[{...conversation.turns[0],expectedOutput:'secret-answer'}]}),/逐轮|conversation/);
  assert.deepEqual(client.normalizeExecutionConversation(conversation),conversation);
  for(const platform of ['pi-agent','xiaoo']) await assert.rejects(client.runExperimentCase({workspaceBase:'/unused'}, {platform,agent:'agent',input:conversation.turns[0].input,conversation}),{code:'MULTI_TURN_UNSUPPORTED'});
});

test('OpenCode续接参数只用于本次Case内部，普通调用仍然创建新session', t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'conversation-cli-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bin=path.join(root,'opencode');
  fs.writeFileSync(bin,`#!${process.execPath}\nconsole.log(process.argv.includes('--version')?'opencode v2.0.32':'run --format json --agent --model --title --standalone --session');\n`,{mode:0o700});
  const input={platform:'opencode',agent:'build',input:'second',conversationSessionId:'ses_owned'};
  const resumed=client.buildExperimentCaseInvocation(bin,input);
  assert.equal(resumed.sessionId,'ses_owned');
  assert.deepEqual(resumed.args.slice(-2),['--session','ses_owned']);
  const fresh=client.buildExperimentCaseInvocation(bin,{...input,conversationSessionId:undefined});
  assert.notEqual(fresh.sessionId,resumed.sessionId);
});

test('Case收集与重试保留逐轮输入，不下发预期或规则',async()=>{
  const exp=await prisma.experiment.create({data:{user:'conversation-collect',name:'conversation',cases:{create:{input:conversation.turns[0].input,caseValuesJson:JSON.stringify({turns:conversation.turns.map(t=>({...t,expectedOutput:'hidden',expectation:{contains:'hidden'}}))})}}},include:{cases:true}});
  const rows=await trace.collectTraceGenerationCases(exp.id);
  assert.deepEqual(rows[0].conversation,conversation);
  assert.equal(JSON.stringify(rows).includes('hidden'),false);
  await prisma.experimentTraceAttempt.create({data:{experimentId:exp.id,caseId:exp.cases[0].id,attemptNo:1,workerId:'conversation-worker',platform:'opencode',agent:'build',status:'failed'}});
  const retry=await trace.loadTraceGenerationRetryRequest({user:'conversation-collect',experimentId:exp.id,caseId:exp.cases[0].id});
  assert.deepEqual(retry.cases[0].conversation,conversation);
});

test('Case显式损坏的逐轮配置不能静默降为单轮，只有省略字段兼容旧Case',async()=>{
  for(const turns of [null,'invalid-turns',{}]) {
    const exp=await prisma.experiment.create({data:{user:'conversation-invalid',name:'invalid conversation',cases:{create:{input:'initial input',caseValuesJson:JSON.stringify({turns})}}}});
    await assert.rejects(()=>trace.collectTraceGenerationCases(exp.id),/逐轮配置必须为数组/);
  }
  const legacy=await prisma.experiment.create({data:{user:'conversation-invalid',name:'legacy single',cases:{create:{input:'legacy input',caseValuesJson:'{}'}}}});
  const rows=await trace.collectTraceGenerationCases(legacy.id);
  assert.equal(rows.length,1);
  assert.equal(rows[0].conversation,undefined);
});

test('完成回执必须准确指向同一会话并按顺序确认所有轮次',()=>{
  const receipt={conversation:{version:1,sessionId:'ses_one',completedTurnIds:['first','second']}};
  assert.doesNotThrow(()=>trace.assertConversationReceipt(conversation,'ses_one',JSON.stringify(receipt)));
  for(const changed of [undefined,{...receipt.conversation,sessionId:'ses_other'},{...receipt.conversation,completedTurnIds:['second','first']},{...receipt.conversation,completedTurnIds:['first']}]) {
    assert.throws(()=>trace.assertConversationReceipt(conversation,'ses_one',JSON.stringify({conversation:changed})),{code:'CONVERSATION_INCOMPLETE'});
  }
  for(const code of ['MULTI_TURN_UNSUPPORTED','INVALID_CONVERSATION','CONVERSATION_INCOMPLETE','TRACE_ID_MISMATCH']) assert.equal(trace.isTraceGenerationFailureRetryable(code),false);
});

test('只有完整上报OpenCode多轮能力的目标可以下发，旧客户端的单轮仍可用',async()=>{
  const {parseCapabilities}=require('../src/lib/reliability/client-registry');
  const {listClientTraceGenerationTargets}=require('../src/lib/engine/experiment/execution-targets');
  const capability=(enabled:boolean)=>({platforms:[{id:'opencode',agents:['build'],actions:['RUN_EXPERIMENT_CASE'],runExperimentCase:{version:2,returnsTraceId:true,...(enabled?{multiTurn:true,sessionContinuation:true,conversationVersion:1}:{})}}],actions:['RUN_EXPERIMENT_CASE'],faultInjection:{ready:false}});
  await prisma.reliabilityClient.create({data:{clientId:'conversation-capability',user:'conversation-capability',name:'test',status:'online',serviceHealth:'healthy',lastSeenAt:new Date(),capabilitiesJson:JSON.stringify(capability(false))}});
  const request={user:'conversation-capability',workerId:'conversation-capability',platform:'opencode',agent:'build'};
  await assert.doesNotReject(()=>trace.assertTraceGenerationTarget(request));
  await assert.rejects(()=>trace.assertTraceGenerationTarget({...request,multiTurn:true}),{code:'MULTI_TURN_UNSUPPORTED'});
  await assert.rejects(()=>trace.assertTraceGenerationTarget({...request,cases:[{caseId:'example',input:conversation.turns[0].input,conversation}]}),{code:'MULTI_TURN_UNSUPPORTED'});
  await prisma.reliabilityClient.update({where:{clientId:request.workerId},data:{capabilitiesJson:JSON.stringify(capability(true))}});
  assert.equal(parseCapabilities(JSON.stringify(capability(true))).platforms[0].runExperimentCase.multiTurn,true);
  assert.equal((await listClientTraceGenerationTargets(request.user))[0].supportsMultiTurn,true);
  const {GET}=await import('@/app/api/experiments/agents/route');
  await ensureTestApiUsers(request.user);
  const response=await GET(testRequest('http://fixture/api/experiments/agents?user='+request.user,request.user));
  assert.equal(response.status,200);
  const discovered=await response.json();
  assert.equal(discovered.agents.find((a:any)=>a.name==='build').targets[0].supportsMultiTurn,true);
  await assert.doesNotReject(()=>trace.assertTraceGenerationTarget({...request,multiTurn:true}));
});

test('第一轮的终态Trace不能提前作为多轮完成，所有轮次及最新输出入库后才可绑定',async()=>{
  const user='conversation-trace',traceId='ses_conversation_complete';
  const messages=conversation.turns.flatMap((t,i)=>[{role:'user',content:t.input},{role:'assistant',content:i?'alpha-51':'remembered'}]);
  const session=await prisma.session.create({data:{user,taskId:traceId,endTime:new Date(),interactions:JSON.stringify(messages.slice(0,2))}});
  const execution=await prisma.execution.create({data:{user,taskId:traceId,query:conversation.turns[0].input,finalResult:'remembered'}});
  const input={user,traceId,conversation};
  assert.equal(await trace.findExecutionByTraceId(input),null);
  await prisma.session.update({where:{id:session.id},data:{interactions:JSON.stringify(messages)}});
  assert.equal(await trace.findExecutionByTraceId(input),null,'execution final output must catch up with final turn');
  await prisma.execution.update({where:{id:execution.id},data:{finalResult:'alpha-51'}});
  assert.equal((await trace.findExecutionByTraceId(input))?.id,execution.id);
});

test('全部输入已入库但末轮仅有工具前言时继续等待，最终回复晚到后才可绑定',async()=>{
  const user='conversation-final-reply',traceId='ses_conversation_final_reply';
  const preface=[{role:'user',content:conversation.turns[0].input},{role:'assistant',content:'remembered'},
    {role:'user',content:conversation.turns[1].input},{role:'assistant',content:'正在检查随机值',
      tool_calls:[{id:'lookup-final',function:{name:'lookup',arguments:'{}'}}]}];
  const session=await prisma.session.create({data:{user,taskId:traceId,endTime:new Date(),interactions:JSON.stringify(preface)}});
  const execution=await prisma.execution.create({data:{user,taskId:traceId,query:conversation.turns[0].input,finalResult:'正在检查随机值'}});
  const receipt={conversation:{version:1,sessionId:traceId,completedTurnIds:conversation.turns.map(turn=>turn.id)}};
  assert.doesNotThrow(()=>trace.assertConversationReceipt(conversation,traceId,JSON.stringify(receipt)));
  const input={user,traceId,conversation};
  assert.equal(await trace.findExecutionByTraceId(input),null,'terminal data from earlier rounds cannot make a tool preface a complete final reply');
  assert.equal((await trace.findExecutionByTraceId({user,traceId}))?.id,execution.id,'legacy single-turn lookup remains unchanged');
  const complete=[...preface,{role:'tool',tool_call_id:'lookup-final',content:'alpha-51'},{role:'assistant',content:'alpha-51'}];
  await prisma.session.update({where:{id:session.id},data:{interactions:JSON.stringify(complete)}});
  assert.equal(await trace.findExecutionByTraceId(input),null,'the execution output must still converge with the final reply');
  await prisma.execution.update({where:{id:execution.id},data:{finalResult:'alpha-51'}});
  assert.equal((await trace.findExecutionByTraceId(input))?.id,execution.id);
});
