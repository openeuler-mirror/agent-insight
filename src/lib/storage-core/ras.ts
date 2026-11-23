import {readCoreAnalytics,readCoreRasEvents,readCoreRasMetadata} from './analytics';
import {buildRasTaskSummaries,dedupeRasEvents,projectReliabilityTraces} from '../ingest/ras/store';

export async function handleCoreRasGet(request:Request):Promise<Response> {
  const query=new URL(request.url).searchParams;
  const taskIds=[...new Set((query.get('taskIds')||query.get('taskId')||'').split(',').map(value=>value.trim()).filter(Boolean))];
  const summary=query.get('summary')==='1';
  if(summary&&taskIds.length) {
    const raw=await readCoreRasEvents(request,taskIds,{limit:2000});
    const byTask=buildRasTaskSummaries(dedupeRasEvents(raw.events));await raw.validate();return Response.json({status:'ok',byTask});
  }
  const limit=Number(query.get('limit')||200);
  if(!Number.isSafeInteger(limit)||limit<0)throw Object.assign(new Error('Invalid RAS result limit'),{status:400});
  if(summary) {
    const source=await readCoreAnalytics(request);const pageLimit=Math.min(limit,500);
    const executions=source.findMany({where:{isSubagent:false,taskId:{not:null}},orderBy:{timestamp:'desc'},take:pageLimit});
    if(!executions.length){await source.validate();return Response.json({status:'ok',traces:[]});}
    const raw=await readCoreRasEvents(request,[...new Set(executions.map(row=>row.taskId))],{limit:2000});
    if(source.actor.principal!==raw.actor.principal||source.actor.workspace!==raw.actor.workspace)throw Object.assign(new Error('RAS actor changed'),{status:403});
    const summaries=buildRasTaskSummaries(dedupeRasEvents(raw.events));
    const sessions=executions.map(row=>({taskId:row.taskId,endTime:row.sessionEndTime?new Date(row.sessionEndTime):null,label:row.sessionLabel}));
    const meta=await readCoreRasMetadata(request,Math.max(pageLimit*10,500));
    if(source.actor.principal!==meta.actor.principal||source.actor.workspace!==meta.actor.workspace)throw Object.assign(new Error('RAS actor changed'),{status:403});
    const owners=new Map(executions.map(row=>[row.taskId,row.user]));
    const traces=projectReliabilityTraces(executions,meta.rows.filter(row=>owners.get(row.taskId)===row.user),sessions,summaries,pageLimit);
    await source.validate();await raw.validate();await meta.validate();return Response.json({status:'ok',traces});
  }
  if(!taskIds.length) {
    const recent=await readCoreRasEvents(request,[],{limit:Math.min(limit,10000),types:['anomaly']});
    if(limit>10000&&recent.hasMore)throw Object.assign(new Error('RAS result exceeds page budget'),{status:413});
    const tasks=[...new Set(recent.events.map(event=>event.taskId))];
    if(!tasks.length){await recent.validate();return Response.json({status:'ok',traces:[]});}
    const raw=await readCoreRasEvents(request,tasks,{limit:Math.min(limit,10000)});
    if(raw.actor.principal!==recent.actor.principal||raw.actor.workspace!==recent.actor.workspace)throw Object.assign(new Error('RAS actor changed'),{status:403});
    if(limit>10000&&raw.hasMore)throw Object.assign(new Error('RAS result exceeds page budget'),{status:413});
    await recent.validate();await raw.validate();return Response.json({status:'ok',events:dedupeRasEvents(raw.events)});
  }
  const raw=await readCoreRasEvents(request,taskIds,{limit:Math.min(limit,10000)});
  if(limit>10000&&raw.hasMore)throw Object.assign(new Error('RAS result exceeds page budget'),{status:413});
  await raw.validate();return Response.json({status:'ok',events:dedupeRasEvents(raw.events),executionId:taskIds.length===1?raw.executionIds[taskIds[0]]??null:null});
}
