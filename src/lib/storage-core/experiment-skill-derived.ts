import {createHash} from 'node:crypto';
import type {FrozenExperimentWork} from './experiment-worker';
type Row=Record<string,unknown>;
const object=(value:unknown):value is Row=>!!value&&typeof value==='object'&&!Array.isArray(value);
const text=(value:unknown)=>typeof value==='string'?value.trim():'';
const id=(prefix:string,value:unknown)=>prefix+createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,40);
export function experimentSkillSource(value:Row):'dynamic'|'trigger'|null{return value.preset==='trigger'?'trigger':value.preset==='use-case'||value.scope==='skill-case-analysis'?'dynamic':null;}
export function experimentSkillIssue(point:Row,source:string,evaluatorId:string,summary:unknown):Row|null{
 if(!['skillAttributable','isSkillAttributable','is_skill_attributable'].some(key=>point[key]===true))return null;
 const suggestedFix=text(point.suggestion)||text(point.improvementSuggestion)||text(point.improvement_suggestion);if(!suggestedFix)return null;
 const title=text(point.label)||text(summary)||evaluatorId;
 const explicit=text(point.severity).toLowerCase(),status=text(point.status).toLowerCase(),score=Number(point.score);
 const severity=['high','medium','low'].includes(explicit)?explicit:['missing','fail','failed'].includes(status)?'high':['partial','warn','warning'].includes(status)?'medium':Number.isFinite(score)&&score<50?'high':Number.isFinite(score)&&score<100?'medium':'low';
 const category=source==='trigger'?'触发评测':evaluatorId.includes('task-completion')?'任务完成度':evaluatorId.includes('trace-quality')?'轨迹偏差':evaluatorId.includes('result')?'结果问题':'用例评测';
 const normalize=(value:string)=>value.toLowerCase().replace(/\s+/g,' ').trim();
 const dedupKey=createHash('sha1').update([source,normalize(category),normalize(title),normalize(suggestedFix)].join('::')).digest('hex').slice(0,12);
 const evidence=typeof point.evidence==='string'?text(point.evidence)||null:object(point.evidence)?text(point.evidence.md)||JSON.stringify(point.evidence):null;
 return {source,dedupKey,severity,summary:title,evidence,reasoning:text(summary)||null,suggestedFix,ruleId:'experiment',dimension:evaluatorId,category};
}
export function attachExperimentSkillDerived(work:FrozenExperimentWork,result:Row):Row{
 const scope=(work.runplan.config as Row|undefined)?.experiment_skill_scope;
 if(!object(scope))return result;
 const source=experimentSkillSource(work.experiment_config);if(!source||scope.source!==source)return result;
 let points=result.points;if(points===undefined&&typeof result.pointsJson==='string')points=JSON.parse(result.pointsJson);
 if(!Array.isArray(points))return result;
 if(points.length>1000)throw Object.assign(new Error('Experiment Skill points exceed the derived object budget'),{status:413});
 let evidence=result.evidence;if(evidence===undefined&&typeof result.evidenceJson==='string')evidence=JSON.parse(result.evidenceJson);
 if(evidence!==undefined&&!object(evidence))throw Object.assign(new Error('Machine evidence must be an object'),{status:422});
 const json=object(evidence)&&object(evidence.json)?evidence.json:{};
 if('directTrajectoryDerived'in json)return result;
 const h=work.handle,evaluationId=id('experiment-evaluation-',[h.attempt_id,h.evaluator_id]);const byKey=new Map<string,Row>();
 for(const [pointIndex,point] of points.entries()){
  if(!object(point))continue;const normalized=experimentSkillIssue(point,source,h.evaluator_id,result.summary);if(!normalized)continue;
  byKey.set(String(normalized.dedupKey),{id:id('experiment-issue-',[h.attempt_id,h.evaluator_id,pointIndex]),evaluationId,skillId:scope.skill_id,version:scope.version,...normalized,pointIndex});
 }
 if(!byKey.size)return result;
 const evaluation={id:evaluationId,type:source,skillId:scope.skill_id,version:scope.version,executionId:work.frozen_trace_evidence?.execution?.id??null,generator:'experiment-skill-issues@1.0',runId:`experiment:${h.experiment_id}:${h.result_id}`,status:'ok'};
 const next={...evidence as Row,json:{...json,experimentSkillDerived:{version:1,points,evaluations:[evaluation],skillIssues:[...byKey.values()]}}};
 return {...result,...(typeof result.evidenceJson==='string'?{evidenceJson:JSON.stringify(next)}:{}),evidence:next};
}
