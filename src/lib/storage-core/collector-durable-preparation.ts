import {withCoreCollectorIdentity,type CoreCollectorIdentity} from './collector-identity';
import type {CollectorReservation,FrozenCollectorPreparation} from './collector-preparation';
import {controllerHeaders} from './controller';
import {requestCore} from './server';

type Row=Record<string,any>;
export interface DurableCollectorPreparation {
 scope_kind:'source'|'thread';scope_key:string;operation_key:string;
 input_hash:string;context_hash:string;capture_hash:string|null;plan_hash:string|null;seal_revision:number;
 operation_request_json:string;representation_origin:'node'|'legacy_canonical';
 prior_session_json:string;prior_session_origin:'node'|'legacy_canonical';
 capture_json:string|null;plan_json:string|null;reservation:CollectorReservation;
 source_state:string;public_ready:false;session:Row|null;
}
const failure=(status:number,message:string)=>Object.assign(new Error(message),{status});
function reference(value:DurableCollectorPreparation){return {scope_kind:value.scope_kind,scope_key:value.scope_key,operation_key:value.operation_key};}
function restore(value:unknown):DurableCollectorPreparation{
 if(!value||typeof value!=='object')throw failure(502,'Invalid collector preparation response');
 const receipt=value as DurableCollectorPreparation;
 if(typeof receipt.operation_request_json!=='string'||typeof receipt.prior_session_json!=='string'||!receipt.reservation||receipt.public_ready!==false)throw failure(502,'Invalid collector preparation response');
 receipt.reservation.operation_request=JSON.parse(receipt.operation_request_json);
 if(receipt.reservation.snapshot?.session!=null)receipt.reservation.snapshot.session=JSON.parse(receipt.prior_session_json);
 return receipt;
}
async function rpc(identity:CoreCollectorIdentity,action:string,payload:Row):Promise<DurableCollectorPreparation>{
 return withCoreCollectorIdentity(identity,async(actor,options)=>{
  const body=JSON.stringify({action,...payload});
  const response=await requestCore('/v1/compat/collector-source?'+new URLSearchParams({workspace_id:actor.workspace}),{
   token:actor.token,method:'POST',body,headers:await controllerHeaders(actor,body,'collector-source/v1'),responseLimit:256*1024*1024,
  },options?.fetcher||fetch);
  return restore(response.data.value);
 });
}
export async function beginCoreCollectorPreparation(identity:CoreCollectorIdentity,reservation:Row,operationRequest:Row):Promise<DurableCollectorPreparation>{
 return withCoreCollectorIdentity(identity,async actor=>{
  const operation_request_json=JSON.stringify(operationRequest);
  const raw=operationRequest.data??operationRequest;
  const selected=identity.operation==='snapshot'&&raw.threadOnly?{operation:'thread_only',operation_key:reservation.operation_key,source_thread_id:raw.traceThread?.sourceThreadId,framework:raw.framework,legacy_username:actor.username}:{...reservation,operation:identity.operation,legacy_username:actor.username,verified_client_id:identity.clientId??null};
  return rpc(identity,'begin_preparation',{reservation:selected,operation_request_json});
 });
}
export function sealCoreCollectorCapture(identity:CoreCollectorIdentity,receipt:DurableCollectorPreparation,capture:FrozenCollectorPreparation):Promise<DurableCollectorPreparation>{
 return rpc(identity,'seal_capture',{...reference(receipt),context_hash:receipt.context_hash,capture_json:JSON.stringify(capture)});
}
export function sealCoreCollectorPlan(identity:CoreCollectorIdentity,receipt:DurableCollectorPreparation,plan:Row):Promise<DurableCollectorPreparation>{
 const session=plan.snapshot?.session??plan.session??null;
 return rpc(identity,'seal_plan',{...reference(receipt),capture_hash:receipt.capture_hash,plan_json:JSON.stringify({...plan,serialized_session_json:JSON.stringify(session)})});
}
export function commitCoreCollectorPreparation(identity:CoreCollectorIdentity,receipt:DurableCollectorPreparation):Promise<DurableCollectorPreparation>{
 return rpc(identity,'commit_prepared',{...reference(receipt),plan_hash:receipt.plan_hash});
}
export function coreCollectorPreparationStatus(identity:CoreCollectorIdentity,receipt:DurableCollectorPreparation):Promise<DurableCollectorPreparation>{
 return rpc(identity,'preparation_status',reference(receipt));
}
async function graphContext(identity:CoreCollectorIdentity,receipt:DurableCollectorPreparation,input:{children:Row[];thread:Row|null;sweep:boolean}):Promise<Row>{
 return withCoreCollectorIdentity(identity,async(actor,options)=>{
  const body=JSON.stringify({action:'capture_graph_context',...reference(receipt),context_hash:receipt.context_hash,...input});
  const response=await requestCore('/v1/compat/collector-source?'+new URLSearchParams({workspace_id:actor.workspace}),{token:actor.token,method:'POST',body,headers:await controllerHeaders(actor,body,'collector-source/v1'),responseLimit:256*1024*1024},options.fetcher||fetch);
  const value=response.data.value as Row;if(!value||value.version!==1||!Array.isArray(value.children))throw failure(502,'Invalid collector graph context');return value;
 });
}
export async function captureDurableCoreCollectorPreparation(identity:CoreCollectorIdentity,receipt:DurableCollectorPreparation,projection:{executionMatch?:Row|null;threadId?:string|null}={}):Promise<DurableCollectorPreparation>{
 const current=await coreCollectorPreparationStatus(identity,receipt);
 if(current.capture_json!==null||current.source_state!=='reserved')return current;
 const {captureCoreCollectorPreparation}=await import('./collector-preparation');
 const frozen=await captureCoreCollectorPreparation(identity,current.reservation,{...projection,previousSession:JSON.parse(current.prior_session_json),graphContext:input=>graphContext(identity,current,input)});
 return sealCoreCollectorCapture(identity,current,frozen);
}
export async function prepareDurableCoreCollectorPlan(identity:CoreCollectorIdentity,receipt:DurableCollectorPreparation):Promise<DurableCollectorPreparation>{
 const current=await coreCollectorPreparationStatus(identity,receipt);
 if(current.plan_json!==null||current.source_state!=='reserved')return current;
 if(current.capture_json===null)throw failure(409,'Collector capture must be sealed first');
 const {prepareCoreCollectorSnapshot,prepareCoreCollectorCompletion,prepareCoreCollectorThread}=await import('./collector-preparation');
 const frozen=JSON.parse(current.capture_json) as FrozenCollectorPreparation;
 const plan=current.reservation.operation==='thread_only'?prepareCoreCollectorThread(current.reservation,frozen):current.reservation.operation==='complete'?prepareCoreCollectorCompletion(current.reservation,frozen):await prepareCoreCollectorSnapshot(current.reservation,frozen);
 return sealCoreCollectorPlan(identity,current,plan);
}
