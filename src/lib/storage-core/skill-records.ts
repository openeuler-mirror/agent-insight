import { readCoreAnalytics, type AnalyticsSource } from './analytics';
import { readTraceExecution } from './evidence';
import { buildRecordEvaluationSnapshots, readConfig, selectKeepIdsByTaskId, type ExecutionRecord, type InvokedSkill } from '../storage/data-service';
import {overlayCoreOutcome} from './trace-outcome-projection';

type Row=Record<string,unknown>;
function unavailable(message:string,status=503):never {throw Object.assign(new Error(message),{status});}
function parsed(value:unknown):unknown {
  if(typeof value==='string')return JSON.parse(value);
  return value;
}
function value(row:Row,camel:string,snake:string) {return Object.hasOwn(row,camel)?row[camel]:row[snake];}
export function coreSkillRecord(row:Row):ExecutionRecord {
  let invoked:InvokedSkill[]|null=null;
  const relations=value(row,'executionSkills','execution_skills');
  if(Array.isArray(relations)&&relations.length)invoked=relations.map(raw=>{
    const skill=raw as Row;return{name:skill.skillName??skill.name,version:skill.version??skill.skillVersion??null} as InvokedSkill;
  });
  const rawInvoked=value(row,'invokedSkills','invoked_skills');
  if(!invoked&&rawInvoked) {
    try {const decoded=parsed(rawInvoked);if(Array.isArray(decoded))invoked=decoded;}
    catch { /* Legacy invocation columns are optional; raw skills remain the fallback. */ }
  }
  const skills=invoked;
  const version=value(row,'skillVersion','skill_version')??null;
  const root=row.skill?{name:String(row.skill),version:typeof version==='number'?version:null}:null;
  return {
    ...row,upload_id:String(row.id),task_id:typeof row.taskId==='string'?row.taskId:undefined,
    query:typeof row.query==='string'?row.query||undefined:undefined,
    framework:typeof row.framework==='string'?row.framework||undefined:undefined,
    agent:typeof row.agentName==='string'?row.agentName||undefined:undefined,
    agentName:typeof row.agentName==='string'?row.agentName||undefined:undefined,
    timestamp:typeof row.timestamp==='string'?row.timestamp:undefined,
    latency:typeof row.latency==='number'?row.latency||undefined:undefined,
    final_result:typeof value(row,'finalResult','final_result')==='string'?String(value(row,'finalResult','final_result'))||undefined:undefined,
    skill:typeof row.skill==='string'?row.skill||undefined:undefined,
    skill_version:typeof version==='number'?version:null,
    rootSkill:root,root_skill:root,
    skills:skills?skills.map(skill=>skill.name):row.skills?parsed(row.skills) as string[]:undefined,
    invokedSkills:skills??undefined,invoked_skills:skills??undefined,
    answer_score:value(row,'answerScore','answer_score') as number|null|undefined,
    is_answer_correct:(value(row,'isAnswerCorrect','is_answer_correct')??null) as ExecutionRecord['is_answer_correct'],
    judgment_reason:typeof value(row,'judgmentReason','judgment_reason')==='string'?String(value(row,'judgmentReason','judgment_reason'))||undefined:undefined,
    failures:row.failures?parsed(row.failures) as ExecutionRecord['failures']:undefined,
    skill_issues:value(row,'skillIssues','skill_issues')?parsed(value(row,'skillIssues','skill_issues')) as ExecutionRecord['skill_issues']:[],
    label:typeof row.label==='string'?row.label:null,
    user:typeof row.user==='string'?row.user:null,
  };
}
export async function readCoreSkillRecords(request:Request,provided?:AnalyticsSource) {
  const source=provided ?? await readCoreAnalytics(request);
  const candidates=source.findMany({where:{isSubagent:false},orderBy:{timestamp:'desc'}});
  const {keepIds}=selectKeepIdsByTaskId(candidates);
  const rows=candidates.filter(row=>!row.taskId||keepIds.has(row.id));const records:ExecutionRecord[]=new Array(rows.length);
  const configs=rows.length?await readConfig(source.username):[];let next=0,totalBytes=0,stopped=false;
  await Promise.all(Array.from({length:Math.min(4,rows.length)},async()=>{
    for(;;) {
      if(stopped)return;
      const index=next++;const selected=rows[index];if(!selected)return;
      try {
      const {evidence}=await readTraceExecution(request,{executionId:selected.id});const row:Row={...evidence.execution};
      if(row.id!==selected.id||row.taskId!==selected.taskId||row.user!==selected.user)unavailable('Skill execution source identity changed',409);
      for(const [camel,snake] of [['query','query'],['framework','framework'],['agentName','agent_name'],['skill','skill'],['skillVersion','skill_version'],['invokedSkills','invoked_skills'],['executionSkills','execution_skills'],['failures','failures'],['isAnswerCorrect','is_answer_correct'],['skillIssues','skill_issues'],['latency','latency']]) {
        if(!Object.hasOwn(row,camel)&&!Object.hasOwn(row,snake)&&Object.hasOwn(selected,camel))row[camel]=(selected as unknown as Row)[camel];
      }
      totalBytes+=Buffer.byteLength(JSON.stringify(row),'utf8');
      if(totalBytes>128*1024*1024)unavailable('Skill execution records exceed byte budget',413);
      const current=source.currentOutcome?.(selected.id);
      const record=coreSkillRecord(row);
      const base=await buildRecordEvaluationSnapshots(current?.answer_reset?overlayCoreOutcome(record,current):record,configs,source.username);
      records[index]=current?overlayCoreOutcome(base,current):base;
      } catch(error) {stopped=true;throw error;}
    }
  }));
  await source.validate();
  return {username:source.username,records,validate:source.validate};
}
