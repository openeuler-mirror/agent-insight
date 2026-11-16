import type {ExecutionRecord,InvokedSkill,RoutingEvaluationSnapshot,OutcomeEvaluationSnapshot} from '@/lib/storage/data-service';

export interface CoreOutcomeRecordProjection {
 skills?:string[];invokedSkills?:InvokedSkill[];skill?:string;skill_version:number|null;
 is_skill_correct:boolean;skill_trigger_rate:number|null;
 routing_evaluation:RoutingEvaluationSnapshot;outcome_evaluation:OutcomeEvaluationSnapshot;
}
export type CoreQueryProjection=Pick<CoreOutcomeRecordProjection,'is_skill_correct'|'skill_trigger_rate'|'routing_evaluation'|'outcome_evaluation'>;
export interface CoreOutcomeValue {
 version:1;source_snapshot_hash:string;answer_score:number|null;is_answer_correct:boolean;
 judgment_reason:string;failures:unknown[];skill_issues:unknown[]|null;record_projection?:CoreOutcomeRecordProjection;
}
export interface CoreOutcomeLookup {
 outcome:{value:CoreOutcomeValue;experiment_id:string;run_id:string;machine_result_id:string;content_hash:string;generation:number;
  source?:{trace_id:string;incarnation:string;route_epoch:string;execution_id:string;snapshot_hash:string;plan_hash:string}}|null;
 answer_reset?:{version:1;through_generation:number;annotation_revision:string;content_hash:string;query_projection?:CoreQueryProjection};
 is_evaluating:boolean;run_id:string|null;experiment_id:string;selection_hash:string;
}
export function overlayCoreOutcome(record:ExecutionRecord,selected:CoreOutcomeLookup):ExecutionRecord {
 const value=selected.outcome?.value,projection=value?.record_projection,reset=selected.answer_reset;
 const metadata:Partial<CoreOutcomeRecordProjection>={...projection};
 if(reset){delete metadata.routing_evaluation;delete metadata.outcome_evaluation;}
 const root=projection?.skill?{name:projection.skill,version:projection.skill_version}:null;
 return {...record,...(projection?{...metadata,...(projection.invokedSkills!==undefined?{invoked_skills:projection.invokedSkills}:{}),rootSkill:root,root_skill:root}:{}),
  ...(value?{answer_score:value.answer_score,is_answer_correct:value.is_answer_correct,judgment_reason:value.judgment_reason,
   failures:value.failures as ExecutionRecord['failures'],skill_issues:value.skill_issues as ExecutionRecord['skill_issues']}:{}),
  ...(reset?.query_projection?reset.query_projection:{}),
  ...(reset?{answer_score:null,is_answer_correct:false,judgment_reason:'结果评估中...',...(!reset.query_projection&&record.outcome_evaluation?{outcome_evaluation:{...record.outcome_evaluation,status:record.outcome_evaluation.status==='missing'?'missing':'pending',score:null,is_correct:null,reason:'结果评估中...',skill_breakdown:record.outcome_evaluation.skill_breakdown.map(item=>({...item,score:null,is_correct:null}))}}:{})}:{}),
  is_evaluating:selected.is_evaluating};
}
