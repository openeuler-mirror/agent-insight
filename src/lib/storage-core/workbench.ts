import {NextRequest} from 'next/server';
import {isStorageCoreEnabled} from './mode';
import {ensureCoreExperimentReadView,requireCoreExperimentContext,withCoreExperimentMutationRoute} from './experiments';
import type {CompatibilityOptions} from './compat';
import {prismaRaw} from '@/lib/storage/prisma';
import {coreDatasetRequest,type CoreDatasetSnapshot} from './datasets';
import {findAgentDataset} from '@/server/agent_datasets_storage';
export function requireWorkbenchActor(user:string){const context=requireCoreExperimentContext();if(context.actor.username!==user)throw Object.assign(new Error('Workbench actor differs'),{status:403});return context;}
export async function workbenchReadSource<T>(legacy:T,user?:string,experimentId?:string):Promise<T>{
 if(!isStorageCoreEnabled())return legacy;
 const context=user?requireWorkbenchActor(user):requireCoreExperimentContext();await ensureCoreExperimentReadView(context,experimentId);if(!context.readView)throw Object.assign(new Error('Complete Workbench Experiment view required'),{status:503});return context.readView as T;
}
export function withCoreWorkbenchRoute(request:Request,next:(request:NextRequest)=>Promise<Response>,options:CompatibilityOptions={}):Promise<Response>{return withCoreExperimentMutationRoute(request,normalized=>next(new NextRequest(normalized)),options);}
export async function readWorkbenchFrozenDataset(user:string,experimentId:string,datasetId:string,options:{freshGrayscaleStart?:boolean}={}){
 if(!isStorageCoreEnabled())return findAgentDataset(user,datasetId);
 const context=requireWorkbenchActor(user);const result=await context.rpc('read',{experiment_id:experimentId,include_cases:false}) as {gold_redacted?:boolean;experiment:{scope:string;configSnapshotJson?:string}};
 if(result.gold_redacted)throw Object.assign(new Error('Frozen Dataset Experiment belongs to another actor'),{status:403});
 if(options.freshGrayscaleStart&&result.experiment.scope==='grayscale-ab')return findAgentDataset(user,datasetId);
 const snapshot=JSON.parse(result.experiment.configSnapshotJson||'{}');const releases=snapshot.coreAssets?.releases;
 const release=releases?.['dataset:'+datasetId]||([snapshot.datasetId,snapshot.agentEvalDatasetId].includes(datasetId)?releases?.dataset:undefined);
 if(typeof release!=='string'||!release)throw Object.assign(new Error('Frozen Dataset release is unavailable'),{status:503});
 const frozen=await coreDatasetRequest<CoreDatasetSnapshot>('get',{dataset_id:datasetId,version:release});
 if(frozen.release_id!==release||frozen.dataset?.id!==datasetId)throw Object.assign(new Error('Frozen Dataset receipt differs'),{status:503});
 return {...frozen.dataset,user};
}
export async function workbenchControlReadSource(user:string,experimentId?:string){
 const view=await workbenchReadSource(prismaRaw,user,experimentId);if(!isStorageCoreEnabled())return view;
 const reads=new Set(['findUnique','findUniqueOrThrow','findFirst','findFirstOrThrow','findMany','count','aggregate','groupBy']);
 const control=new Set(['grayscaleTask','reliabilityCommand','faultInjectionRun']);
 return new Proxy(view,{get(target,key){
  if(typeof key!=='string'||!control.has(key))return Reflect.get(target,key);
  const model=Reflect.get(prismaRaw,key);
  return new Proxy(model,{get(modelTarget,method){
   if(typeof method!=='string'||!reads.has(method))return async()=>{throw Object.assign(new Error('Workbench control projection is read only'),{status:503});};
   return async(query:Record<string,unknown>={})=>{const where=(query.where||{}) as Record<string,unknown>;const AND=Array.isArray(where.AND)?where.AND:where.AND?[where.AND]:[];return Reflect.apply(Reflect.get(modelTarget,method),modelTarget,[{...query,where:{...where,AND:[...AND,{user}]}}]);};
  }});
 }});
}
