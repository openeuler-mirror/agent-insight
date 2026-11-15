import {createHash} from 'node:crypto';
import {requireCoreExperimentContext} from './experiments';

type Row=Record<string,unknown>;
export interface CoreDerivedIssue extends Row {
 id:string;source:string;ruleId:string|null;skillId:string;version:number;resolvedAt:string|null;resolvedRunId:string|null;
 Evaluation:{id:string;runId:string;executionId:string|null;type?:string;ranAt?:string};
}
function fail(message:string,status:number):never{throw Object.assign(new Error(message),{status});}
function privateRow(value:unknown):Row {
 if(!value||typeof value!=='object'||Array.isArray(value))fail('Derived Issue response is unavailable',503);
 const row=value as Row;if(row.gold_redacted===true)fail('Private derived Issue ownership required',403);return row;
}
export async function readCoreDerivedIssues(input:{user:string;skillId:string;version?:number;ids?:string[]}):Promise<CoreDerivedIssue[]>{
 const context=requireCoreExperimentContext();if(context.actor.username!==input.user)fail('Derived Issue actor differs',403);
 const rows:Row[]=[];
 if(input.ids){
  if(input.ids.length>2000)fail('Derived Issue identity budget exceeded',413);
  for(const id of [...new Set(input.ids)].sort())rows.push(privateRow(await context.rpc('derived_lookup',{kind:'issue',id})));
 }else{
  let after='';
  for(;;){
   const page=await context.rpc('derived_list',{kind:'issue',skill_id:input.skillId,owned_only:true,after_id:after,limit:200}) as unknown;
   if(!Array.isArray(page))fail('Derived Issue list is unavailable',503);
   rows.push(...page.map(privateRow));if(rows.length>10000)fail('Derived Issue scan budget exceeded',413);
   if(page.length<200)break;
   const next=page.at(-1)?.id;if(typeof next!=='string'||next<=after)fail('Derived Issue cursor did not advance',503);after=next;
  }
 }
 const evaluations=new Map<string,CoreDerivedIssue['Evaluation']>();const result:CoreDerivedIssue[]=[];
 for(const row of rows){
  if(row.skillId!==input.skillId||input.version!==undefined&&row.version!==input.version){if(input.ids)fail('Derived Issue belongs to another Skill version',409);continue;}
  if(typeof row.id!=='string'||typeof row.source!=='string'||typeof row.evaluationId!=='string'||!Number.isSafeInteger(row.version))fail('Derived Issue contract is incomplete',503);
  let evaluation=evaluations.get(row.evaluationId);
  if(!evaluation){
   const source=privateRow(await context.rpc('derived_lookup',{kind:'evaluation',id:row.evaluationId}));
   if(source.id!==row.evaluationId||typeof source.runId!=='string'||source.executionId!==null&&typeof source.executionId!=='string')fail('Derived Evaluation source is unavailable',503);
   evaluation={id:source.id,runId:source.runId,executionId:source.executionId as string|null,...(typeof source.type==='string'?{type:source.type}:{}),...(typeof source.ranAt==='string'?{ranAt:source.ranAt}:{})};evaluations.set(row.evaluationId,evaluation);
  }
  result.push({...row,id:row.id,skillId:input.skillId,version:row.version as number,source:row.source,ruleId:typeof row.ruleId==='string'?row.ruleId:null,resolvedAt:typeof row.resolvedAt==='string'?row.resolvedAt:null,resolvedRunId:typeof row.resolvedRunId==='string'?row.resolvedRunId:null,Evaluation:evaluation});
 }
 return result;
}

export async function resolveCoreDerivedIssues(input:{user:string;ids:string[];resolvedRunId:string;operationKey?:string}):Promise<{resolved_ids:string[];newly_resolved:number;resolved_run_id:string}>{
 const context=requireCoreExperimentContext();if(context.actor.username!==input.user)fail('Derived Issue actor differs',403);
 const ids=[...new Set(input.ids)].sort();if(!ids.length)return {resolved_ids:[],newly_resolved:0,resolved_run_id:input.resolvedRunId};if(ids.length>2000)fail('Derived Issue identity budget exceeded',413);
 const request={issue_ids:ids,resolved_run_id:input.resolvedRunId};
 const key=input.operationKey||'issue-resolution:'+createHash('sha256').update(JSON.stringify(request)).digest('hex');
 const value=await context.rpc('derived_issue_resolve',{...request,operation_key:key,operation_request:request}) as {resolved_ids:string[];newly_resolved:number;resolved_run_id:string};
 if(!value||JSON.stringify(value.resolved_ids)!==JSON.stringify(ids)||value.resolved_run_id!==input.resolvedRunId||!Number.isSafeInteger(value.newly_resolved)||value.newly_resolved<0||value.newly_resolved>ids.length)fail('Derived Issue resolution receipt is incomplete',503);
 return value;
}
