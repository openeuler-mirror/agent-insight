import matter from 'gray-matter';
import {buildTriggerOptPoint,TRIGGER_OPT_GENERATOR} from '@/lib/engine/evaluation/derive-trigger-opt-points';
import type {FrozenExperimentWork} from './experiment-worker';
import type {FrozenTriggerManifest} from './trigger';
import type {TriggerRunResultItem} from '@/server/skill_trigger_eval_storage';

export function buildCoreTriggerDerived(work:FrozenExperimentWork,manifest:FrozenTriggerManifest,report:{items:TriggerRunResultItem[];passRate:number;truePositiveRate:number;falsePositiveRate:number}){
 const history=manifest.history.map(row=>{let description='';try{const raw=matter(String(row.content||'')).data?.description;if(typeof raw==='string')description=raw.trim();}catch{}return {version:Number(row.version),description,passRate:Number(row.passRate)};});
 const fields=buildTriggerOptPoint({user:manifest.legacy_owner,skillName:manifest.skill.name,skillVersion:manifest.skill.version,triggerRunId:work.handle.experiment_id,skillVersionContent:manifest.skill.content,results:report.items,passRate:report.passRate,truePositiveRate:report.truePositiveRate,falsePositiveRate:report.falsePositiveRate,runsPerQuery:manifest.params.runsPerQuery,triggerThreshold:manifest.params.triggerThreshold},history);
 if(!fields)return {version:1,evaluations:[],skillIssues:[]};
 const identity={skillId:manifest.skill.id,version:manifest.skill.version,user:manifest.legacy_owner};
 const evaluation={id:'trigger-evaluation-'+work.handle.experiment_id,type:'trigger',...identity,executionId:null,generator:TRIGGER_OPT_GENERATOR,runId:work.handle.experiment_id,status:'ok'};
 const issue={id:'trigger-issue-'+work.handle.experiment_id,evaluationId:evaluation.id,...identity,...fields};
 return {version:1,evaluations:[evaluation],skillIssues:[issue]};
}
