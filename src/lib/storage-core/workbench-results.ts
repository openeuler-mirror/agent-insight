interface MachineReceipt {machineResultId:string;contentHash:string;runId:string;planHash:string;evaluationVersion:number}
interface Evaluation {id?:string;evaluatorId:string;status:string;score?:number|null;errorMessage?:string|null;coreResult?:MachineReceipt|null;[key:string]:unknown}
interface Case {id:string;taskId?:string|null;actualOutput?:string;caseValuesJson?:string|null;deletedAt?:string|null;traceAttempts?:Array<{id:string;status:string}>;results?:Evaluation[]}
export interface WorkbenchCoreSnapshot {id:string;status:string;evaluatorIdsJson?:string;cases:Case[];cancellations?:Array<{id?:string;caseKey:string}>;coreActiveCancellationIds?:string[];[key:string]:unknown}
export function activeCoreWorkbenchCancellations(experiment:Pick<WorkbenchCoreSnapshot,'cancellations'|'coreActiveCancellationIds'>){
 const ids=Array.isArray(experiment.coreActiveCancellationIds)?new Set(experiment.coreActiveCancellationIds):null;
 return (experiment.cancellations||[]).filter(row=>!ids||typeof row.id==='string'&&ids.has(row.id));
}
interface Run {experimentCaseId?:string;executionClaimId?:string;traceAttemptId?:string;status?:string;score?:number;tier?:string;sessionId?:string;output?:string;evaluations?:Array<{evaluatorId:string;status?:string;score?:number;unscored?:boolean;errorMessage?:string}>;failureType?:string;failureCode?:string;failureDetail?:string;coreProjection?:{version:1;results:MachineReceipt[]}}
interface Side extends Run {runs?:Run[];runCount?:number}
export type WorkbenchProjectedStates=Record<string,Partial<Record<'a'|'b',Side>>>;
const tier=(score:number)=>score>=80?'good':score>=50?'warn':'poor';
export function projectCoreWorkbenchTaskStates(experiment:WorkbenchCoreSnapshot,states:WorkbenchProjectedStates):WorkbenchProjectedStates{
 const result=structuredClone(states);const deleted=new Set(activeCoreWorkbenchCancellations(experiment).map(row=>row.caseKey));const expected:string[]=JSON.parse(experiment.evaluatorIdsJson||'[]');
 for(const [datasetCaseId,sides] of Object.entries(result)){
  if(deleted.has('dataset:'+datasetCaseId)){delete result[datasetCaseId];continue;}
  for(const side of ['a','b'] as const){
   const state=sides[side];if(!state)continue;
   if(state.runs&&state.runs.length===0){delete state.score;delete state.tier;delete state.evaluations;delete state.coreProjection;continue;}
   for(const run of state.runs?.length?state.runs:[state]){
    delete run.score;delete run.tier;delete run.evaluations;delete run.coreProjection;
    const row=experiment.cases.find(value=>value.id===run.experimentCaseId&&!value.deletedAt);
    const binding=row?JSON.parse(row.caseValuesJson||'{}').__agentInsightDatasetCase:null;
    const attempt=row?.traceAttempts?.[0];
    if(run.failureType&&!run.traceAttemptId&&(!row||!attempt||['failed','cancelled','superseded'].includes(attempt.status))){run.status=deleted.has('')||experiment.status==='cancelled'?'cancelled':'fail';continue;}
    if(!row||binding?.caseId!==datasetCaseId||run.executionClaimId&&!run.traceAttemptId||run.traceAttemptId&&attempt?.id!==run.traceAttemptId){run.status=deleted.has('')||experiment.status==='cancelled'?'cancelled':'pending';continue;}
    if(deleted.has('')||deleted.has(row.id)||experiment.status==='cancelled'){run.status='cancelled';continue;}
    const rows=expected.map(id=>row.results?.find(value=>value.evaluatorId===id)).filter((value):value is Evaluation=>!!value);
    if(attempt?.status==='ready'||row.taskId){delete run.failureType;delete run.failureCode;delete run.failureDetail;}
    const selected=rows.filter(value=>value.coreResult&&['done','failed'].includes(value.status));
    run.evaluations=rows.map(value=>({evaluatorId:value.evaluatorId,status:value.status,score:value.coreResult&&value.status==='done'&&typeof value.score==='number'?Math.round(value.score):undefined,unscored:!!value.coreResult&&value.status==='done'&&value.score==null,errorMessage:value.errorMessage||undefined}));
    run.coreProjection={version:1,results:selected.map(value=>value.coreResult!)};
    if(row.taskId){run.sessionId=row.taskId;run.output=row.actualOutput||'';}
    if(selected.length===expected.length&&expected.length){
     const scores=selected.filter(value=>value.status==='done'&&typeof value.score==='number'&&Number.isFinite(value.score)).map(value=>Math.round(value.score!));
     if(scores.length){run.score=Math.round(scores.reduce((sum,value)=>sum+value,0)/scores.length);run.tier=tier(run.score);}
     run.status=selected.some(value=>value.status==='failed')?'fail':'pass';
    }else if(attempt?.status==='ready'||row.taskId)run.status=rows.some(value=>['pending','running'].includes(value.status))?'evaluating':'executed';
    else if(attempt&&['failed','cancelled','superseded'].includes(attempt.status))run.status=attempt.status==='cancelled'?'cancelled':'fail';
    else run.status=attempt?'running':'pending';
   }
   if(state.runs?.length){
    const expectedRuns=state.runCount||state.runs.length;const runs=state.runs.slice(-expectedRuns);const scored=runs.filter(run=>typeof run.score==='number');delete state.score;delete state.tier;delete state.evaluations;
    if(scored.length){state.score=Math.round(scored.reduce((sum,run)=>sum+run.score!,0)/scored.length);state.tier=tier(state.score);}
    const finished=runs.filter(run=>run.status==='executed'||run.status==='pass').length;const failed=runs.filter(run=>run.status==='fail').length;
    state.status=runs.every(run=>run.status==='cancelled')?'cancelled':scored.length>=expectedRuns?'pass':failed>=expectedRuns?'fail':finished+failed>=expectedRuns?'executed':runs.some(run=>run.status==='evaluating')?'evaluating':runs.some(run=>run.status==='running'||run.status==='pending')||finished>0?'running':'pending';
   }
  }
 }
 return result;
}
