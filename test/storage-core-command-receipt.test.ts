import assert from 'node:assert/strict';
import test from 'node:test';
import {createIsolatedDatabase} from './helpers/isolated-database';
const database=createIsolatedDatabase();
import {prismaRaw as prisma} from '@/lib/storage/prisma';
import {applyCommandStatus} from '@/lib/reliability/command-bus';
test.after(async()=>{await prisma.$disconnect();database.dispose();});
for(const core of [false,true])for(const marked of [false,true])test(`late command receipt preserves historical attempts in core and retains command completion: core=${core} marker=${marked}`,async()=>{
 const id=`${core}-${marked}`;const clientId='receipt-client-'+id;
 await prisma.reliabilityClient.create({data:{clientId,user:'alice',name:clientId,lastSeenAt:new Date()}});
 const exp=await prisma.experiment.create({data:{user:'alice',name:id,agentName:'agent',evaluatorIdsJson:'[]'}});
 const item=await prisma.experimentCase.create({data:{experimentId:exp.id,input:'preserved'}});
 const attempt=await prisma.experimentTraceAttempt.create({data:{experimentId:exp.id,caseId:item.id,attemptNo:1,workerId:clientId,platform:'opencode',agent:'agent',status:'running',commandId:'command-'+id}});
 const correlation={experimentId:exp.id,caseRunId:item.id,traceAttemptId:attempt.id,...(marked?{storageCore:true}:{})};
 await prisma.reliabilityCommand.create({data:{commandId:'command-'+id,clientId,user:'alice',action:'RUN_EXPERIMENT_CASE',status:'RUNNING',expiresAt:new Date(Date.now()+60000),payloadJson:JSON.stringify({correlation})}});
 const previous=process.env.AGENT_INSIGHT_TRACE_STORAGE;process.env.AGENT_INSIGHT_TRACE_STORAGE=core?'core':'legacy';
 try{
  const response=await applyCommandStatus({clientId,commandId:'command-'+id,status:'SUCCEEDED',result:{traceId:'business-trace-'+id}});assert.equal(response.applied,true);
  const current=await prisma.experimentTraceAttempt.findUniqueOrThrow({where:{id:attempt.id}});
  if(core||marked)assert.deepEqual(current,attempt);else assert.equal(current.traceId,'business-trace-'+id);
  const command=await prisma.reliabilityCommand.findUniqueOrThrow({where:{commandId:'command-'+id}});assert.equal(command.status,'SUCCEEDED');assert.equal(JSON.parse(command.resultJson!).traceId,'business-trace-'+id);
  assert.equal((await applyCommandStatus({clientId,commandId:'command-'+id,status:'FAILED',error:{code:'late'}})).applied,false);assert.equal((await prisma.reliabilityCommand.findUniqueOrThrow({where:{commandId:'command-'+id}})).status,'SUCCEEDED');
 }finally{if(previous===undefined)delete process.env.AGENT_INSIGHT_TRACE_STORAGE;else process.env.AGENT_INSIGHT_TRACE_STORAGE=previous;}
});
