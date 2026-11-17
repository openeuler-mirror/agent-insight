import {recordUsageEvent} from '@/lib/usage-analytics/collector';
import {isUsageEnabled} from '@/lib/usage-analytics/config';
import {runWithCoreControlActor,getCoreControlContext,type CoreControlActor,type CoreControlContext} from './control-context';
import {getCoreSessionScope} from './session-source';
import {getCoreExperimentContext} from './experiments';
import {requireCoreReportContext} from './reports';
import {coreServiceOrigin} from './server';
import {semanticRpc,semanticContext} from './semantic-sources';
import {todayDateKey} from '@/lib/usage-analytics/date';
import {getRawRetentionDays} from '@/lib/usage-analytics/config';
import {UsagePersistError} from '@/lib/usage-analytics/types';
import type {UsageEvent,UsageDailyRow,UsageStorage} from '@/lib/usage-analytics/types';
const identities=new WeakMap<UsageEvent,CoreControlContext>();
export function bindCoreUsageEvent(event:UsageEvent):boolean{
 let context:CoreControlContext;
 try{context=semanticContext();}catch{
  try{const scope=requireCoreReportContext();if(!scope.actor.username)return false;context={actor:{...scope.actor,username:scope.actor.username},options:scope.options,origin:coreServiceOrigin(),access:'request'};}catch{return false;}
 }
 if(context.actor.username!==event.user)return false;
 identities.set(event,context);return true;
}
export function recordVerifiedCoreUsage(actor:CoreControlActor,options:CoreControlContext['options'],featureKey:string,eventKey:string):void{
 try{if(!isUsageEnabled())return;runWithCoreControlActor(actor,options,()=>recordUsageEvent({user:actor.username,featureKey,eventKey}));}catch{}
}
export async function coreUsageAdmin(){try{return !!(await semanticRpc<{admin:boolean}>('scope')).admin;}catch{return false;}}
export class CoreUsageStorage implements UsageStorage {
 private cleanups=new Map<string,string>();
 async persistBatch(events:UsageEvent[]):Promise<number>{
  const groups=new Map<string,{context:CoreControlContext;events:UsageEvent[]}>();
  for(const event of events){const context=identities.get(event);if(!context)throw new Error('Usage event lacks verified ingress identity');const key=context.actor.workspace+'\0'+context.actor.principal+'\0'+context.actor.token;let group=groups.get(key);if(!group){group={context,events:[]};groups.set(key,group);}group.events.push(event);}
  let inserted=0;const batches=[...groups.values()];for(let index=0;index<batches.length;index++){const {context,events:batch}=batches[index];try{inserted+=await semanticRpc<number>('usage_persist',{events:batch.map(event=>({...event,occurredAt:event.occurredAt.toISOString()}))},context);}catch{throw new UsagePersistError(inserted,batches.slice(index).flatMap(group=>group.events));}
   const key=context.actor.workspace+'\0'+context.actor.principal,today=todayDateKey();
   if(this.cleanups.get(key)!==today){try{await semanticRpc('usage_cleanup',{date_key:todayDateKey(new Date(Date.now()-getRawRetentionDays()*86400000)),limit:5000},context);this.cleanups.set(key,today);if(this.cleanups.size>5000)this.cleanups.delete(this.cleanups.keys().next().value!);}catch{}}
  }
  return inserted;
 }
 queryDaily(from:string|null,to:string,featureKey?:string):Promise<UsageDailyRow[]>{return semanticRpc('usage_daily',{from_:from,to,...(featureKey?{feature:featureKey}:{})});}
 earliestDateKey():Promise<string|null>{return semanticRpc('usage_earliest');}
 async cleanupRawBefore(dateKey:string,maxBatches=5):Promise<number>{
  if(!getCoreControlContext()&&!getCoreSessionScope()&&!getCoreExperimentContext())return 0;
  return semanticRpc('usage_cleanup',{date_key:dateKey,limit:Math.min(50000,Math.max(1,maxBatches)*1000)});
 }
}
