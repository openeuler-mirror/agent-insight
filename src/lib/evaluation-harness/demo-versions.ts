export const versionDimensions=['agent','skill','evaluator','dataset'] as const;
export type VersionDimension=typeof versionDimensions[number];
export type VersionChoices=Record<VersionDimension,{assetKey:string;id:string;vary:boolean}>;
export interface VersionRecord {key:string;runId:string;name:string;status:string;createdAt:string;group:string;score:number|null;assets:Record<VersionDimension,any>;evaluators:any[];manifest:any;condition:string;conditionLabel:string}
export interface VersionConfigurationField {label:string;value:string;details?:string}
interface VersionSeries {key:string;label:string;points:VersionRecord[];records:VersionRecord[];configuration:VersionConfigurationField[]}
function stable(value:any):string{return Array.isArray(value)?'['+value.map(stable).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}':JSON.stringify(value)??'null';}
export function expandVersionRuns(runs:any[]):VersionRecord[]{
 return runs.flatMap(run=>{
  const m=run.manifest;if(!m?.target||!m?.dataset||m.target.content.type==='skill')return [];
  return (m.comparison&&m.groups?.length?m.groups:[null]).map((group:any)=>{
   const evaluatorIds=group?.evaluatorIds||m.evaluatorIds||m.evaluators.map((e:any)=>e.id),evaluators=(m.evaluators||[]).filter((e:any)=>evaluatorIds.includes(e.id));
   const model=m.execution?.model||group?.target?.content.model||m.target.content.model||'Agent 默认';
   const allCaseIds=(group?.dataset||m.dataset).content.cases?.map((c:any)=>c.id).sort();
   const selectedCaseIds=(group?.caseIds??m.traceAssignments?.map((a:any)=>a.caseId)??m.caseIds??allCaseIds)?.slice().sort();
   const caseSelection=allCaseIds&&stable(allCaseIds)===stable(selectedCaseIds)?'all':selectedCaseIds??null;
   const condition=stable({execution:{endpoint:m.execution?.endpoint||group?.target?.content.endpoint||m.target.content.endpoint||'',model},modelRefs:(m.modelRefs||[]).filter((r:any)=>evaluatorIds.includes(r.evaluatorId)).map((r:any)=>r.connectionHash).sort(),threshold:m.threshold,concurrency:m.concurrency,timeoutSeconds:m.timeoutSeconds,retries:m.retries,caseIds:caseSelection,source:m.traceSource||'generate'});
   const score=group?(run.groupSummaries||[]).find((s:any)=>s.key===group.key)?.summary?.score:run.summary?.score;
   return {key:run.id+(group?'/'+group.key:''),runId:run.id,name:run.name,status:run.status,createdAt:run.createdAt,group:group?.key||'',score:run.status==='done'&&typeof score==='number'&&Number.isFinite(score)?score:null,
    assets:{agent:group?.target||m.target,skill:group?.skill||m.skill||null,evaluator:evaluators[0]||null,dataset:group?.dataset||m.dataset},evaluators,manifest:m,condition,conditionLabel:model};
  });
 });
}
function visibleEndpoint(value:string):string{try{const url=new URL(value);return url.origin+url.pathname;}catch{return '地址格式无法识别';}}
function configurationFields(series:VersionSeries,choices:VersionChoices,connections:Map<string,number>,endpoints:Map<string,string[]>):VersionConfigurationField[]{
 const row=series.points[0],settings=JSON.parse(row.condition);
 const recorded=(value:unknown,suffix='')=>typeof value==='number'?value+suffix:'未记录';
 let endpoint='未记录';
 if(settings.execution.endpoint){
  endpoint=visibleEndpoint(settings.execution.endpoint);
  const variants=endpoints.get(endpoint)||[];
  if(variants.length>1)endpoint+=`（地址配置 ${variants.indexOf(settings.execution.endpoint)+1}）`;
 }
 else if(row.assets.agent?.content.adapter==='demo')endpoint='Demo 服务（历史记录未保存地址）';
 const fields:VersionConfigurationField[]=[{label:'执行模型',value:settings.execution.model},{label:'执行地址',value:endpoint}];
 if(settings.caseIds==='all'){
  const counts=[...new Set(series.points.map(point=>point.assets.dataset?.content.cases?.length).filter((count):count is number=>typeof count==='number'))].sort((a,b)=>a-b);
  fields.push({label:'Case 范围',value:counts.length===1?`全部 Case（${counts[0]} 条）`:counts.length?`全部 Case（${counts.join(' / ')} 条，随评测集版本变化）`:'全部 Case'});
 }else if(Array.isArray(settings.caseIds)){
  const names=settings.caseIds.map((id:string)=>{
   const found=series.points.flatMap(point=>point.assets.dataset?.content.cases||[]).find(item=>item.id===id);
   return found?.name&&found.name!==id?`${found.name}（${id}）`:id;
  });
  fields.push({label:'Case 范围',value:`选定 ${names.length} 条 Case`,details:names.join('\n')});
 }else fields.push({label:'Case 范围',value:'未记录'});
 fields.push(
  {label:'并发数',value:recorded(settings.concurrency)},
  {label:'超时',value:recorded(settings.timeoutSeconds,' 秒')},
  {label:'失败重试',value:recorded(settings.retries,' 次')},
  {label:'通过门槛',value:typeof settings.threshold==='number'?`≥ ${settings.threshold}%`:'未记录'},
  {label:'执行方式',value:settings.source==='existing'?'使用已有 Trace 评分':'下发 Case，生成新 Trace'},
 );
 if(row.evaluators.length>1)fields.push({label:'附加评估器',value:row.evaluators.slice(1).map(e=>`${e.name} v${e.version}`).join('、')});
 const modelRefs=(row.manifest.modelRefs||[]).filter((ref:any)=>row.evaluators.some(e=>e.id===ref.evaluatorId));
 const hasModel=series.points.some(point=>point.evaluators.some(e=>e.content?.type==='llm')||(point.manifest.modelRefs||[]).some((ref:any)=>point.evaluators.some(e=>e.id===ref.evaluatorId)));
 if(hasModel){
  const models=modelRefs.map((ref:any)=>`${ref.model||'未记录模型'} · ${ref.keyType==='private'?'私有连接':ref.keyType==='platform'?'平台连接':'连接类型未记录'}${ref.connectionHash?` ${connections.get(ref.connectionHash)}`:'（连接标识未记录）'}`);
  fields.push({label:'评分模型',value:choices.evaluator.vary?'随评估器版本变化，具体配置见实验详情':models.join('；')||'未记录'});
 }
 return fields;
}
export function buildDemoVersionView(runs:any[],choices:VersionChoices){
 const rows=expandVersionRuns(runs).filter(row=>versionDimensions.every(kind=>{
  const choice=choices[kind],asset=row.assets[kind];
  return (!choice.assetKey||choice.assetKey===(asset?.assetKey||'__embedded__'))&&(choice.vary||!choice.id||choice.id===(asset?.id||'__embedded__'));
 })).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.key.localeCompare(b.key));
 const seriesMap=new Map<string,VersionSeries>();
 const connections=new Map<string,number>();
 const endpoints=new Map<string,string[]>();
 for(const row of [...rows].reverse()){
  for(const ref of row.manifest.modelRefs||[])if(ref.connectionHash&&!connections.has(ref.connectionHash))connections.set(ref.connectionHash,connections.size+1);
  const otherEvaluators=row.evaluators.slice(1).map(e=>e.id).sort();
  const settings=JSON.parse(row.condition);if(choices.evaluator.vary)delete settings.modelRefs;
  if(settings.execution.endpoint){
   const address=visibleEndpoint(settings.execution.endpoint),variants=endpoints.get(address)||[];
   if(!variants.includes(settings.execution.endpoint))variants.push(settings.execution.endpoint);
   endpoints.set(address,variants);
  }
  const condition=stable(settings)+stable(otherEvaluators);
  const series=seriesMap.get(condition)||{key:condition,label:row.conditionLabel,points:[],records:[],configuration:[]};
  series.records.push(row);
  seriesMap.set(condition,series);
  if(row.score===null)continue;
  const signature=(value:VersionRecord)=>versionDimensions.map(kind=>value.assets[kind]?.id||'__embedded__').join('/');
  const index=series.points.findIndex(p=>signature(p)===signature(row));
  if(index<0)series.points.push(row);else series.points[index]=row;
  seriesMap.set(condition,series);
 }
 const series=[...seriesMap.values()].filter(s=>s.points.length);
 for(const s of series){
  s.points.sort((a,b)=>{for(const kind of versionDimensions){const delta=(a.assets[kind]?.version||0)-(b.assets[kind]?.version||0);if(delta)return delta;}return a.createdAt.localeCompare(b.createdAt);});
  s.configuration=configurationFields(s,choices,connections,endpoints);
 }
 return {rows,series};
}
