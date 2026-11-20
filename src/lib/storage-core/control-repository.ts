import {captureControlSkillFiles,materializeControlSkillFiles} from './control-files';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import contracts from '../../../services/storage/schema/platform-control-models.json';
import {requireCoreControlContext} from './control-context';
import {controllerHeaders} from './controller';
import {requestCore} from './server';
import {controlMatches,controlRows,controlProject} from './experiment-view';

type Row=Record<string,any>;
type Model={fields:Record<string,{type:string;nullable:boolean;default:{value?:unknown;factory?:string}|null;updated:boolean}>;relations:Record<string,{model:string;many:boolean;fields?:string[];references?:string[];cascade?:boolean}>;unique:string[][]};
const models=contracts.models as unknown as Record<string,Model>;
const bodyFields=new Set(['output','externalAccount','content','files','blocks','rawOutput','flowJson','mermaidCode','apiKey','tokenHash','credentialHash']);
const heavy=(field:string)=>bodyFields.has(field)||field.endsWith('Json');
const fail=(status:number,message:string,code?:string)=>Object.assign(new Error(message),{status,code});
const plain=(value:any):value is Row=>!!value&&typeof value==='object'&&!Array.isArray(value)&&!(value instanceof Date);
interface Saved {record_id:string;revision:string;owner_principal_id:string;data:Row;file_bundle?:import('./control-files').ControlFile[]}
interface Transaction {actor:string;write:boolean;scopes:Map<string,string>;rows:Map<string,Saved>;operations:Row[];projections:Array<{kind:string;id:string;value:Row}>}
const transactions=new AsyncLocalStorage<Transaction>();
export const isCoreControlKind=(kind:string)=>Object.hasOwn(models,kind);
function actorKey(){const {actor,origin}=requireCoreControlContext();return [origin,actor.principal,actor.workspace,actor.token].join('\0');}
async function rpc(action:string,value:Row,writePrior=false):Promise<any>{
 const context=requireCoreControlContext();const access=action==='records_batch'?'request':writePrior?'write-prior':context.access;
 const capability=context.device?{type:'device',credential_hash:context.device.credentialHash,client_id:context.device.clientId}:context.install?{type:'install',token_hash:context.install.tokenHash,...(context.install.previousCredentialHash?{previous_credential_hash:context.install.previousCredentialHash}:{})}:null;
 const body=JSON.stringify({action,access,...value,...(action!=='scope'&&context.capabilities?.length?{required_capabilities:context.capabilities}:{}),...(capability?{capability}:{})});const purpose=access==='collector-preparation'?'platform-control-prepare/v1':access==='write-prior'?'platform-control-write/v1':'platform-control/v1';
 const headers=await controllerHeaders(capability?{principal:'platform-capability',workspace:'platform-capability'}:context.actor,body,capability?'platform-control-bootstrap/v1':purpose);
 const {data}=await requestCore((capability?'/v1/compat/platform-control-capability':'/v1/compat/platform-control')+'?'+new URLSearchParams({workspace_id:context.actor.workspace}),{token:context.actor.token,method:'POST',body,headers,responseLimit:128*1024*1024,timeoutMs:60000},context.options.fetcher||fetch);
 if(!plain(data.value))throw fail(502,'Invalid control repository response');return data.value;
}
export async function requireCoreControlCapabilities(...capabilities:string[]){await rpc('scope',{capabilities});}
export async function canWriteCoreControl(){try{await requireCoreControlCapabilities('write');return true;}catch(error){if((error as any)?.status===403)return false;throw error;}}
function normalizedWhere(model:Model,where:Row={}):Row{
 const out:Row={};for(const [key,value] of Object.entries(where)){if(value===undefined)continue;
  if(['AND','OR','NOT'].includes(key)){out[key]=Array.isArray(value)?value.map(item=>normalizedWhere(model,item)):normalizedWhere(model,value);continue;}
  if(!(key in model.fields)&&!(key in model.relations)&&plain(value)&&model.unique.some(fields=>fields.join('_')===key)){Object.assign(out,Object.fromEntries(Object.entries(value).filter(([,item])=>item!==undefined)));continue;}out[key]=value;
 }return out;
}
function selectors(kind:string,where:Row={}):Row{
 const model=models[kind],result:Row={kind,body:false};
 const exact=(value:any)=>value===null||['string','number','boolean'].includes(typeof value)||plain(value)&&Array.isArray(value.in);
 const metadata:Row={};const visit=(condition:Row)=>{for(const [field,value] of Object.entries(condition)){if(field==='AND')for(const part of Array.isArray(value)?value:[value])visit(part);else if(field in model.fields&&!heavy(field)&&exact(value)&&!(field in metadata))metadata[field]=plain(value)?value.in:value;}};visit(where);
 if(typeof metadata.id==='string'){result.ids=[metadata.id];delete metadata.id;}else if(Array.isArray(metadata.id)){result.ids=metadata.id;delete metadata.id;}
 if(Object.keys(metadata).length)result.metadata=metadata;
 return result;
}
function hydrate(kind:string,data:Row):Row{const out={...data};for(const [key,spec] of Object.entries(models[kind].fields))if(spec.type==='DateTime'&&typeof out[key]==='string')out[key]=new Date(out[key]);return out;}
function selectedRelations(kind:string,query:Row):Set<string>{
 const names=new Set<string>();for(const count of [query.select?._count,query.include?._count])if(count)for(const name of Object.keys(count===true?models[kind].relations:count.select||{}))if(name in models[kind].relations)names.add(name);for(const source of [query.include,query.select,query.where])if(plain(source))for(const key of Object.keys(source))if(key in models[kind].relations)names.add(key);
 const visit=(where:any)=>{if(!plain(where))return;for(const [key,value] of Object.entries(where)){if(key in models[kind].relations)names.add(key);if(['AND','OR','NOT'].includes(key))for(const part of Array.isArray(value)?value:[value])visit(part);}};visit(query.where);return names;
}
function filterFields(model:Model,where:Row):Set<string>{const fields=new Set<string>();const visit=(part:Row)=>{for(const [key,value] of Object.entries(part)){if(['AND','OR','NOT'].includes(key))for(const child of Array.isArray(value)?value:[value]){if(plain(child))visit(child);}else if(key in model.fields&&heavy(key))fields.add(key);}};visit(where);return fields;}
function metadataWhere(model:Model,where:Row):Row{const out:Row={};for(const [key,value] of Object.entries(where)){if(value===undefined)continue;if(['OR','NOT'].includes(key)&&filterFields(model,{[key]:value}).size)continue;if(key==='AND')out[key]=(Array.isArray(value)?value:[value]).map(part=>metadataWhere(model,part));else if(!heavy(key))out[key]=value;}return out;}
async function read(kind:string,query:Row={},write=false,depth=0,directory=false,bodyFilter?:Row):Promise<Saved[]>{
 if(depth>8)throw fail(400,'Control relation nesting exceeds limit');const model=models[kind];if(!model)throw fail(501,'Unsupported control kind');
 query=Object.fromEntries(Object.entries(query).filter(([key])=>['where','select','include','orderBy','skip','take','distinct'].includes(key)));const where=normalizedWhere(model,query.where);const tx=transactions.getStore();if(tx&&tx.actor!==actorKey())throw fail(403,'Control transaction actor changed');
 const selection=selectors(kind,where);const snapshot=await rpc('records_read',selection,write||!!tx?.write);
 if(!Array.isArray(snapshot.rows)||typeof snapshot.scope_revision!=='string')throw fail(502,'Invalid control directory');
 if(tx){const current=tx.scopes.get(kind);if(current!==undefined&&current!==snapshot.scope_revision)throw fail(409,'Control transaction changed');tx.scopes.set(kind,snapshot.scope_revision);}
 let rows:Saved[]=snapshot.rows.map((row:Saved)=>({...row,data:hydrate(kind,row.data)}));
 if(tx){for(const row of rows){const key=kind+'\0'+row.record_id;if(!tx.rows.has(key))tx.rows.set(key,row);}
  const pending=tx.operations.filter(item=>item.kind===kind);for(const operation of pending){rows=rows.filter(row=>row.record_id!==operation.record_id);if(operation.method!=='delete'){const row=tx.rows.get(kind+'\0'+operation.record_id);if(row)rows.push(row);}}
 }
 for(const name of selectedRelations(kind,query)){
  const relation=model.relations[name];const related=models[relation.model];if(!related)throw fail(501,'Control relation belongs to a typed domain: '+name);
  const choice=query.select?.[name]||query.include?.[name];const nested=plain(choice)?choice:choice===true?{}:{select:{id:true}};
  let references:string[],fields:string[];
  if(relation.fields){fields=relation.fields;references=relation.references||[];}
  else {const inverse=Object.values(related.relations).find(item=>item.model===kind&&item.fields?.length);if(!inverse)throw fail(501,'Control inverse relation unavailable');fields=inverse.references||[];references=inverse.fields||[];}
  for(const row of rows){
   if(fields.some(field=>row.data[field]==null)){Object.defineProperty(row.data,name,{value:relation.many?[]:null,enumerable:false,configurable:true});continue;}
   const join=Object.fromEntries(references.map((field,index)=>[field,row.data[fields[index]]]));
   const children=await read(relation.model,{...nested,where:join},write,depth+1,true,nested.where);
   const values=children.map(item=>item.data);Object.defineProperty(row.data,name,{value:relation.many?values:values[0]||null,enumerable:false,configurable:true});
  }
 }
 // Directory filters and pagination precede body loading, notably for Skill version histories.
 const bodyWhere=bodyFilter?{AND:[where,normalizedWhere(model,bodyFilter)]}:where;const scalarWhere=metadataWhere(model,bodyWhere);const requiredFilterFields=filterFields(model,bodyWhere);
 if(kind==='user')for(const row of rows)row.data.apiKey=requireCoreControlContext().actor.token;
 let candidates=rows.filter(row=>controlMatches(row.data,scalarWhere));
 const needed=new Set<string>();if(query.select){for(const [key,value] of Object.entries(query.select))if(value===true&&heavy(key)&&!(kind==='user'&&key==='apiKey'))needed.add(key);}else for(const key of Object.keys(model.fields))if(heavy(key)&&!(kind==='user'&&key==='apiKey'))needed.add(key);
 for(const key of requiredFilterFields)if(!(kind==='user'&&key==='apiKey'))needed.add(key);
 const paginated=!requiredFilterFields.size;if(paginated){
  const ordered=controlRows(candidates.map(row=>row.data),{...query,where:undefined});const selected=new Set(ordered);candidates=candidates.filter(row=>selected.has(row.data));
 }
 const missing=candidates.filter(row=>[...needed].some(field=>!(field in row.data)));
 if(missing.length){
  const full=await rpc('records_read',{kind,ids:missing.map(row=>row.record_id),fields:[...needed],body:false},write||!!tx?.write);
  if(full.scope_revision!==snapshot.scope_revision)throw fail(409,'Control record directory changed');
  const fetched=new Map<string,Row>(full.rows.map((item:Saved)=>{const original=missing.find(row=>row.record_id===item.record_id);if(original?.revision!==item.revision)throw fail(409,'Control record changed');const data=hydrate(kind,item.data);if(kind==='skillVersion'&&item.file_bundle)data.assetPath=materializeControlSkillFiles({...original?.data,...data},item.file_bundle);return [item.record_id,data];}));
  for(const row of missing){const data=fetched.get(row.record_id);if(!data)throw fail(409,'Control record changed during read');Object.assign(row.data,data);}
 }
 if(tx)for(const row of candidates)if(!tx.operations.some(item=>item.kind===kind&&item.record_id===row.record_id))tx.rows.set(kind+'\0'+row.record_id,row);
 const projected=controlRows(candidates.map(row=>row.data),{...query,...(paginated?{skip:undefined,take:undefined}:{}),where:bodyWhere});const selected=new Set(projected);if(directory)return rows;return candidates.filter(row=>selected.has(row.data)).sort((a,b)=>projected.indexOf(a.data)-projected.indexOf(b.data));
}
function defaults(kind:string,input:Row,old?:Row):Row{
 const now=new Date(),model=models[kind],data=Object.fromEntries(Object.entries(old||{}).filter(([key])=>key in model.fields));
 for(const [field,spec] of Object.entries(model.fields)){
  if(input[field]!==undefined){const value=input[field];if(plain(value)&&['increment','decrement','set','multiply','divide'].some(key=>key in value)){
   if('set'in value)data[field]=value.set;else if('increment'in value)data[field]=(data[field]??0)+value.increment;else if('decrement'in value)data[field]=(data[field]??0)-value.decrement;else if('multiply'in value)data[field]*=value.multiply;else data[field]/=value.divide;
  }else data[field]=value;}
  else if(!(field in data)){if(spec.default?.factory==='id')data[field]='ctl_'+randomUUID().replaceAll('-','');else if(spec.default?.factory==='now')data[field]=now;else if(spec.default&&'value'in spec.default)data[field]=structuredClone(spec.default.value);else if(spec.nullable)data[field]=null;}
  if(spec.updated)data[field]=now;
 }
 for(const [key,value] of Object.entries(input))if(!(key in model.fields)&&!(key in model.relations)&&value!==undefined)throw fail(400,'Unsupported control field: '+key);
 return data;
}
function enqueue(kind:string,method:string,data:Row,old?:Saved):Row{
 const tx=transactions.getStore();if(!tx||tx.actor!==actorKey())throw fail(403,'Control transaction required');
 const id=data.id;const files=kind==='skillVersion'&&method!=='delete'?captureControlSkillFiles(data):undefined;const existing=tx.operations.find(item=>item.kind===kind&&item.record_id===id);
 const operation:Row={kind,method,record_id:id,...(method==='delete'?{}:{data,...(files?{file_bundle:files}:{})}),...(old&&!existing?{expected_revision:old.revision}:{})};
 if(existing&&existing.method==='create'&&method!=='delete')operation.method='create';
 if(existing){if(existing.method==='create'&&method==='delete')tx.operations.splice(tx.operations.indexOf(existing),1);else tx.operations.splice(tx.operations.indexOf(existing),1,operation);}else tx.operations.push(operation);
 const row:Saved={record_id:id,revision:old?.revision||'0',owner_principal_id:requireCoreControlContext().actor.principal,data:files?{...data,assetPath:materializeControlSkillFiles(data,files)}:data};tx.rows.set(kind+'\0'+id,row);return row.data;
}
async function requireVersionOwner(kind:string,data:Row){if(kind!=='skillVersion')return;const parents=await read('skill',{where:{id:data.skillId},select:{id:true}},true);if(parents.length!==1||parents[0].owner_principal_id!==requireCoreControlContext().actor.principal)throw fail(403,'Skill version requires its actual owner');}
async function nestedWrites(kind:string,data:Row,parent:Row){
 for(const [field,value] of Object.entries(data)){
  const relation=models[kind].relations[field];if(!relation||!plain(value))continue;
  if(relation.fields){if(value.connect)for(let i=0;i<relation.fields.length;i++)parent[relation.fields[i]]=value.connect[relation.references![i]];else throw fail(501,'Unsupported parent relation mutation');continue;}
  const inverse=Object.values(models[relation.model]?.relations||{}).find(item=>item.model===kind&&item.fields?.length);if(!inverse)throw fail(501,'Unsupported child relation mutation');
  const join=Object.fromEntries(inverse.fields!.map((name,index)=>[name,parent[inverse.references![index]]]));
  const child=delegate(relation.model);
  if(value.deleteMany!==undefined)for(const where of Array.isArray(value.deleteMany)?value.deleteMany:[value.deleteMany])await child.deleteMany({where:{AND:[join,where]}});
  if(value.create!==undefined)for(const row of Array.isArray(value.create)?value.create:[value.create])await child.create({data:{...row,...join}});
  if(value.createMany)for(const row of value.createMany.data)await child.create({data:{...row,...join}});
  if(value.update)for(const item of Array.isArray(value.update)?value.update:[value.update])await child.update({where:{AND:[join,item.where]},data:item.data});
  if(Object.keys(value).some(key=>!['deleteMany','create','createMany','update'].includes(key)))throw fail(501,'Unsupported child relation mutation');
 }
}
class Operation<T> implements PromiseLike<T>{constructor(readonly run:()=>Promise<T>,readonly mutation=false){}then<TResult1=T,TResult2=never>(ok?:((value:T)=>TResult1|PromiseLike<TResult1>)|null,bad?:((reason:any)=>TResult2|PromiseLike<TResult2>)|null){return this.run().then(ok,bad);}}
async function transaction<T>(action:((client:any)=>Promise<T>)|Operation<any>[],forceWrite?:boolean):Promise<T>{
 if(transactions.getStore())return Array.isArray(action)?await Promise.all(action.map(item=>item.run())) as T:action(controlClient);
 const write=forceWrite??(Array.isArray(action)?action.some(item=>item.mutation):requireCoreControlContext().capabilities?.includes('write')??true);
 const tx:Transaction={actor:actorKey(),write,scopes:new Map(),rows:new Map(),operations:[],projections:[]};
 return transactions.run(tx,async()=>{const result=Array.isArray(action)?await action.reduce(async(previous,item)=>[...await previous,await item.run()],Promise.resolve([] as any[])):await action(controlClient);
  if(tx.operations.length){
   const committed=await rpc('records_batch',{legacy_username:requireCoreControlContext().actor.username,operation_key:randomUUID(),operations:tx.operations,expected_kind_revisions:Object.fromEntries(tx.scopes)});
   if(!Array.isArray(committed.results)||committed.results.length!==tx.operations.length)throw fail(502,'Invalid control commit receipt');
   for(const [index,operation] of tx.operations.entries()){
    if(operation.method==='delete')continue;
    const saved=committed.results[index];if(!plain(saved)||saved.id!==operation.record_id)throw fail(502,'Invalid control commit identity');
    const data=hydrate(operation.kind,saved);
    for(const projection of tx.projections)if(projection.kind===operation.kind&&projection.id===operation.record_id){
     for(const field of Object.keys(projection.value))if(field in data)projection.value[field]=data[field];
    }
   }
  }
  return result as T;
 });
}
function committedProjection(kind:string,row:Row,query:Row):Row {
 const value=controlProject(row,query);
 transactions.getStore()?.projections.push({kind,id:row.id,value});
 return value;
}
const delegates=new Map<string,any>();
function delegate(kind:string):any{
 if(delegates.has(kind))return delegates.get(kind);const value=new Proxy({},{get:(target,method)=>{
  if(Object.hasOwn(target,method))return Reflect.get(target,method);
  if(method==='then')return undefined;const name=String(method);
  if(!['findMany','findFirst','findUnique','findFirstOrThrow','findUniqueOrThrow','count','aggregate','groupBy','create','createMany','update','updateMany','upsert','delete','deleteMany'].includes(name))throw fail(501,'Unsupported fixed control operation: '+name);
  return (args:Row={})=>new Operation(async()=>{
   const mutation=['create','createMany','update','updateMany','upsert','delete','deleteMany'].includes(name);
   const run=async()=>{
    if(name==='create'||name==='createMany'){
     const entries=name==='create'?[args.data]:args.data;const results=[];for(const input of entries){const data=defaults(kind,input);for(const [field,relation] of Object.entries(models[kind].relations))if(relation.fields&&input[field]?.connect)for(let i=0;i<relation.fields.length;i++)data[relation.fields[i]]=input[field].connect[relation.references![i]];
      await requireVersionOwner(kind,data);const created=enqueue(kind,'create',data);await nestedWrites(kind,Object.fromEntries(Object.entries(input).filter(([field])=>!models[kind].relations[field]?.fields)),data);results.push(created);}
     return name==='createMany'?{count:results.length}:committedProjection(kind,results[0],args);
    }
    const rows=await read(kind,{...args,...(name==='count'?{select:{id:true}}:{}),...(['findFirst','findUnique','findFirstOrThrow','findUniqueOrThrow','update','upsert','delete'].includes(name)?{take:1}:{})},mutation);
    if(!mutation){const values=rows.map(row=>row.data);if(name==='count')return values.length;
     if(name==='aggregate'||name==='groupBy'){
      const groups=name==='aggregate'?[values]:[...values.reduce((groups:Map<string,Row[]>,row)=>{const key=JSON.stringify(args.by.map((field:string)=>row[field]));groups.set(key,[...(groups.get(key)||[]),row]);return groups;},new Map<string,Row[]>()).values()];
      const calculated=groups.map(group=>{const result:Row=name==='groupBy'?Object.fromEntries(args.by.map((key:string)=>[key,group[0][key]])):{};
       for(const key of ['_count','_max','_min','_sum','_avg'])if(args[key]){if(args[key]===true){result[key]=group.length;continue;}result[key]={};for(const field of Object.keys(args[key])){const numbers=group.map(row=>row[field]).filter(value=>value!=null);result[key][field]=key==='_count'?(field==='_all'?group.length:numbers.length):!numbers.length?null:key==='_max'?numbers.reduce((a,b)=>a>b?a:b):key==='_min'?numbers.reduce((a,b)=>a<b?a:b):numbers.reduce((a,b)=>a+b,0)/(key==='_avg'?numbers.length:1);}}
       return result;});return name==='aggregate'?calculated[0]:calculated;
     }
     if(name==='findMany')return values.map(row=>controlProject(row,args));if(!values.length&&name.endsWith('OrThrow'))throw fail(404,'Control record not found','P2025');return values[0]?controlProject(values[0],args):null;
    }
    if(name==='upsert'&&!rows.length)return await delegate(kind).create({data:args.create,select:args.select,include:args.include});
    if(!rows.length&&!name.endsWith('Many'))throw fail(404,'Control record not found','P2025');const results=[];
    for(const row of rows){if(name==='delete'||name==='deleteMany'){enqueue(kind,'delete',row.data,row);results.push(row.data);}else {const input=name==='upsert'?args.update:args.data;const data=defaults(kind,input,row.data);await requireVersionOwner(kind,data);const updated=enqueue(kind,'update',data,row);await nestedWrites(kind,input,data);results.push(updated);}}
    return name.endsWith('Many')?{count:results.length}:committedProjection(kind,results[0],args);
   };
   return mutation&&!transactions.getStore()?transaction(run,true):run();
  },['create','createMany','update','updateMany','upsert','delete','deleteMany'].includes(name));
 }});delegates.set(kind,value);return value;
}
const unavailableDelegates=new Map<string,object>();
export const controlClient:any=new Proxy({},{get:(target,kind)=>{
 if(Object.hasOwn(target,kind))return Reflect.get(target,kind);
 if(kind==='$disconnect')return async()=>{};if(typeof kind==='symbol'||kind==='then')return undefined;
 if(kind==='$transaction')return (action:any)=>transaction(action);
 if(typeof kind==='string'&&isCoreControlKind(kind))return delegate(kind);
 if(typeof kind!=='string'||kind.startsWith('$'))throw fail(501,'Unsupported Core operation: '+String(kind));
 if(!unavailableDelegates.has(kind))unavailableDelegates.set(kind,new Proxy({}, {get:(operations,method)=>{
  if(Object.hasOwn(operations,method))return Reflect.get(operations,method);
  if(method==='then'||typeof method==='symbol')return undefined;
  return ()=>{throw fail(501,'Use the typed Storage Core API for domain: '+kind);};
 }}));
 return unavailableDelegates.get(kind);
}});
export function withControlDelegates<T extends object>(_legacy: T): T {
 return controlClient as T;
}

export const controlRepositoryRequest=rpc;

export function coreControlCacheKey(value:string){const context=requireCoreControlContext();return [context.origin,context.actor.workspace,context.actor.principal,value].join('\0');}
