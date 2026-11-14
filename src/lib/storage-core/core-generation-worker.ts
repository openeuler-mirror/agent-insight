import { randomUUID } from 'node:crypto';
import { hash, LEGACY_POLICY, lexicalSteps, signatureSteps, type Candidate, type LexicalFeatures, type Policy } from '@/lib/trace-datasets/sampling';
import { PRODUCTION_POLICY, productionSampleSteps, supportedProductionPolicy } from '@/lib/trace-datasets/sampling/production';
import { normalizeTraceCases, type GenerationSummary } from '@/lib/trace-datasets/contracts';
import { normalizeSourceUnits } from '@/server/trace-datasets/trace-analysis';
import { processContent } from '@/server/trace-datasets/content-processor';
import type { Source } from '@/server/trace-datasets/normalizer';
import type { GenerationActor, GenerationRPC } from './dataset-generation';

interface Claim {jobId:string;datasetId:string;epoch:number;leaseOwner:string;config:{limit:number;policy:Policy&{signatureProtocol:string}}}
interface Member {id:string;fingerprint:string}
const tasks=new Map<string,{run:()=>Promise<void>;principal:string;workspace:string;dataset:string}>();
let active=0;
const activeKeys=new Set<string>();
function pump() {
 for(const [key,task] of tasks) {
  if(active>=2)return;
  if(activeKeys.has(key))continue;
  active++;activeKeys.add(key);
  void task.run().catch(()=>{}).finally(()=>{active--;activeKeys.delete(key);tasks.delete(key);pump();});
 }
}
export function activateGeneration(actor:GenerationActor,dataset:string,rpc:GenerationRPC) {
 if(typeof window!=='undefined')throw new Error('Generation worker is server only');
 const key=JSON.stringify([actor.workspace,actor.principal,dataset]);
 if(tasks.has(key)||tasks.size>=20)return;
 tasks.set(key,{principal:actor.principal,workspace:actor.workspace,dataset,run:async()=>{
  const claim=await rpc('claim',{datasetId:dataset,leaseOwner:randomUUID()}) as Claim|null;
  if(claim)await runCoreGeneration(claim,rpc);
 }});pump();
}
export async function runCoreGeneration(claim:Claim,rpc:GenerationRPC) {
 const lease={jobId:claim.jobId,epoch:claim.epoch,leaseOwner:claim.leaseOwner};let failed:unknown;let renewing=false;
 const checkpoint=async(values:Record<string,unknown>={})=>{
  if(failed)throw failed;
  try{return await rpc('checkpoint',{...lease,...values});}catch(error){failed=error;throw error;}
 };
 const heartbeat=setInterval(()=>{if(renewing)return;renewing=true;void checkpoint().catch(()=>{}).finally(()=>{renewing=false;});},10_000);
 heartbeat.unref?.();
 const compute=async<T>(steps:Generator<void,T>):Promise<T>=>{
  let checked=Date.now();
  for(;;){if(failed)throw failed;const next=steps.next();if(next.done)return next.value;await new Promise<void>(resolve=>setImmediate(resolve));if(Date.now()-checked>100){await checkpoint();checked=Date.now();}}
 };
 const stage=async(value:string,index:number)=>checkpoint({stage:value,stageIndex:index});
 try {
  const config=claim.config;if(!supportedProductionPolicy(config.policy))throw new Error('SOURCE_CORRUPT');
  await stage('read',0);
  const members:Member[]=[];let after:number|undefined=0;
  while(after!==undefined){const page=await rpc('source_members',{...lease,after,limit:100}) as {items:Member[];next:number|null};members.push(...page.items);after=page.next??undefined;}
  const pairs=new Map<string,Candidate>();const answers=new Map<string,string>();const inputs=new Map<string,{signature:Uint32Array;lexical?:LexicalFeatures}>();
  const locations=new Map<string,{member:Member;index:number}>();let answerBytes=0;
  const summary:GenerationSummary={version:1,sourceTraces:0,retainedTraces:0,candidateCount:0,duplicateCount:0,sampledOutCount:null,exclusions:[]};
  for(const member of members) {
   await checkpoint();summary.sourceTraces++;
   const result=await rpc('source',{...lease,traceId:member.id,expectedFingerprint:member.fingerprint}) as {source?:Source;revision?:string;reason?:string};
   const normalized=result.source?normalizeSourceUnits(result.source):{units:[],exclusions:[{code:result.reason||'SOURCE_UNAVAILABLE',turnCount:0}]};
   if(normalized.units.length)summary.retainedTraces++;
   const reasons=new Map<string,number>();for(const exclusion of normalized.exclusions)reasons.set(exclusion.code,(reasons.get(exclusion.code)||0)+exclusion.turnCount);
   for(const [code,turnCount] of reasons){let group=summary.exclusions.find(row=>row.code===code);if(!group){group={code,traceCount:0,turnCount:0};summary.exclusions.push(group);}group.traceCount++;group.turnCount+=turnCount;}
   for(let index=0;index<normalized.units.length;index++) {
    const unit=await processContent(normalized.units[index]);summary.candidateCount++;
    const key=hash([unit.input,unit.reference_output]);const inputKey=hash(unit.input);
    let features=inputs.get(inputKey);
    if(!features){features={signature:await compute(signatureSteps(unit.input,config.policy.seed)),lexical:config.policy.version!==LEGACY_POLICY.version?await compute(lexicalSteps(unit.input)):undefined};inputs.set(inputKey,features);}
    const location={key:hash([member.id,result.revision,index]),cells:unit.cells,knownDimensions:unit.knownDimensions};
    const previous=pairs.get(key);
    if(previous){summary.duplicateCount++;previous.paths.push(location);}else{pairs.set(key,{key,inputKey,task:unit.task,...features,paths:[location]});locations.set(key,{member,index});if(config.policy.version===PRODUCTION_POLICY.version){answerBytes+=Buffer.byteLength(unit.reference_output,'utf8');if(answerBytes>64*1024*1024)throw new Error('RESOURCE_UNAVAILABLE');answers.set(key,unit.reference_output);}}
   }
  }
  await stage('dedup',1);summary.exclusions.sort((a,b)=>a.code.localeCompare(b.code));await checkpoint({summary});
  await stage('stratify',2);await stage('sample',3);
  const selected=await compute(productionSampleSteps([...pairs.values()],answers,config.limit,config.policy));summary.sampledOutCount=pairs.size-selected.selected.length;
  await checkpoint({summary});await stage('convert',4);
  const selectedItems=[];let caseBytes=0;
  for(const item of selected.selected) {
   const location=locations.get(item.key)!;await checkpoint();
   const frozen=await rpc('source',{...lease,traceId:location.member.id,expectedFingerprint:location.member.fingerprint}) as {source?:Source};
   if(!frozen.source)throw new Error('SOURCE_CORRUPT');
   const unit=await processContent(normalizeSourceUnits(frozen.source).units[location.index]);
   if(!unit||hash([unit.input,unit.reference_output])!==item.key)throw new Error('SOURCE_CORRUPT');
   caseBytes+=Buffer.byteLength(unit.input,'utf8')+Buffer.byteLength(unit.reference_output,'utf8');
   if(caseBytes>32*1024*1024)throw new Error('RESOURCE_UNAVAILABLE');
   selectedItems.push({id:item.key,values:{input:unit.input,reference_output:unit.reference_output}});
  }
  const cases=normalizeTraceCases(selectedItems);
  if(!cases.length)throw new Error('NO_VALID_SAMPLES');
  await stage('save',5);if(failed)throw failed;
  await rpc('complete',{...lease,cases,summary});
 } catch(error) {
  const code=error instanceof Error&&['NO_VALID_SAMPLES','SOURCE_CORRUPT'].includes(error.message)?error.message:'RESOURCE_UNAVAILABLE';
  const message=code==='NO_VALID_SAMPLES'?'所选 Trace 中没有可完整配对的问答，请调整 Agent 或时间范围':code==='SOURCE_CORRUPT'?'冻结来源缺失或损坏，请重新生成':'读取或保存来源失败，请检查存储可用性后重新生成';
  // Revoked credentials and stale leases cannot write even a failure tail.
  try {await rpc('fail',{...lease,code,message});}catch{/* The next live progress request can resume an expired job. */}
 } finally {clearInterval(heartbeat);}
}
