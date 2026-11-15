import assert from 'node:assert/strict';
import test from 'node:test';
import {submitCoreExecutionReceipt,isCoreDeliveryUncertain} from '../src/lib/storage-core/execution-delivery';
import type {CoreExperimentContext} from '../src/lib/storage-core/experiments';
import type {ExperimentWorkHandle} from '../src/lib/storage-core/experiment-worker';
const handle={experiment_id:'exp',attempt_id:'attempt',fence:'2',run_id:'run'} as ExperimentWorkHandle;
test('lost completion response confirms the exact receipt without consulting current generation',async()=>{
 const calls:Array<{action:string;body:Record<string,unknown>}>=[];
 const context={rpc:async(action:string,body:Record<string,unknown>)=>{calls.push({action,body});if(action==='execute_complete')throw new TypeError('response lost');assert.equal(action,'lookup_operation');return {found:true,result:{execution_run_id:'original'}};}} as CoreExperimentContext;
 assert.deepEqual(await submitCoreExecutionReceipt(context,handle,{trace_id:'trace'},'same-key'),{execution_run_id:'original'});
 assert.equal(calls[1].body.operation_kind,'execute_complete');assert.equal(calls[1].body.operation_key,'same-key');assert.deepEqual(calls[1].body.operation_request,calls[0].body.operation_request);
});
test('an absent exact receipt stays indeterminate even if another slot generation is done',async()=>{
 const context={rpc:async(action:string)=>{if(action==='execute_complete')throw new TypeError('response lost');assert.equal(action,'lookup_operation');return {found:false};}} as CoreExperimentContext;
 await assert.rejects(submitCoreExecutionReceipt(context,handle,{trace_id:'trace'},'same-key'),error=>isCoreDeliveryUncertain(error)&&(error as {status?:number}).status===503);
});
test('definite validation failures are preserved without receipt lookup',async()=>{
 let calls=0;const context={rpc:async()=>{calls++;throw Object.assign(Error('not indexed'),{status:422});}} as unknown as CoreExperimentContext;
 await assert.rejects(submitCoreExecutionReceipt(context,handle,{trace_id:'trace'},'same-key'),error=>(error as {status?:number}).status===422&&!isCoreDeliveryUncertain(error));assert.equal(calls,1);
});
