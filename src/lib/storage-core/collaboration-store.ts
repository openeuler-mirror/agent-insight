import {randomUUID} from 'node:crypto';
import {CollaborationStore,MAX_GROUP_EVENTS,MAX_TRACE_SESSIONS,type SavedEvent,type SavedBinding,type SavedResolution} from '@/lib/collaboration/store';
import {canonical,digest,CollaborationError,type Binding,type RelationEvent} from '@/lib/collaboration/contracts';
import {semanticProjection as repository} from './semantic-sources';
import {findCoreTraceSession} from './collector-read-source';
const unavailable=async():Promise<never>=>{throw new Error('Raw SQL is unavailable in core collaboration storage');};
const saved=(row:any):SavedEvent=>({id:row.id,eventId:row.eventId,bodyJson:row.eventBodyJson,bodyHash:row.contentHash,receivedAt:row.receivedAt,sourceType:row.sourceType});
export class CoreCollaborationStore extends CollaborationStore {
 constructor(){super({rows:unavailable,execute:unavailable,transaction:unavailable});}
 private async ensureCore(tx:typeof repository,user:string,id:string){return tx.collaboration.upsert({where:{user_collaborationId:{user,collaborationId:id}},create:{user,collaborationId:id,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()},update:{}});}
 override async saveEvent(user:string,event:RelationEvent){return repository.$transaction(async tx=>{
  const collab=await this.ensureCore(tx as typeof repository,user,event.collaborationId);let existing=await tx.collaborationEvent.findUnique({where:{user_collaborationId_eventId:{user,collaborationId:event.collaborationId,eventId:event.eventId}}});
  const body=canonical(event),hash=digest(event);if(existing){if(existing.contentHash!==hash||existing.eventBodyJson!==body)throw new CollaborationError(409,'EVENT_CONFLICT','该事件编号已保存不同内容，不能覆盖');return {saved:saved(existing),result:'duplicate' as const};}
  existing=await tx.collaborationEvent.create({data:{id:randomUUID(),collaborationDbId:collab.id,user,collaborationId:event.collaborationId,eventId:event.eventId,fromSessionId:event.fromSessionId,toSessionId:event.toSessionId,description:event.description,observedAt:event.observedAt?new Date(event.observedAt):null,content:event.content??null,fromLocatorJson:event.fromLocator?canonical(event.fromLocator):null,sourceType:'reported',eventBodyJson:body,contentHash:hash,receivedAt:new Date().toISOString(),endpointResolutions:{create:[{side:'from',linkState:'pending'},{side:'to',linkState:'pending'}]}}});
  await tx.collaboration.update({where:{id:collab.id},data:{updatedAt:new Date().toISOString()}});return {saved:saved(existing),result:'created' as const};
 });}
 override async bind(user:string,binding:Binding){return repository.$transaction(async tx=>{
  await this.ensureCore(tx as typeof repository,user,binding.collaborationId);await findCoreTraceSession(user,binding.traceSessionId);
  const existing=await tx.collaborationSessionBinding.findUnique({where:{user_collaborationId_sessionId:{user,collaborationId:binding.collaborationId,sessionId:binding.sessionId}}});
  if(existing){if(existing.traceSessionId!==binding.traceSessionId||existing.eventClock!==binding.eventClock)throw new CollaborationError(409,'BINDING_CONFLICT','会话绑定或时钟依据已存在，不能覆盖');return {...binding,createdAt:existing.createdAt,result:'duplicate'};}
  const row=await tx.collaborationSessionBinding.create({data:{user,...binding,createdAt:new Date().toISOString()}});return {...binding,createdAt:row.createdAt,result:'created'};
 });}
 override async snapshot(user:string,id:string,offset:number,limit:number){return repository.$transaction(async tx=>{
  const collab=await tx.collaboration.findUnique({where:{user_collaborationId:{user,collaborationId:id}}});if(!collab)throw new CollaborationError(404,'NOT_FOUND','协作不存在或无权访问');
  const rows=await tx.collaborationEvent.findMany({where:{user,collaborationId:id},orderBy:[{receivedAt:'asc'},{id:'asc'}]});const bindings=await tx.collaborationSessionBinding.findMany({where:{user,collaborationId:id},orderBy:{id:'asc'},take:MAX_TRACE_SESSIONS+1});
  const total=rows.length;return {total,page:rows.slice(offset,offset+limit).map(saved),events:total<=MAX_GROUP_EVENTS?rows.map(saved):[],bindings:bindings as SavedBinding[],complete:total<=MAX_GROUP_EVENTS&&bindings.length<=MAX_TRACE_SESSIONS};
 });}
 override async resolutions(eventIds:string[]):Promise<SavedResolution[]>{if(!eventIds.length)return [];return repository.collaborationEndpointResolution.findMany({where:{eventDbId:{in:eventIds}},select:{eventDbId:true,side:true,executionId:true,linkState:true,linkMethod:true,evidenceJson:true,anchorState:true,anchorJson:true}}) as Promise<SavedResolution[]>;}
}
