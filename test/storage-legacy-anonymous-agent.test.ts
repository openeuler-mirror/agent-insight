import test from 'node:test';
import assert from 'node:assert/strict';
import {createIsolatedDatabase} from './helpers/isolated-database';
test('original legacy upload handler and list keep generic anonymous Agent absent and explicit names intact',async()=>{
 const database=createIsolatedDatabase();process.env.AGENT_INSIGHT_TRACE_STORAGE='legacy';const original=globalThis.fetch;globalThis.fetch=async()=>{throw Error('External network disabled in legacy anonymous fixture');};
 const {prismaRaw}=await import('@/lib/storage/prisma');
 try{
  await prismaRaw.user.create({data:{username:'agent-owner',apiKey:'legacy-agent-fixture-key'}});await prismaRaw.userSettings.create({data:{user:'agent-owner',settingsJson:JSON.stringify({activeConfigId:null,configs:[],autoEvaluationEnabled:false})}});
  const {POST}=await import('@/app/api/ingest/upload/route');const {readRecords}=await import('@/lib/storage/data-service');
  for(const [index,agent] of [undefined,null,'unknown','collector','named-agent'].entries()){
   const task='legacy-agent-'+index;const response=await POST(new Request('http://localhost/api/ingest/upload',{method:'POST',headers:{'x-witty-api-key':'legacy-agent-fixture-key','content-type':'application/json'},body:JSON.stringify({task_id:task,framework:'generic',...(agent===undefined?{}:{agentName:agent}),query:'original question',interactions:[{role:'user',content:'original question'},{role:'assistant',content:'original answer'}]})}));assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).background_analysis,false);
   const stored=await prismaRaw.execution.findFirstOrThrow({where:{taskId:task}});const record=(await readRecords('agent-owner')).find(row=>row.task_id===task)!;assert.ok(record);
   assert.equal(stored.agentName,agent??null);const dto=JSON.parse(JSON.stringify({agent:record.agent,agentName:record.agentName}));assert.deepEqual(dto,agent?{agent,agentName:agent}:{});
  }
 }finally{await prismaRaw.$disconnect();globalThis.fetch=original;database.dispose();}
});
