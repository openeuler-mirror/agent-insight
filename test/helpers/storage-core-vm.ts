import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

type Actor={token:string;workspace:string;principal:string;username:string;principalUsername?:string|null};
function load(file:string,dependencies:Record<string,unknown>,shared:Record<symbol,unknown>={}){
 const module={exports:{}};
 vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,globalThis:shared,Symbol,Request,Response,Headers,URL,URLSearchParams,fetch,Map,Set,JSON,Object,Error,Promise,require:(name:string)=>{assert.ok(name in dependencies,'Unexpected isolated control dependency '+name);return dependencies[name];}});
 return module.exports as Record<string,any>;
}
export function controlVmFixture(input:{actor:Actor;enabled?:boolean;authenticate?:(request:Request)=>Promise<Actor>} ){
 const origin='http://127.0.0.1:19000';
 const context=load('src/lib/storage-core/control-context.ts',{
  'node:async_hooks':{AsyncLocalStorage},'./server':{coreServiceOrigin:()=>origin},
  './compat':{compatibilityContext:input.authenticate|| (async()=>input.actor),isVerifiedCoreBackgroundActor:(actor:Actor)=>actor===input.actor,revalidateConfiguredCoreBackgroundActor:async(actor:Actor)=>assert.equal(actor,input.actor)},
 });
 const repository={requireCoreControlCapabilities:async()=>{assert.equal(context.requireCoreControlContext().actor.principal,input.actor.principal);},canWriteCoreControl:async()=>{assert.ok(context.getCoreControlContext());return true;}};
 const route=load('src/lib/storage-core/control-route.ts',{'./mode':{isStorageCoreEnabled:()=>input.enabled!==false},'./control-context':context,'./control-auth':{withCoreControlDevice:()=>{throw Error('Unexpected device credential');}},'./control-repository':repository});
 return {context,route,repository,assertScoped:()=>assert.equal(context.requireCoreControlContext().actor.username,input.actor.username)};
}
export const configuredModelFetchFixture=load('src/lib/server/configured-model-fetch.ts',{'./model-fetch':{getModelFetch:()=>async()=>{throw Error('Unexpected model transport outside explicit fixture');}}}).configuredModelFetch;
