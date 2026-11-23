import {createHash} from 'node:crypto';
import {prepareCoreExperimentRuntime,type CoreExperimentContext} from './experiments';
import {buildCoreTriggerDerived} from './trigger-derived';
import {matchesFrozenModelSelection} from './frozen-model';
import {runTriggerEvalLive,resolveTriggerModelConfiguration,aggregateTriggerOutcomes,type SingleRunOutcome,type RunTriggerEvalLiveArgs} from '@/lib/engine/skill-generation/evaluator/runners/triggerEval';
import type {FrozenExperimentWork} from './experiment-worker';
import type {FrozenTriggerManifest} from './trigger';

type Row=Record<string,unknown>;
interface Sample {request_hash:string;state:'intent'|'observed';response?:SingleRunOutcome&{completionOrder:number}}
const pending=(cause?:unknown)=>Object.assign(new Error('Trigger sample delivery is not confirmed',{cause}),{status:503,code:'CORE_TRIGGER_DELIVERY_PENDING',coreDeliveryUncertain:true});
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function evaluateCoreTriggerWork(work:FrozenExperimentWork,context:CoreExperimentContext,signal?:AbortSignal):Promise<Row>{
 const manifest=(work.runplan.config as Row|undefined)?.core_trigger as FrozenTriggerManifest|undefined;
 if(manifest?.kind==='draft'){const {evaluateCoreTriggerDraftWork}=await import('./trigger-draft');return evaluateCoreTriggerDraftWork(work,context,signal);}
 if(!manifest||manifest.version!==1||manifest.kind!=='run'||work.experiment_config.scope!=='skill-trigger-analysis')throw Object.assign(new Error('Frozen Trigger RunPlan required'),{status:503});
 const checkpoint=structuredClone((work as FrozenExperimentWork&{checkpoint?:Row}).checkpoint||{});
 const samples=structuredClone(checkpoint.trigger_samples||{}) as Record<string,Sample>;
 if(!samples||typeof samples!=='object'||Array.isArray(samples)||Object.values(samples).some(value=>!value||value.state!=='observed'||!value.response))throw pending();
 const started=typeof checkpoint.trigger_started_at_ms==='number'?checkpoint.trigger_started_at_ms:Date.now();
 const result=(report:ReturnType<typeof aggregateTriggerOutcomes>):Row=>({score:report.passRate*100,verdict:report.passRate>=1?'pass':'fail',summary:`触发评测通过率 ${Math.round(report.passRate*100)}%`,points:[],durationMs:Math.max(0,Number(checkpoint.trigger_finished_at_ms??Date.now())-started),evidence:{json:{coreTriggerResult:report,coreTriggerDerived:buildCoreTriggerDerived(work,manifest,report)}}});
 if(checkpoint.trigger_runtime_closed===true){
  const outcomes:SingleRunOutcome[][]=manifest.trigger_set.items.map(()=>[]);
  for(let i=0;i<outcomes.length;i++)for(let r=0;r<manifest.params.runsPerQuery;r++){
   const values=Object.entries(samples).filter(([key])=>key.startsWith(`${i}:${r}:`)).sort(([left],[right])=>Number(left.split(':')[2])-Number(right.split(':')[2]));
   const last=values.at(-1)?.[1].response;if(!last)throw pending();outcomes[i].push(last);
  }
  for(const values of outcomes)values.sort((left,right)=>Number((left as unknown as Row).completionOrder)-Number((right as unknown as Row).completionOrder));
  return result(aggregateTriggerOutcomes(manifest.trigger_set as RunTriggerEvalLiveArgs['triggerSet'],outcomes,manifest.params.triggerThreshold,manifest.skill.name));
 }
 const model=await resolveTriggerModelConfiguration(context.actor.username,manifest.modelConfigId);
 if(!manifest.model_selection||!matchesFrozenModelSelection(model,manifest.model_selection))throw Object.assign(new Error('Frozen Trigger model connection changed or is unavailable'),{status:503});
 let handle={...work.handle} as Row,chain=Promise.resolve();let order=Math.max(-1,...Object.values(samples).map(value=>value.response?.completionOrder??-1))+1;
 const save=(stage:string,change:()=>Row)=>{
  const action=chain.then(async()=>{
   signal?.throwIfAborted();const next=change(),payload={...handle,expected_revision:String(handle.checkpoint_revision),checkpoint:next};
   if(Buffer.byteLength(JSON.stringify(next),'utf8')>16*1024*1024)throw Object.assign(new Error('Trigger checkpoint exceeds the existing artifact budget'),{status:413});
   const key=`trigger:${handle.attempt_id}:${stage}:${hash(next)}`;
   try{handle=await context.rpc('checkpoint',{...payload,operation_key:key,operation_request:payload}) as Row;Object.assign(checkpoint,next);}
   catch(error){try{const receipt=await context.rpc('lookup_operation',{operation_kind:'checkpoint',operation_key:key,operation_request:payload}) as {found:boolean;result?:Row};if(receipt.found&&receipt.result){handle=receipt.result;Object.assign(checkpoint,next);return;}}catch{}throw pending(error);}
  });chain=action;return action;
 };
 await save('runtime-start',()=>({trigger_started_at_ms:started}));
 const sample=async(identity:string,perform:()=>Promise<SingleRunOutcome>)=>{
  const requestHash=hash([identity,manifest.skill,manifest.params,manifest.model_selection,manifest.trigger_set.items[Number(identity.split(':')[0])]]);const prior=samples[identity];
  if(prior){if(prior.request_hash!==requestHash||prior.state!=='observed'||!prior.response)throw pending();return structuredClone(prior.response);}
  await save(identity+':intent',()=>{samples[identity]={request_hash:requestHash,state:'intent'};return {trigger_samples:structuredClone(samples)};});
  let response:SingleRunOutcome;try{response=await perform();}catch(error){if(['EVALUATION_CLEANUP_UNCONFIRMED','CORE_TRIGGER_NOT_SUBMITTED'].includes(String((error as {code?:string}).code)))throw error;throw pending(error);}
  const observed={...response,completionOrder:order++};
  await save(identity+':observed',()=>{samples[identity]={request_hash:requestHash,state:'observed',response:observed};return {trigger_samples:structuredClone(samples)};});
  return observed;
 };
 try{
  const report=await prepareCoreExperimentRuntime(context,work,()=>runTriggerEvalLive({user:context.actor.username,skillName:manifest.skill.name,skillVersion:manifest.skill.version,triggerSet:manifest.trigger_set as RunTriggerEvalLiveArgs['triggerSet'],workspaceRoot:String(manifest.workspaceRoot),...manifest.params,signal,coreRuntime:{model,skills:[manifest.skill,...manifest.siblings],sample}}),{signal,modelConfiguration:model});
  await save('runtime-closed',()=>({trigger_runtime_closed:true,trigger_finished_at_ms:Date.now()}));return result(report);
 }catch(error){
  if((error as {code?:string}).code!=='EVALUATION_CLEANUP_UNCONFIRMED'&&!signal?.aborted){try{await save('runtime-closed',()=>({trigger_runtime_closed:true,trigger_finished_at_ms:Date.now()}));}catch{}}
  if(error&&typeof error==='object'&&!(error as {coreDeliveryUncertain?:boolean}).coreDeliveryUncertain)Object.assign(error,{coreExperimentFailureResult:{durationMs:Math.max(0,Number(checkpoint.trigger_finished_at_ms??Date.now())-started)}});
  throw error;
 }finally{await chain.catch(()=>{});}
}
