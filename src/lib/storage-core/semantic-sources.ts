import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import type {PrismaClient} from '@prisma/client';
import {resolveUser as legacyResolveUser} from '@/lib/auth/auth';
import {prismaRaw as legacy} from '@/lib/storage/prisma';
import models from '../../../services/storage/schema/semantic-models.json';
import {compatibilityFailure} from './compat';
import {getCoreControlContext,withCoreControlRequest,type CoreControlContext} from './control-context';
import {getCoreSessionScope,withCoreSessionRead} from './session-source';
import {getCoreExperimentContext} from './experiments';
import {getCoreDatasetContext} from './datasets';
import {getCoreEvaluatorContext} from './evaluators';
import {isStorageCoreEnabled} from './mode';
import {requestCore,coreServiceOrigin} from './server';
import {controllerHeaders} from './controller';
import {findCoreTraceExecutions,queryCoreTraceSources} from './collector-read-source';
type Row=Record<string,any>;
type State={revision:number;rows:Map<string,Row[]>;operations:Map<string,Row>};
const definitions=models as Record<string,any>;
const states=new WeakMap<object,Map<string,Promise<State>>>();
const transactions=new AsyncLocalStorage<Map<string,State>>();
const derivedContexts=new WeakMap<object,CoreControlContext>();
const readOwners=new WeakMap<object,string>();
const failure=(message:string,status=503)=>Object.assign(new Error(message),{status,code:status===409?'P2034':undefined});
export function semanticContext():CoreControlContext {
 const control=getCoreControlContext();if(control)return control;
 const scope=getCoreSessionScope()||getCoreExperimentContext()||getCoreDatasetContext()||getCoreEvaluatorContext();if(!scope||!scope.actor.username)throw failure('Verified semantic owner scope required');
 let context=derivedContexts.get(scope);if(!context){context={actor:{...scope.actor,username:scope.actor.username},options:scope.options,origin:coreServiceOrigin(),access:'request'};derivedContexts.set(scope,context);}return context;
}
export async function semanticRpc<T>(action:string,payload:Row={},context=semanticContext()):Promise<T>{
 if(context.origin!==coreServiceOrigin())throw failure('Semantic storage origin changed');
 const body=JSON.stringify({action,payload});
 const response=await requestCore('/v1/compat/semantic-usage?'+new URLSearchParams({workspace_id:context.actor.workspace}),{token:context.actor.token,method:'POST',body,headers:await controllerHeaders(context.actor,body,'semantic-usage/v1'),timeoutMs:65_000,responseLimit:32*1024*1024},context.options.fetcher||fetch);
 if(context.origin!==coreServiceOrigin())throw failure('Semantic storage origin changed');
 if(!Object.hasOwn(response.data,'value'))throw failure('Semantic storage response unavailable');return response.data.value as T;
}
export async function resolveSemanticUser(request:Request,explicitUser?:string|null){

 const {actor}=semanticContext();if(explicitUser&&explicitUser!==actor.username){const scope=await semanticRpc<{admin:boolean}>('scope');if(!scope.admin)throw failure('Semantic owner filter differs',403);readOwners.set(contextKey(),explicitUser);}
 return {username:explicitUser||actor.username,apiKey:actor.token};
}
export async function withSemanticRequest<T>(request:Request,action:()=>Promise<T>):Promise<T>{

 if(getCoreControlContext())return getCoreSessionScope()?action():withCoreSessionRead(request,action);
 return withCoreControlRequest(request,()=>withCoreSessionRead(request,action));
}
export async function semanticRoute(request:Request,action:()=>Promise<Response>):Promise<Response>{try{return await withSemanticRequest(request,action);}catch(error){return compatibilityFailure(error);}}
function revive(kind:string,row:Row){for(const [key,field] of Object.entries(definitions[kind].fields) as Array<[string,any]>)if(field.type==='DateTime'&&row[key]!=null)row[key]=new Date(row[key]);return row;}
function contextKey(){return getCoreControlContext()||getCoreSessionScope()||getCoreExperimentContext()||getCoreDatasetContext()||getCoreEvaluatorContext()||semanticContext();}
async function state(domain:string):Promise<State>{
 const active=transactions.getStore();if(active?.has(domain))return active.get(domain)!;
 const context=contextKey();let cache=states.get(context);if(!cache){cache=new Map();states.set(context,cache);}
 if(!cache.has(domain))cache.set(domain,(async()=>{const rows=new Map<string,Row[]>();for(const [kind,model] of Object.entries(definitions))if(model.domain===domain)rows.set(kind,[]);let cursor:Row|null=null,revision:number|undefined;
  do{const page:{revision:number;rows:Array<{kind:string;id:string;data:Row}>;cursor:Row|null}=await semanticRpc<{revision:number;rows:Array<{kind:string;id:string;data:Row}>;cursor:Row|null}>('read',{domain,limit:32,owner_username:readOwners.get(contextKey())||semanticContext().actor.username,...(semanticContext().access==='collector-preparation'?{preparation:true}:{}),...(cursor?{after:cursor}:{}),...(revision!==undefined?{revision}:{})});revision=page.revision;for(const item of page.rows)rows.get(item.kind)!.push(revive(item.kind,item.data));cursor=page.cursor;}while(cursor);
  return {revision:revision!,rows,operations:new Map()};})());
 return cache.get(domain)!;
}
function plain(value:any):any{return value instanceof Date?value.toISOString():Array.isArray(value)?value.map(plain):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,v])=>[key,plain(v)])):value;}
async function flush(domain:string,value:State){
 if(!value.operations.size)return;
 if(readOwners.has(contextKey())&&readOwners.get(contextKey())!==semanticContext().actor.username)throw failure('Actual semantic owner required',403);
 const result=await semanticRpc<{revision:number}>('apply',{domain,revision:value.revision,legacy_username:semanticContext().actor.username,operations:[...value.operations.values()].map(plain)});value.revision=result.revision;value.operations.clear();
}
async function relation(kind:string,row:Row,key:string):Promise<any>{
 const spec=definitions[kind]?.relations[key];if(!spec)return row[key];
 if(spec.model==='execution')return row[spec.field]?(await findCoreTraceExecutions(row.user||undefined,{references:[row[spec.field]],limit:2})).find(r=>r.id===row[spec.field])??null:null;
 if(!definitions[spec.model])throw failure('Unknown semantic relation');
 const value=await state(definitions[spec.model].domain),rows=value.rows.get(spec.model)!;
 return spec.many?rows.filter(item=>item[spec.foreign]===row.id):spec.field?rows.find(item=>item.id===row[spec.field])??null:rows.find(item=>item[spec.foreign]===row.id)??null;
}
async function matches(kind:string,row:Row,where:Row={}):Promise<boolean>{
 for(const [key,wanted] of Object.entries(where)){
  if(wanted===undefined)continue;
  if(key==='AND'||key==='OR'||key==='NOT'){const checks=await Promise.all((Array.isArray(wanted)?wanted:[wanted]).map(w=>matches(kind,row,w)));if(key==='AND'&&!checks.every(Boolean)||key==='OR'&&!checks.some(Boolean)||key==='NOT'&&checks.some(Boolean))return false;continue;}
  const rel=definitions[kind]?.relations[key];
  if(rel){const target=await relation(kind,row,key);if(Array.isArray(target)){const filter=wanted as Row;for(const operation of ['some','none','every'])if(filter[operation]){const checks=await Promise.all(target.map(item=>matches(rel.model,item,filter[operation])));if(operation==='some'&&!checks.some(Boolean)||operation==='none'&&checks.some(Boolean)||operation==='every'&&!checks.every(Boolean))return false;}}else{const filter=wanted as Row;if(filter===null){if(target!==null)return false;}else if(!target||!await matches(rel.model,target,filter.is||filter))return false;}continue;}
  if(!(key in row)&&wanted&&typeof wanted==='object'&&!Array.isArray(wanted)){if(!await matches(kind,row,wanted))return false;continue;}
  const actual=row[key],a=actual instanceof Date?actual.getTime():actual;
  if(wanted===null||typeof wanted!=='object'||wanted instanceof Date){if(a!==(wanted instanceof Date?wanted.getTime():wanted))return false;continue;}
  for(const [op,target] of Object.entries(wanted as Row)){if(target===undefined)continue;const b=target instanceof Date?target.getTime():target;
   if(op==='in'&&!b.includes(a)||op==='notIn'&&b.includes(a)||op==='equals'&&a!==b||op==='not'&&(typeof b==='object'?await matches(kind,{[key]:actual},{[key]:b}):a===b)||op==='contains'&&!(typeof a==='string'&&a.includes(b))||op==='startsWith'&&!(typeof a==='string'&&a.startsWith(b))||op==='endsWith'&&!(typeof a==='string'&&a.endsWith(b))||op==='gte'&&!(a>=b)||op==='gt'&&!(a>b)||op==='lte'&&!(a<=b)||op==='lt'&&!(a<b))return false;
  }
 }
 return true;
}
async function shape(kind:string,row:Row,args:Row={}):Promise<Row>{
 const result:Row=args.select?{}:{...row};
 for(const [key,spec] of Object.entries({...args.include,...args.select})){
  if(!spec)continue;
  if(key==='_count'){const counts:Row={};for(const name of Object.keys((spec as Row).select||{})){const items=await relation(kind,row,name);counts[name]=Array.isArray(items)?items.length:items?1:0;}result._count=counts;continue;}
  if(definitions[kind]?.relations[key]){const rel=definitions[kind].relations[key],value=await relation(kind,row,key);result[key]=Array.isArray(value)?await query(rel.model,value,spec===true?{}:spec as Row):value?await shape(rel.model,value,spec===true?{}:spec as Row):null;}
  else result[key]=row[key];
 }
 return result;
}
async function query(kind:string,rows:Row[],args:Row={}):Promise<Row[]>{
 let selected:Row[]=[];for(const row of rows)if(await matches(kind,row,args.where))selected.push(row);
 if(args.orderBy){const order=Array.isArray(args.orderBy)?args.orderBy:[args.orderBy];selected.sort((a,b)=>{for(const item of order)for(const [key,direction] of Object.entries(item)){let x=a[key] instanceof Date?a[key].getTime():a[key],y=b[key] instanceof Date?b[key].getTime():b[key];const sign=x===y?0:x==null?-1:y==null?1:x<y?-1:1;if(sign)return direction==='desc'?-sign:sign;}return 0;});}
 if(args.cursor){const index=selected.findIndex(row=>Object.entries(args.cursor).every(([k,v])=>row[k]===v));selected=index<0?[]:selected.slice(index);}
 if(args.skip)selected=selected.slice(args.skip);if(args.take!==undefined)selected=selected.slice(0,args.take);
 return Promise.all(selected.map(row=>shape(kind,row,args)));
}
function defaults(kind:string,data:Row){const result:Row={};for(const [key,spec] of Object.entries(definitions[kind].fields) as Array<[string,any]>){if(data[key]!==undefined)result[key]=data[key];else if(spec.updated)result[key]=spec.type==='DateTime'?new Date():new Date().toISOString();else if(spec.hasDefault)result[key]=spec.default==='$id'?randomUUID():spec.default==='$now'?(spec.type==='DateTime'?new Date():new Date().toISOString()):spec.default;else if(spec.nullable)result[key]=null;}return result;}
async function execute(kind:string,method:string,args:Row={},attempt=0):Promise<any>{
 if(kind==='execution'){const refs=args.where?.id?.in||[args.where?.id].filter(Boolean);const rows=await findCoreTraceExecutions(args.where?.user,{...(refs.length?{references:refs}:{}),limit:2000});return method==='findMany'?query(kind,rows,args):(await query(kind,rows,args))[0]??null;}
 const domain=definitions[kind].domain,value=await state(domain),rows=value.rows.get(kind)!;
 if(method==='findMany')return query(kind,rows,args);if(method==='findFirst'||method==='findUnique')return (await query(kind,rows,{...args,take:1}))[0]??null;if(method==='count')return (await query(kind,rows,args)).length;
 const selected=[];for(const row of rows)if(await matches(kind,row,args.where))selected.push(row);
 const change=(row:Row)=>{value.operations.set(kind+'\0'+row.id,{kind,id:row.id,data:row});};
 let result:any;
 if(method==='create'||method==='upsert'&&!selected.length){const row=defaults(kind,args.data||args.create);if(rows.some(item=>item.id===row.id))throw Object.assign(failure('Semantic ID exists',409),{code:'P2002'});rows.push(row);change(row);
  for(const [name,childSpec] of Object.entries((args.data||args.create)) as Array<[string,any]>){const rel=definitions[kind].relations[name];if(!rel||!childSpec?.create)continue;for(const child of Array.isArray(childSpec.create)?childSpec.create:[childSpec.create]){const saved=defaults(rel.model,{...child,[rel.foreign]:row.id});value.rows.get(rel.model)!.push(saved);value.operations.set(rel.model+'\0'+saved.id,{kind:rel.model,id:saved.id,data:saved});}}
  result=await shape(kind,row,args);}
 else if(method==='upsert'||method==='update'||method==='updateMany'){
  const targets=method==='updateMany'?selected:selected.slice(0,1);if(!targets.length&&method!=='updateMany')throw failure('Semantic record not found',404);
  for(const row of targets){Object.assign(row,method==='upsert'?args.update:args.data);for(const [key,field] of Object.entries(definitions[kind].fields) as Array<[string,any]>)if(field.updated)row[key]=field.type==='DateTime'?new Date():new Date().toISOString();change(row);}result=method==='updateMany'?{count:targets.length}:await shape(kind,targets[0],args);
 }else if(method==='deleteMany'){for(const row of selected){rows.splice(rows.indexOf(row),1);value.operations.set(kind+'\0'+row.id,{kind,id:row.id,delete:true});}result={count:selected.length};}
 else throw failure('Unsupported fixed semantic projection operation');
 if(!transactions.getStore()){try{await flush(domain,value);}catch(error){states.delete(contextKey());if((error as any)?.status===409&&attempt<3)return execute(kind,method,args,attempt+1);throw error;}}
 return result;
}
const delegates=Object.fromEntries([...Object.keys(definitions),'execution'].map(kind=>[kind,new Proxy({}, {get:(_,method)=>typeof method==='string'?(args:Row)=>execute(kind,method,args):undefined})]));
async function transaction(work:(tx:any)=>Promise<any>,attempt=0):Promise<any>{
 const inherited=transactions.getStore();if(inherited)return work(core);
 const active=new Map<string,State>();for(const domain of ['goal','collaboration']){const current=await state(domain);active.set(domain,{revision:current.revision,rows:structuredClone(current.rows),operations:new Map()});}
 try{const result=await transactions.run(active,()=>work(core));for(const [domain,value] of active)await flush(domain,value);states.delete(contextKey());return result;}catch(error){states.delete(contextKey());if((error as any)?.status===409&&attempt<3)return transaction(work,attempt+1);throw error;}
}
const core={...delegates,$transaction:transaction};
export const semanticProjection=new Proxy({} as PrismaClient,{get:(_,key)=>{return (core as Row)[key as string];}});
