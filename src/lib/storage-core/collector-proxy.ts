import {resolveCollectorRequest,collectorPrivate,collectorFailure,collectorHash} from './collector-entry';
import {withCoreCollectorIdentity} from './collector-identity';
import {freezeModelSelection} from './frozen-model';
import {getActiveConfig} from '@/lib/storage/server-config';
import {endSession} from '@/lib/ingest/proxy-store';
import {kickCoreCollectorWorker} from './collector-worker';
export async function handleCoreProxyEnd(request:Request,taskId:string){
 try{
  const body=await request.json().catch(()=>({}));const identity=await resolveCollectorRequest(request,'snapshot',body);
  return await withCoreCollectorIdentity(identity,async()=>{
   await collectorPrivate(identity,'model_scope',{task_id:taskId});
   const session=await endSession(taskId);if(!session)return Response.json({error:'Session not found or empty'},{status:404});
   const model=await getActiveConfig(identity.username);const work=await collectorPrivate(identity,'collector_jobs',{job_action:'enqueue_proxy',value:{task_id:taskId,operation_key:request.headers.get('idempotency-key')||'end:'+collectorHash(body),body,model_selection:freezeModelSelection(model)}});
   kickCoreCollectorWorker(identity);const deadline=Date.now()+55000;
   while(Date.now()<deadline){const result=await collectorPrivate(identity,'collector_jobs',{job_action:'result',value:work});if(result.response)return Response.json(result.response.body,{status:result.response.status});if(result.state==='sent')throw Object.assign(new Error('Proxy analysis source changed'),{status:409});await new Promise(resolve=>setTimeout(resolve,100));}
   throw Object.assign(new Error('Proxy end remains durably pending'),{status:503});
  });
 }catch(error){return collectorFailure(error);}
}
