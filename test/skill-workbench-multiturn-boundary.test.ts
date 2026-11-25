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
import {NextRequest} from 'next/server';
import {createRequire} from 'node:module';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'skill-multiturn-boundary-'));fs.mkdirSync(path.join(home,'data'));
const database=path.join(home,'data/witty_insight.db');fs.closeSync(fs.openSync(database,'a'));
process.env.AGENT_INSIGHT_HOME=home;delete process.env.AGENT_INSIGHT_DATA_DIR;delete process.env.DB_HOST;process.env.DATABASE_URL='file:'+database;
execFileSync(process.execPath,[path.resolve('node_modules/prisma/build/index.js'),'db','push','--skip-generate'],{env:process.env,stdio:'pipe'});
let prisma:any,service:any,route:any,grayscale:any;
const require=createRequire(import.meta.url),generalAgentPath=require.resolve('@/lib/engine/general-agent');
const originalGeneralAgent=require.cache[generalAgentPath];
const user='skill-boundary@example.test',skillName='boundary-skill',datasetId='boundary-dataset';
const executionTarget={workerId:'boundary-worker',host:'fixture-host',platform:'opencode',agent:'build',model:'fixture/model'};
const single={id:'single',input:'single question',expectedOutput:'answer',turns:[{input:'single question',expectedOutput:'answer'}]};
const multi={id:'multi',input:'first',expectedOutput:'final',turns:[{input:'first'},{input:'second',expectedOutput:'final'}]};
function request(body:unknown){return new NextRequest('http://localhost/api/skill-workbench/skills/boundary-skill/experiments',{method:'POST',headers:{'content-type':'application/json','x-witty-api-key':'wi_skill_boundary_fixture'},body:JSON.stringify(body)});}
test.before(async()=>{
 prisma=(await import('@/lib/storage/prisma')).prismaRaw;service=await import('@/lib/skill-workbench/experiment-service');route=await import('@/app/api/skill-workbench/skills/[name]/experiments/route');
 require.cache[generalAgentPath]={id:generalAgentPath,filename:generalAgentPath,loaded:true,exports:{runGeneralAgent:()=>assert.fail('多轮边界检查不得运行Agent')}} as any;
 grayscale=await import('@/app/api/debug/grayscale-tasks/[taskId]/route');
 await prisma.user.create({data:{username:user,apiKey:'wi_skill_boundary_fixture'}});
 await prisma.skill.create({data:{user,name:skillName,versions:{create:[{version:1,content:'---\nname: boundary-skill\ndescription: fixture\n---\nFollow user instructions.'},{version:2,content:'---\nname: boundary-skill\ndescription: fixture\n---\nAnother instruction.'}]}}});
 await prisma.agentEvalDataset.create({data:{id:datasetId,user,name:'Mixed cases',casesJson:JSON.stringify([single,multi])}});
 await prisma.reliabilityClient.create({data:{clientId:executionTarget.workerId,user,name:'fixture',hostname:'fixture-host',status:'online',lastSeenAt:new Date(),capabilitiesJson:JSON.stringify({actions:['RUN_EXPERIMENT_CASE'],platforms:[{id:'opencode',agents:['build'],models:['fixture/model'],runExperimentCase:{version:2,returnsTraceId:true,ready:true,skillSnapshotVersion:4,multiTurn:true,sessionContinuation:true,conversationVersion:1}}]})}});
});
test.after(async()=>{if(originalGeneralAgent)require.cache[generalAgentPath]=originalGeneralAgent;else delete require.cache[generalAgentPath];await prisma?.$disconnect();fs.rmSync(home,{recursive:true,force:true});});
test('Skill用例生成与A/B必须根据真实所选Case拒绝多轮，不信任existing Trace声明',async()=>{
 for(const preset of ['use-case','skill-ab']){
  const response=await route.POST(request({user,version:1,preset,compareVersion:2,datasetId,caseIds:['multi'],traceSource:'existing',cases:[single],executionTarget,evaluatorIds:['preset-agent-task-completion']}),{params:Promise.resolve({name:skillName})});
  assert.equal(response.status,400);const body=await response.json();assert.equal(body.code,'SKILL_MULTI_TURN_UNSUPPORTED');assert.match(body.error,/普通实验.*已有 Trace/);
 }
 assert.equal(await prisma.experiment.count(),0);assert.equal(await prisma.grayscaleTask.count(),0);
});
test('同一混合集只选单轮时保留Skill原创建流程',async()=>{
 const result=await service.createWorkbenchExperiment({user,skillName,version:1,preset:'use-case',datasetId,caseIds:['single'],executionTarget,evaluatorIds:['preset-agent-task-completion']});
 assert.equal(result.kind,'created');assert.deepEqual(result.configSnapshot.caseIds,['single']);
});
test('创建后数据集新增多轮时，执行与重新执行都重读真实Case并在下发前拒绝',async()=>{
 const created=await service.createWorkbenchExperiment({user,skillName,version:1,preset:'use-case',datasetId,caseIds:['single'],executionTarget,evaluatorIds:['preset-agent-task-completion']});
 assert.equal(created.kind,'created');
 await prisma.agentEvalDataset.update({where:{id:datasetId},data:{casesJson:JSON.stringify([{...multi,id:'single'},multi])}});
 const params={params:Promise.resolve({taskId:created.grayscaleTask.id})};
 let response=await grayscale.POST(request({user,action:'start',caseIds:['single'],cases:[single],traceSource:'existing'}),params);
 assert.equal(response.status,400);assert.equal((await response.json()).code,'SKILL_MULTI_TURN_UNSUPPORTED');
 assert.equal((await prisma.experiment.findUnique({where:{id:created.experiment.id}})).status,'draft');
 await prisma.experiment.update({where:{id:created.experiment.id},data:{status:'failed'}});
 await prisma.grayscaleTask.update({where:{id:created.grayscaleTask.id},data:{caseStatesJson:JSON.stringify({single:{b:{status:'fail',runs:[{status:'fail',runIndex:1,roundIndex:1,caseId:'single'}]}}})}});
 response=await grayscale.POST(request({user,action:'retry-execution',caseId:'single',side:'b',runIndex:1,cases:[single]}),params);
 assert.equal(response.status,409);assert.match((await response.json()).error,/普通实验.*已有 Trace/);
 assert.equal(await prisma.experimentTraceAttempt.count(),0);assert.equal(await prisma.reliabilityCommand.count(),0);
});
