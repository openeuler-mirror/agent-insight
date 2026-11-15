import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import type {CoreExperimentContext} from './experiments';
import type {FrozenExperimentWork} from './experiment-worker';
type Row=Record<string,unknown>;
interface Delivery {context:CoreExperimentContext;handle:Row;calls:Row;cursor:number;chain:Promise<void>;inflight:Set<Promise<unknown>>}
const key=Symbol.for('agent-insight.storage-core.flow-model-delivery');
const globals=globalThis as unknown as Record<symbol,AsyncLocalStorage<Delivery>>;
const deliveries=globals[key] ||= new AsyncLocalStorage<Delivery>();
const object=(value:unknown):value is Row=>!!value&&typeof value==='object'&&!Array.isArray(value);
function pending():Error{return Object.assign(new Error('Flow model delivery is not confirmed'),{status:503,code:'CORE_FLOW_MODEL_DELIVERY_PENDING',coreDeliveryUncertain:true});}
export const getCoreFlowModelDeliveryContext=()=>deliveries.getStore();
export async function withCoreFlowModelDelivery<T>(context:CoreExperimentContext,work:FrozenExperimentWork,action:()=>Promise<T>):Promise<T>{
 const checkpoint=(work as FrozenExperimentWork&{checkpoint?:Row}).checkpoint;const raw=checkpoint?._flow_model_calls;
 if(raw!==undefined&&!object(raw))throw pending();
 const calls=structuredClone(raw||{}) as Row;
 const entries=Object.entries(calls);if(entries.length>1000)throw pending();
 for(let index=0;index<entries.length;index++)if(!Object.hasOwn(calls,String(index)))throw pending();
 const scope:Delivery={context,handle:{...work.handle},calls,cursor:0,chain:Promise.resolve(),inflight:new Set()};
 return deliveries.run(scope,async()=>{try{return await action();}finally{while(scope.inflight.size)await Promise.allSettled([...scope.inflight]);await scope.chain.catch(()=>{});}});
}
async function save(scope:Delivery,index:number,stage:string){
 const work=scope.chain.then(async()=>{
  const checkpoint={_flow_model_calls:structuredClone(scope.calls)};
  if(Buffer.byteLength(JSON.stringify(checkpoint),'utf8')>8*1024*1024)throw pending();
  const payload={...scope.handle,expected_revision:String(scope.handle.checkpoint_revision),checkpoint};
  const operationKey=`flow-model:${scope.handle.attempt_id}:${index}:${stage}`;const request=payload;
  try{scope.handle=await scope.context.rpc('checkpoint',{...payload,operation_key:operationKey,operation_request:request}) as Row;}
  catch(error){
   try{const receipt=await scope.context.rpc('lookup_operation',{operation_kind:'checkpoint',operation_key:operationKey,operation_request:request}) as {found:boolean;result?:Row};if(receipt.found&&receipt.result){scope.handle=receipt.result;return;}}catch{}
   throw pending();
  }
 });
 scope.chain=work;await work;
}
async function execute<T>(scope:Delivery,body:unknown,perform:()=>Promise<T>):Promise<T>{
 const index=scope.cursor++;if(index>=1000)throw pending();
 const hash=createHash('sha256').update(JSON.stringify(body)).digest('hex');const old=scope.calls[String(index)];
 if(old!==undefined){
  if(!object(old)||old.request_hash!==hash)throw pending();
  if(old.state==='observed'&&object(old.response))return structuredClone(old.response) as T;
  if(old.state==='failed')throw new Error('Previously recorded flow model request failed');
  throw pending();
 }
 scope.calls[String(index)]={request_hash:hash,state:'intent'};await save(scope,index,'intent');
 let response:T;
 try{response=await perform();}
 catch(error){
  if((error as {code?:string})?.code==='CORE_TRACE_RECORDING_FAILED'||(error as {coreDeliveryUncertain?:boolean})?.coreDeliveryUncertain)throw pending();
  scope.calls[String(index)]={request_hash:hash,state:'failed'};await save(scope,index,'failed');throw error;
 }
 if(!object(response))throw pending();
 scope.calls[String(index)]={request_hash:hash,state:'observed',response:structuredClone(response)};await save(scope,index,'observed');return response;
}
export function executeCoreFlowModelCall<T>(body:unknown,perform:()=>Promise<T>):Promise<T>{
 const scope=deliveries.getStore();if(!scope)return perform();
 const work=execute(scope,body,perform);scope.inflight.add(work);void work.finally(()=>scope.inflight.delete(work)).catch(()=>{});return work;
}
