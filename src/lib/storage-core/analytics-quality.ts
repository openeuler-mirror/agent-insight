import type { AnalyticsSource } from './analytics';
import { projectQualityRows, toTrajectoryLite } from '../engine/quality-monitoring/trace-collector';
import type { QualityReportSource } from '../engine/quality-monitoring';
import type { QualityReportInput, DiagnosisLite, TrajectoryLite } from '../engine/quality-monitoring/types';
import type { SkillIssueRowLite } from '../engine/quality-monitoring/problem-summary';
import { MAX_TRACES } from '../engine/quality-monitoring/config';
import { prisma } from '../storage/prisma';

type Row=Record<string,unknown>;
function fail():never{throw Object.assign(new Error('Quality enrichment coverage unavailable'),{status:503});}
export async function coreQualitySource(source:AnalyticsSource,input:QualityReportInput):Promise<QualityReportSource> {
  const selected=source.findMany({where:{agentName:input.agent,isSubagent:false,timestamp:{gte:input.from,lte:input.to},...(input.filters?.skill?{skill:input.filters.skill}:{})},orderBy:{timestamp:'desc'},take:MAX_TRACES+1});
  const truncated=selected.length>MAX_TRACES;const rows=selected.slice(0,MAX_TRACES);
  const ids=new Set(rows.map(row=>row.id));
  const traceIds=source.items.filter(item=>item.projection.executions.some(row=>ids.has(row.id))).map(item=>item.trace_id);
  const trajectories=new Map<string,TrajectoryLite>();const diagnosesByTrace=new Map<string,DiagnosisLite>();const skillIssueRows:SkillIssueRowLite[]=[];
  for(let offset=0;offset<traceIds.length;offset+=200) {
    const value=await source.enrich(traceIds.slice(offset,offset+200));
    if(!Array.isArray(value.trajectories)||!Array.isArray(value.issues)||!Array.isArray(value.diagnoses))fail();
    for(const raw of value.trajectories as Row[]) {
      if(typeof raw.executionId!=='string'||!ids.has(raw.executionId))continue;
      if(trajectories.has(raw.executionId))continue;
      const lite=toTrajectoryLite({trajectoryScore:typeof raw.trajectoryScore==='number'?raw.trajectoryScore:null,dimensionScoresJson:typeof raw.dimensionScoresJson==='string'?raw.dimensionScoresJson:null});
      if(lite)trajectories.set(raw.executionId,lite);
    }
    const issues=value.issues as (Omit<SkillIssueRowLite,'skillName'>&{skillName?:string|null;skillId?:string})[];
    const unnamed=[...new Set(issues.filter(row=>!row.skillName&&row.skillId).map(row=>row.skillId!))];
    const names=new Map<string,string>();
    if(unnamed.length) {
      const skills=await prisma.skill.findMany({where:{id:{in:unnamed},OR:[{user:source.username},{user:null}]},select:{id:true,name:true}});
      for(const skill of skills)names.set(skill.id,skill.name);
    }
    for(const raw of issues) {
      const skillName=raw.skillName||names.get(raw.skillId||'');
      if(raw.executionId&&ids.has(raw.executionId)&&skillName)skillIssueRows.push({...raw,skillName});
    }
    for(const raw of value.diagnoses as Row[]) {
      if(typeof raw.executionId!=='string'||!ids.has(raw.executionId))continue;
      const report=raw.report as {rootCause?:Row;triage?:{fatalDiagnosis?:Row;category?:string}}|null;
      const rc=report?.rootCause;const fatal=report?.triage?.fatalDiagnosis;
      if(!rc&&!fatal)continue;
      diagnosesByTrace.set(raw.executionId,{module:String(rc?.criticalModule??'system'),category:report?.triage?.category,errorType:(rc?.criticalErrorType??fatal?.errorType) as string|undefined,summary:(rc?.summary??fatal?.summary) as string|undefined,guidance:(rc?.correctionGuidance??fatal?.recommendation) as string|undefined,confidence:typeof rc?.confidence==='number'?rc.confidence:undefined});
    }
  }
  await source.validate();
  return {collection:{traces:projectQualityRows(rows,trajectories),truncated},structuredErrors:source.items.flatMap(item=>item.projection.errors),skillIssueRows,diagnosesByTrace};
}
