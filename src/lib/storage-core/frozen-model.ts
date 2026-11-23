import {createHash} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import type {ModelConfig} from '@/lib/storage/server-config';
const key=Symbol.for('agent-insight.storage-core.frozen-model');
const globals=globalThis as unknown as Record<symbol,AsyncLocalStorage<{username:string;config:ModelConfig|null}>>;
const contexts=globals[key] ||= new AsyncLocalStorage<{username:string;config:ModelConfig|null}>();
export function frozenModelConfiguration(username?:string|null):{active:boolean;config:ModelConfig|null}{
 const scope=contexts.getStore();if(!scope)return {active:false,config:null};
 if(scope.username!==username)throw Object.assign(new Error('Frozen model actor identity differs'),{status:403});
 return {active:true,config:structuredClone(scope.config)};
}
export function runWithFrozenModelConfiguration<T>(username:string,config:ModelConfig|null,action:()=>T):T{
 if(!username)throw new Error('Verified frozen model actor required');return contexts.run({username,config:structuredClone(config)},action);
}

export function freezeModelSelection(config:ModelConfig|null):{id:string;provider:string|null;model:string|null;baseUrl:string|null;connection_hash:string;connection_format:'model-connection/v2'}|null{
 if(!config)return null;
 let baseUrl:string|null=null;
 if(config.baseUrl){const url=new URL(config.baseUrl);if(!['http:','https:'].includes(url.protocol))throw Object.assign(new Error('Invalid model connection origin'),{status:503});baseUrl=url.origin+url.pathname;}
 let headers:Array<[string,string]>;try{headers=[...new Headers(config.headers||{})].sort(([left],[right])=>left.localeCompare(right));}catch{throw Object.assign(new Error('Invalid frozen model headers'),{status:503});}
 const connection_hash=createHash('sha256').update(JSON.stringify({provider:config.provider||null,model:config.model||null,baseUrl:config.baseUrl||null,headers,...(config.protocol?{protocol:config.protocol}:{})})).digest('hex');
 return {id:config.id,provider:config.provider||null,model:config.model||null,baseUrl,connection_hash,connection_format:'model-connection/v2'};
}

export function matchesFrozenModelSelection(config:ModelConfig,selection:Record<string,unknown>):boolean{
 if(config.id!==selection.id)return false;
 if(selection.connection_format==='model-connection/v2')return freezeModelSelection(config)?.connection_hash===selection.connection_hash;
 if(config.protocol)return false;
 if(selection.connection_format!=null&&selection.connection_format!=='model-connection/v1')return false;
 try{if([...new Headers(config.headers||{})].length)return false;}catch{return false;}
 if(selection.connection_hash)return selection.connection_hash===createHash('sha256').update(JSON.stringify({provider:config.provider||null,model:config.model||null,baseUrl:config.baseUrl||null})).digest('hex');
 return ['provider','model','baseUrl'].every(key=>(config[key as keyof ModelConfig]||null)===(selection[key]||null));
}
