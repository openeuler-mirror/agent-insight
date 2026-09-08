export const versionDimensions=['agent','skill','evaluator','dataset'] as const;
export type VersionDimension=typeof versionDimensions[number];
export type VersionChoices=Record<VersionDimension,{assetKey:string;id:string;vary:boolean}>;
export interface VersionRecord {key:string;runId:string;name:string;status:string;createdAt:string;group:string;score:number|null;assets:Record<VersionDimension,any>;evaluators:any[];manifest:any;condition:string;conditionLabel:string}
function stable(value:any):string{return Array.isArray(value)?'['+value.map(stable).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}':JSON.stringify(value)??'null';}
export function expandVersionRuns(runs:any[]):VersionRecord[]{
 return runs.flatMap(run=>{
  const m=run.manifest;if(!m?.target||!m?.dataset)return [];
  return (m.comparison&&m.groups?.length?m.groups:[null]).map((group:any)=>{
   const evaluatorIds=group?.evaluatorIds||m.evaluatorIds||m.evaluators.map((e:any)=>e.id),evaluators=(m.evaluators||[]).filter((e:any)=>evaluatorIds.includes(e.id));
   const model=m.execution?.model||group?.target?.content.model||m.target.content.model||'Agent 默认';
   const selectedCaseIds=(group?.caseIds||m.caseIds||[]).slice().sort(),allCaseIds=(group?.dataset||m.dataset).content.cases?.map((c:any)=>c.id).sort();
   const caseSelection=allCaseIds&&stable(allCaseIds)===stable(selectedCaseIds)?'all':selectedCaseIds;
   const condition=stable({execution:{endpoint:m.execution?.endpoint||group?.target?.content.endpoint||m.target.content.endpoint||'',model},modelRefs:(m.modelRefs||[]).filter((r:any)=>evaluatorIds.includes(r.evaluatorId)).map((r:any)=>r.connectionHash).sort(),threshold:m.threshold,concurrency:m.concurrency,timeoutSeconds:m.timeoutSeconds,retries:m.retries,caseIds:caseSelection,source:m.traceSource||'generate'});
   const score=group?(run.groupSummaries||[]).find((s:any)=>s.key===group.key)?.summary?.score:run.summary?.score;
   return {key:run.id+(group?'/'+group.key:''),runId:run.id,name:run.name,status:run.status,createdAt:run.createdAt,group:group?.key||'',score:run.status==='done'&&typeof score==='number'&&Number.isFinite(score)?score:null,
    assets:{agent:group?.target||m.target,skill:group?.skill||m.skill||null,evaluator:evaluators[0]||null,dataset:group?.dataset||m.dataset},evaluators,manifest:m,condition,conditionLabel:model};
  });
 });
}
export function buildDemoVersionView(runs:any[],choices:VersionChoices){
 const rows=expandVersionRuns(runs).filter(row=>versionDimensions.every(kind=>{
  const choice=choices[kind],asset=row.assets[kind];
  return (!choice.assetKey||choice.assetKey===(asset?.assetKey||'__embedded__'))&&(choice.vary||!choice.id||choice.id===(asset?.id||'__embedded__'));
 })).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.key.localeCompare(b.key));
 const seriesMap=new Map<string,{key:string;label:string;points:VersionRecord[]}>();
 for(const row of [...rows].reverse()){
  if(row.score===null)continue;
  const otherEvaluators=row.evaluators.slice(1).map(e=>e.id).sort();
  const settings=JSON.parse(row.condition);if(choices.evaluator.vary)delete settings.modelRefs;
  const condition=stable(settings)+stable(otherEvaluators);
  const series=seriesMap.get(condition)||{key:condition,label:row.conditionLabel,points:[]};
  const signature=(value:VersionRecord)=>versionDimensions.map(kind=>value.assets[kind]?.id||'__embedded__').join('/');
  const index=series.points.findIndex(p=>signature(p)===signature(row));
  if(index<0)series.points.push(row);else series.points[index]=row;
  seriesMap.set(condition,series);
 }
 const series=[...seriesMap.values()];
 for(const s of series)s.points.sort((a,b)=>{for(const kind of versionDimensions){const delta=(a.assets[kind]?.version||0)-(b.assets[kind]?.version||0);if(delta)return delta;}return a.createdAt.localeCompare(b.createdAt);});
 return {rows,series};
}
