import type {CoreExperimentContext} from './experiments';
import type {ExperimentWorkHandle} from './experiment-worker';

export function isCoreDeliveryUncertain(error:unknown):boolean {
 return !!error&&typeof error==='object'&&(error as {coreDeliveryUncertain?:boolean}).coreDeliveryUncertain===true;
}

export async function submitCoreOperationReceipt(context:CoreExperimentContext,action:'complete'|'execute_complete',payload:Record<string,unknown>,operationKey:string,operationRequest:Record<string,unknown>=payload):Promise<unknown> {
 try{return await context.rpc(action,{...payload,operation_key:operationKey,operation_request:operationRequest});}
 catch(error){
  const status=(error as {status?:number})?.status;
  if(status!==undefined&&![502,503,504].includes(status))throw error;
  try{
   const receipt=await context.rpc('lookup_operation',{operation_kind:action,operation_key:operationKey,operation_request:operationRequest}) as {found:boolean;result?:unknown};
   if(receipt?.found===true&&Object.hasOwn(receipt,'result'))return receipt.result;
   if(receipt?.found===false){
    try{return await context.rpc(action,{...payload,operation_key:operationKey,operation_request:operationRequest});}
    catch(replay){const code=(replay as {status?:number})?.status;if(code!==undefined&&![502,503,504].includes(code))throw Object.assign(replay as object,{coreDeliveryUncertain:true});}
   }
  }catch(lookup){if([400,401,403,404,409,410,413,422].includes((lookup as {status?:number})?.status||0))throw Object.assign(lookup as object,{coreDeliveryUncertain:true});}
  throw Object.assign(new Error('Experiment completion delivery is not confirmed'),{status:503,coreDeliveryUncertain:true});
 }
}

export function submitCoreExecutionReceipt(context:CoreExperimentContext,handle:ExperimentWorkHandle,values:Record<string,unknown>,operationKey:string,operationRequest?:Record<string,unknown>):Promise<unknown> {
 const payload={...handle,...values};
 return submitCoreOperationReceipt(context,'execute_complete',payload,operationKey,operationRequest||payload);
}
