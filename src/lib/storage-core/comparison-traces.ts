import {requireCoreExperimentContext} from './experiments';
import {requestCore} from './server';
import {readTraceEvidence} from './evidence';
import type {TraceCandidate} from '@/lib/engine/experiment/variable-dimension';

export async function readCoreComparisonCandidates(agent:string,model:string):Promise<TraceCandidate[]>{
 const context=requireCoreExperimentContext();
 const query=new URLSearchParams({workspace_id:context.actor.workspace,agentName:agent,includeSubagents:'true',sort:'timestamp',dir:'desc',filters:JSON.stringify([{column:'model',operator:'=',value:model}])});
 const {data}=await requestCore('/v1/compat/observe/data?'+query,{token:context.actor.token,responseLimit:64*1024*1024,timeoutMs:120_000},context.options.fetcher||fetch);
 if(!Array.isArray(data.value)||data.value.length>100000)throw Object.assign(new Error('Complete comparison Trace candidates unavailable'),{status:503});
 return data.value.map(raw=>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Object.assign(new Error('Invalid comparison Trace candidate'),{status:503});
  const row=raw as Record<string,unknown>;const stamp=new Date(String(row.timestamp));
  if(typeof row.upload_id!=='string'||!row.upload_id||!Number.isFinite(stamp.getTime())||row.agentName!==agent||row.model!==model)throw Object.assign(new Error('Comparison Trace candidate identity differs'),{status:503});
  const skills=Array.isArray(row.skills)?row.skills:[];const invoked=Array.isArray(row.invoked_skills)?row.invoked_skills:[];
  const primary=typeof skills[0]==='string'?skills[0]:null;const selected=invoked.find(item=>item&&typeof item==='object'&&(item as {name?:unknown}).name===primary) as {version?:unknown}|undefined;
  return {id:row.upload_id,taskId:typeof row.task_id==='string'?row.task_id:null,query:typeof row.query==='string'?row.query:null,model,agentName:agent,skill:primary,skillVersion:Number.isSafeInteger(selected?.version)?selected!.version as number:null,timestamp:stamp};
 });
}

export async function readCoreComparisonExecutions(ids:string[],outputIds:string[]=[]):Promise<Map<string,Record<string,unknown>>>{
 const context=requireCoreExperimentContext();const unique=[...new Set(ids)];if(unique.length>10000)throw Object.assign(new Error('Comparison execution scope exceeds budget'),{status:413});
 const result=new Map<string,Record<string,unknown>>();
 const numeric=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?value:null;
 for(let offset=0;offset<unique.length;offset+=500){
  const selected=unique.slice(offset,offset+500);const allowed=new Set(selected);
  const query=new URLSearchParams({workspace_id:context.actor.workspace,includeSubagents:'true',filters:JSON.stringify([{column:'id',operator:'any of',value:selected}])});
  const {data}=await requestCore('/v1/compat/observe/data?'+query,{token:context.actor.token,responseLimit:64*1024*1024,timeoutMs:120_000},context.options.fetcher||fetch);
  if(!Array.isArray(data.value)||data.value.length>selected.length)throw Object.assign(new Error('Invalid comparison execution summary'),{status:503});
  for(const raw of data.value){
   if(!raw||typeof raw!=='object'||Array.isArray(raw)||typeof raw.upload_id!=='string'||!allowed.has(raw.upload_id)||result.has(raw.upload_id))throw Object.assign(new Error('Comparison execution summary escaped its scope'),{status:503});
   const row=raw as Record<string,unknown>;result.set(raw.upload_id,{id:row.upload_id,cost:numeric(row.cost),latency:numeric(row.latency),toolCallCount:numeric(row.tool_call_count),isAnswerCorrect:typeof row.is_answer_correct==='boolean'?row.is_answer_correct:null,finalResult:typeof row.final_result==='string'?row.final_result:null});
  }
 }
 const required=[...new Set(outputIds)].filter(id=>result.has(id)&&result.get(id)!.finalResult===null);let next=0;
 await Promise.all(Array.from({length:Math.min(4,required.length)},async()=>{
  for(;;){const id=required[next++];if(id===undefined)return;const {evidence}=await readTraceEvidence(context.request,{executionId:id},context.options);if(evidence.execution.id!==id)throw Object.assign(new Error('Comparison execution identity differs'),{status:409});result.get(id)!.finalResult=evidence.execution.finalResult??null;}
 }));return result;
}
