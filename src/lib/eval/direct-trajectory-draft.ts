import type {PrismaClient} from '@prisma/client';
import type {FrozenExperimentWork} from '@/lib/storage-core/experiment-worker';

type Row=Record<string,unknown>;
function unavailable(message:string,status=503):never{throw Object.assign(new Error(message),{status});}
export function createDirectTrajectoryDraft(work:FrozenExperimentWork,user:string,signal:AbortSignal){
 const source=work.frozen_trace_evidence;
 const request=work.raw_case.directTrajectory as Row|undefined;
 if(!source?.execution||!request||typeof request.id!=='string')unavailable('Frozen direct evaluation inputs required');
 let row:Row={trajectoryScore:null,dimensionScoresJson:null,deviationStepsJson:null,rootCauseStep:null,reasonText:null,errorMessage:null,executionId:null,taskId:null,...structuredClone(request),user,createdAt:new Date(String(request.createdAt||new Date().toISOString())),updatedAt:new Date()};
 const find=async(query:{where?:Row}={})=>{signal.throwIfAborted();return !query.where?.id||query.where.id===row.id?structuredClone(row):null;};
 const execution=structuredClone(source.execution);const session:Row|null=source.session?{...structuredClone(source.session),interactions:JSON.stringify(source.session.interactions)}:null;
 const readExecution=async(query:{where?:Row}={})=>{signal.throwIfAborted();return (!query.where?.id||query.where.id===execution.id)&&(!query.where?.taskId||query.where.taskId===execution.taskId)?structuredClone(execution):null;};
 const view={trajectoryEvalResult:{findUnique:find,update:async(query:{where:Row;data:Row})=>{signal.throwIfAborted();if(query.where.id!==row.id)unavailable('Direct evaluation draft identity differs',409);row={...row,...structuredClone(query.data),updatedAt:new Date()};return structuredClone(row);}},execution:{findUnique:readExecution,findFirst:readExecution},session:{findUnique:async(query:{where?:Row}={})=>{signal.throwIfAborted();return session&&(!query.where?.taskId||query.where.taskId===session.taskId)?structuredClone(session):null;}}} as unknown as PrismaClient;
 return {source:view,result(){
  signal.throwIfAborted();if(!['done','failed'].includes(String(row.status)))unavailable('Direct evaluation has not reached a terminal result');
  let raw:Row={};try{raw=JSON.parse(String(row.rawAnalysisJson||'{}'));}catch{unavailable('Direct evaluation analysis is invalid');}
  const fractions=[row.trajectoryScore,(raw.resultEvaluation as Row|undefined)?.score].filter((score):score is number=>typeof score==='number'&&Number.isFinite(score));
  const custom=raw.customEvaluationScore;
  if(fractions.some(score=>score<0||score>1)||typeof custom==='number'&&(!Number.isFinite(custom)||custom<0||custom>100))unavailable('Direct evaluation score scale is invalid');
  const scores=[...fractions.map(score=>score*100),...(typeof custom==='number'?[custom]:[])];
  return {score:scores.length?scores.reduce((sum,score)=>sum+score,0)/scores.length:null,status:row.status,errorMessage:row.errorMessage??null,summary:row.reasonText??null,evidence:{json:{directTrajectory:structuredClone(row)}}};
 }};
}
