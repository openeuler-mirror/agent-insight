import {readCoreAnalytics,readCoreAgentMetadata} from './analytics';
import {requireCoreControlContext} from './control-context';
import {controlClient,controlRepositoryRequest} from './control-repository';
export async function deleteCoreControlAgent(request:Request,id:string){
 const context=requireCoreControlContext();const agent=await controlClient.registeredAgent.findUnique({where:{id}});if(!agent)return null;
 const source=await readCoreAnalytics(request);const metadata=await readCoreAgentMetadata(source);const rows=metadata.filter(row=>(row.user===context.actor.principalUsername||row.user===context.actor.username)&&(row.agentId===id||row.agentName===agent.name&&row.framework===agent.platform));
 await source.validate();const result=await controlRepositoryRequest('agent_delete',{agent_id:id,trace_ids:[...new Set(rows.map(row=>row.trace_id))]});
 return {...result,opencodeSessions:rows.filter(row=>row.framework==='opencode').flatMap(row=>[row.taskId,row.executionId])} as {deletedTraces:number;opencodeSessions:string[]};
}
