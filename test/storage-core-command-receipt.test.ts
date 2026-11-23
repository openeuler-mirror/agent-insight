import assert from 'node:assert/strict';
import test from 'node:test';
import {createIsolatedDatabase} from './helpers/isolated-database';
const database=createIsolatedDatabase();
import {startIsolatedControlCore} from './helpers/isolated-control-core';
import {prisma as historical} from './helpers/historical-prisma';
let core: Awaited<ReturnType<typeof startIsolatedControlCore>>;
test.before(async()=>{core=await startIsolatedControlCore(['alice']);});
import {prismaRaw as prisma} from '@/lib/storage/prisma';
import {applyCommandStatus} from '@/lib/reliability/command-bus';
test.after(async()=>{await historical.$disconnect();await core?.dispose();database.dispose();});
for(const configured of [false,true])for(const marked of [false,true])test(`Core command receipt preserves historical attempts: explicit mode=${configured} marker=${marked}`,async()=>core.run('alice',async()=>{
 const id=`${configured}-${marked}`;const clientId='receipt-client-'+id;
 await prisma.reliabilityClient.create({data:{clientId,user:'alice',name:clientId,lastSeenAt:new Date()}});
 const exp=await historical.experiment.create({data:{user:'alice',name:id,agentName:'agent',evaluatorIdsJson:'[]'}});
 const item=await historical.experimentCase.create({data:{experimentId:exp.id,input:'preserved'}});
 const attempt=await historical.experimentTraceAttempt.create({data:{experimentId:exp.id,caseId:item.id,attemptNo:1,workerId:clientId,platform:'opencode',agent:'agent',status:'running',commandId:'command-'+id}});
 const correlation={experimentId:exp.id,caseRunId:item.id,traceAttemptId:attempt.id,...(marked?{storageCore:true}:{})};
 await prisma.reliabilityCommand.create({data:{commandId:'command-'+id,clientId,user:'alice',action:'RUN_EXPERIMENT_CASE',status:'RUNNING',expiresAt:new Date(Date.now()+60000),payloadJson:JSON.stringify({correlation})}});
 const previous=process.env.AGENT_INSIGHT_TRACE_STORAGE;if(configured)process.env.AGENT_INSIGHT_TRACE_STORAGE='core';else delete process.env.AGENT_INSIGHT_TRACE_STORAGE;
 try{
  const response=await applyCommandStatus({clientId,commandId:'command-'+id,status:'SUCCEEDED',result:{traceId:'business-trace-'+id}});assert.equal(response.applied,true);
  const current=await historical.experimentTraceAttempt.findUniqueOrThrow({where:{id:attempt.id}});
  assert.deepEqual(current,attempt);
  const command=await prisma.reliabilityCommand.findUniqueOrThrow({where:{commandId:'command-'+id}});assert.equal(command.status,'SUCCEEDED');assert.equal(JSON.parse(command.resultJson!).traceId,'business-trace-'+id);
  assert.equal((await applyCommandStatus({clientId,commandId:'command-'+id,status:'FAILED',error:{code:'late'}})).applied,false);assert.equal((await prisma.reliabilityCommand.findUniqueOrThrow({where:{commandId:'command-'+id}})).status,'SUCCEEDED');
 }finally{if(previous===undefined)delete process.env.AGENT_INSIGHT_TRACE_STORAGE;else process.env.AGENT_INSIGHT_TRACE_STORAGE=previous;}
}));
