import assert from 'node:assert/strict';import test from 'node:test';import {readFileSync} from 'node:fs';import vm from 'node:vm';import {AsyncLocalStorage} from 'node:async_hooks';import ts from 'typescript';

test('Benchmark read views remain request scoped across independently loaded bundle instances',async()=>{
 const shared:Record<symbol,unknown>={};const context={actor:{username:'alice',principal:'p',workspace:'w',token:'token'},operationKey:'op',options:{},body:{}};const view={authorized:'alice'};
 const code=ts.transpileModule(readFileSync('src/lib/benchmark/core-store.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 type Module={withCoreBenchmarkReadView<T>(id:string,action:()=>Promise<T>):Promise<T>;benchmarkReadSource<T>(legacy:T):T};
 function instance():Module{const module={exports:{}};vm.runInNewContext(code,{module,exports:module.exports,globalThis:shared,Symbol,Buffer,fetch,JSON,URLSearchParams,require:(name:string)=>{
  if(name==='node:async_hooks')return {AsyncLocalStorage};if(name.endsWith('/mode'))return {isStorageCoreEnabled:()=>false};if(name.endsWith('/experiments'))return {getCoreExperimentContext:()=>context,requireCoreExperimentContext:()=>context};if(name.endsWith('/datasets'))return {getCoreDatasetContext:()=>undefined};if(name.endsWith('/experiment-view'))return {createExperimentReadView:()=>view};if(name.endsWith('/server'))return {requestCore:async()=>({data:{value:{coverage:'complete',snapshots:[]}}})};if(name.endsWith('/controller'))return {};throw Error(name);
 }});return module.exports as Module;}
 const writer=instance();const reader=instance();await writer.withCoreBenchmarkReadView('experiment',async()=>assert.equal(reader.benchmarkReadSource({legacy:true}),view));assert.throws(()=>reader.benchmarkReadSource({legacy:true}),{status:503});
});
