import type {PrismaClient} from '@prisma/client';
type Row=Record<string,unknown>;
type Query={where?:Row;select?:Row;include?:Row;orderBy?:Row|Row[];skip?:number;take?:number;distinct?:string|string[]};
export interface CoreBusinessTraceReadiness {executionId:string;taskId:string;hasInteractions:boolean;hasBusinessResponse:boolean;hasEndTime:boolean;executionAgent:string|null}
type CoreExperimentProjection={readonly ownerRedacted:boolean;readonly traceReadiness:Readonly<Record<string,CoreBusinessTraceReadiness>>};
const projectionKey=Symbol.for('agent-insight.storage-core.experiment-projections.v1');
const projectionGlobal=globalThis as typeof globalThis & {[projectionKey]?:WeakMap<object,CoreExperimentProjection>};
const coreProjections=projectionGlobal[projectionKey]??=new WeakMap<object,CoreExperimentProjection>();
export function coreExperimentProjection(row:object):CoreExperimentProjection|undefined{return coreProjections.get(row);}
export interface ExperimentViewSnapshot {coverage:string;experiment:Row;executions?:Row[];sessions?:Row[];cancellations?:Row[];local_executions?:Row[];benchmark_runs?:Row[];commands?:Row[];fi_runs?:Row[];grayscale_tasks?:Row[];gold_redacted?:boolean;business_trace_readiness?:Record<string,CoreBusinessTraceReadiness>}
function unavailable(message:string):never{throw Object.assign(new Error(message),{status:503});}
function record(value:unknown):value is Row{return !!value&&typeof value==='object'&&!Array.isArray(value)&&!(value instanceof Date);}
function array(value:unknown):Row[]{if(!Array.isArray(value))return [];if(value.some(row=>!record(row)))unavailable('Invalid Experiment view rows');return value as Row[];}
function atom(value:unknown):unknown{return value instanceof Date?value.valueOf():value;}
function matchValue(value:unknown,condition:unknown):boolean{
 if(!record(condition))return atom(value)===atom(condition);
 for(const [operator,wanted] of Object.entries(condition)){
  const actual=atom(value);const expected=atom(wanted);
  switch(operator){
   case 'equals':if(!matchValue(value,wanted))return false;break;
   case 'in':case 'notIn':{if(!Array.isArray(wanted))unavailable('Invalid Experiment view filter');const included=wanted.some(item=>matchValue(value,item));if(included===(operator==='notIn'))return false;break;}
   case 'not':if(matchValue(value,wanted))return false;break;
   case 'gt':case 'gte':case 'lt':case 'lte':{if(actual===null||actual===undefined||expected===null||expected===undefined)return false;const a=actual as number|string;const b=expected as number|string;if(operator==='gt'&&!(a>b)||operator==='gte'&&!(a>=b)||operator==='lt'&&!(a<b)||operator==='lte'&&!(a<=b))return false;break;}
   case 'contains':case 'startsWith':case 'endsWith':{if(typeof value!=='string'||typeof wanted!=='string')return false;const text=condition.mode==='insensitive'?value.toLowerCase():value;const part=condition.mode==='insensitive'?wanted.toLowerCase():wanted;if(!(operator==='contains'?text.includes(part):operator==='startsWith'?text.startsWith(part):text.endsWith(part)))return false;break;}
   case 'mode':if(wanted!=='insensitive'&&wanted!=='default')unavailable('Unsupported Experiment view text mode');break;
   case 'is':if(!record(value)||!record(wanted)||!matches(value,wanted))return false;break;
   case 'isNot':if(record(value)&&record(wanted)&&matches(value,wanted))return false;break;
   case 'some':case 'none':case 'every':{if(!Array.isArray(value)||!record(wanted))return false;const all=value.map(row=>record(row)&&matches(row,wanted));if(operator==='some'&&!all.some(Boolean)||operator==='none'&&all.some(Boolean)||operator==='every'&&!all.every(Boolean))return false;break;}
   default:if(!record(value))return false;if(!matches(value,condition))return false;return true;
  }
 }
 return true;
}
function matches(row:Row,where:Row={}):boolean{
 for(const [key,condition] of Object.entries(where)){
  if(['AND','OR','NOT'].includes(key)){
   const parts=Array.isArray(condition)?condition:[condition];if(parts.some(part=>!record(part)))unavailable('Invalid Experiment view boolean filter');const results=(parts as Row[]).map(part=>matches(row,part));
   if(key==='AND'&&!results.every(Boolean)||key==='OR'&&!results.some(Boolean)||key==='NOT'&&results.some(Boolean))return false;
  }else{if(!(key in row))unavailable('Unsupported Experiment view field: '+key);if(!matchValue(row[key],condition))return false;}
 }
 return true;
}
function rowsFor(rows:Row[],query:Query={}):Row[]{
 const allowed=['where','select','include','orderBy','skip','take','distinct'];if(Object.keys(query).some(key=>!allowed.includes(key)))unavailable('Unsupported Experiment view query');
 let result=rows.filter(row=>matches(row,query.where));
 const orders=query.orderBy?(Array.isArray(query.orderBy)?query.orderBy:[query.orderBy]):[];
 if(orders.length)result=[...result].sort((left,right)=>{for(const order of orders)for(const [key,direction] of Object.entries(order)){if(!(key in left)||!(key in right)||!['asc','desc'].includes(String(direction)))unavailable('Unsupported Experiment view ordering');const a=atom(left[key]) as number|string|null;const b=atom(right[key]) as number|string|null;const value=a===b?0:a==null?-1:b==null?1:a<b?-1:1;if(value)return direction==='desc'?-value:value;}return 0;});
 if(query.distinct){const keys=Array.isArray(query.distinct)?query.distinct:[query.distinct];const seen=new Set<string>();result=result.filter(row=>{const value=JSON.stringify(keys.map(key=>row[key]));if(seen.has(value))return false;seen.add(value);return true;});}
 for(const key of ['skip','take'] as const)if(query[key]!==undefined&&(!Number.isSafeInteger(query[key])||query[key]!<0))unavailable('Invalid Experiment view pagination');
 return result.slice(query.skip||0,query.take===undefined?undefined:(query.skip||0)+query.take);
}
function project(row:Row,query:Query={}):Row{
 const out:Row=query.select?{}:{...row};const selection=query.select||query.include||{};
 for(const [key,choice] of Object.entries(selection)){
  if(!choice)continue;
  if(key==='_count'){
   const counts:Row={};const fields=choice===true?Object.fromEntries(Object.keys(row).filter(name=>Array.isArray(row[name])).map(name=>[name,true])):record(choice)&&record(choice.select)?choice.select:{};
   for(const [name,filter] of Object.entries(fields)){if(!Array.isArray(row[name]))unavailable('Unsupported Experiment relation count');counts[name]=rowsFor(array(row[name]),record(filter)?filter as Query:{}).length;}
   out._count=counts;continue;
  }
  if(!(key in row))unavailable('Unsupported Experiment projection field: '+key);
  if(choice===true)out[key]=row[key];
  else if(record(choice))out[key]=Array.isArray(row[key])?rowsFor(array(row[key]),choice as Query).map(item=>project(item,choice as Query)):record(row[key])?project(row[key] as Row,choice as Query):row[key];
  else unavailable('Invalid Experiment view projection');
 }
 const metadata=coreProjections.get(row);if(metadata)coreProjections.set(out,metadata);
 return out;
}
function hydrated(value:Row):Row{
 const row={...value};for(const key of ['createdAt','updatedAt','deletedAt','watchEnabledAt','humanAt','startedAt','completedAt','finishedAt','lastProgressAt'])if(typeof row[key]==='string'){const date=new Date(row[key] as string);if(!Number.isFinite(date.valueOf()))unavailable('Invalid Experiment view timestamp');row[key]=date;}
 return row;
}
function relation(row:Row,key:string,value:unknown){Object.defineProperty(row,key,{value,enumerable:false});}
export function createExperimentReadView(snapshots:ExperimentViewSnapshot[],options:{actorUsername?:string}={}):PrismaClient{
 if(snapshots.some(snapshot=>snapshot.coverage!=='complete'))unavailable('Complete Experiment snapshot coverage required');
 const tables:Record<string,Row[]>={experiment:[],experimentCase:[],experimentEvalResult:[],experimentGroup:[],experimentEvalComment:[],experimentTraceAttempt:[],experimentCancellation:[],experimentLocalExecution:[],execution:[],session:[],benchmarkCaseRun:[],reliabilityCommand:[],faultInjectionRun:[],grayscaleTask:[]};
 for(const snapshot of snapshots){
  const experiment=hydrated(snapshot.experiment);if('coreActiveCancellationIds'in experiment){const ids=experiment.coreActiveCancellationIds;delete experiment.coreActiveCancellationIds;Object.defineProperty(experiment,'coreActiveCancellationIds',{value:ids,enumerable:false});}const cases=array(experiment.cases).map(hydrated);const groups=array(experiment.groups).map(hydrated);const comments=array(experiment.comments).map(hydrated);tables.experiment.push(experiment);relation(experiment,'cases',cases);relation(experiment,'groups',groups);relation(experiment,'comments',comments);if(!('benchmarkBinding'in experiment))experiment.benchmarkBinding=null;
  coreProjections.set(experiment,Object.freeze({ownerRedacted:snapshot.gold_redacted===true,traceReadiness:Object.freeze(Object.fromEntries(Object.entries(snapshot.business_trace_readiness||{}).map(([id,value])=>[id,Object.freeze({...value})])))}));
  for(const item of cases){
   if('coreExecution' in item){const execution=item.coreExecution;delete item.coreExecution;Object.defineProperty(item,'coreExecution',{value:execution,enumerable:false});}
   if(record(item.executionSnapshot)&&Array.isArray(item.executionSnapshot.results))for(const result of array(item.executionSnapshot.results))delete result.coreWork;
   const results=array(item.results).map(value=>{const row=hydrated(value);for(const field of ['coreResult','coreWork'])if(field in row){const provenance=row[field];delete row[field];Object.defineProperty(row,field,{value:provenance,enumerable:false});}return row;});const attempts=array(item.traceAttempts).map(hydrated);tables.experimentCase.push(item);tables.experimentEvalResult.push(...results);tables.experimentTraceAttempt.push(...attempts);relation(item,'experiment',experiment);relation(item,'results',results);relation(item,'traceAttempts',attempts);relation(item,'group',groups.find(group=>group.id===item.groupId)||null);
   for(const result of results)relation(result,'case',item);
  }
  for(const comment of comments)relation(comment,'experiment',experiment);
  tables.experimentGroup.push(...groups);tables.experimentEvalComment.push(...comments);
  for(const [model,key] of Object.entries({execution:'executions',session:'sessions',experimentCancellation:'cancellations',experimentLocalExecution:'local_executions',benchmarkCaseRun:'benchmark_runs',reliabilityCommand:'commands',faultInjectionRun:'fi_runs',grayscaleTask:'grayscale_tasks'}))tables[model].push(...array(snapshot[key as keyof ExperimentViewSnapshot]).map(value=>{
   const row=hydrated(value);
   if(model==='execution'&&row.isSubagent==null)row.isSubagent=false;
   if(model==='benchmarkCaseRun'&&Array.isArray(row.evaluations))row.evaluations=array(row.evaluations).map(hydrated);
   for(const field of model==='session'?['startTime','endTime']:model==='execution'?['timestamp']:[])if(typeof row[field]==='string'){const date=new Date(row[field] as string);if(!Number.isFinite(date.valueOf()))unavailable('Invalid Experiment source timestamp');row[field]=date;}
   if(model==='session'){
    for(const field of ['label','query','endTime','model','interactions','langfuseTraceNodes'])if(!(field in row))row[field]=null;
    for(const field of ['interactions','langfuseTraceNodes'])if(Array.isArray(row[field]))row[field]=JSON.stringify(row[field]);
   }
   return row;
  }));
 }
 const coverage:Record<string,boolean>={};for(const [model,key] of Object.entries({execution:'executions',session:'sessions',experimentCancellation:'cancellations',experimentLocalExecution:'local_executions',benchmarkCaseRun:'benchmark_runs',reliabilityCommand:'commands',faultInjectionRun:'fi_runs',grayscaleTask:'grayscale_tasks'}))coverage[model]=snapshots.every(snapshot=>Array.isArray(snapshot[key as keyof ExperimentViewSnapshot]));
 const scopedWhere=(where:unknown):unknown=>{
  if(Array.isArray(where))return where.map(scopedWhere);if(!record(where))return where;
  return Object.fromEntries(Object.entries(where).filter(([key,value])=>!(key==='user'&&value===options.actorUsername&&options.actorUsername!==undefined)).map(([key,value])=>[key,scopedWhere(value)]));
 };
 const sources=new Map<string,unknown>();
 return new Proxy({},{get:(_target,model)=>{
  if(typeof model!=='string'||model==='then')return undefined;
  if(model.startsWith('$'))unavailable('Experiment view is read-only; transactions and raw queries are unsupported');
  if(!(model in tables)||coverage[model]===false)unavailable('Unsupported or incomplete Experiment view source: '+model);
  if(!sources.has(model))sources.set(model,new Proxy({},{get:(_table,method)=>{
   if(!['findMany','findFirst','findUnique','findFirstOrThrow','findUniqueOrThrow','count'].includes(String(method)))unavailable('Experiment view is read-only; mutation is unsupported');
   return async(query:Query={})=>{const rows=rowsFor(tables[model],{...query,where:scopedWhere(query.where) as Row|undefined});if(method==='count')return rows.length;if(method==='findMany')return rows.map(row=>project(row,query));if(!rows.length&&String(method).endsWith('OrThrow'))throw Object.assign(new Error('Experiment view row not found'),{status:404});return rows[0]?project(rows[0],query):null;};
  }}));
  return sources.get(model);
 }}) as PrismaClient;
}
