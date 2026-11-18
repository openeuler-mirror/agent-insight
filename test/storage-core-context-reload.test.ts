import {controlVmFixture} from './helpers/storage-core-vm';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import test from 'node:test';
const require=createRequire(import.meta.url);
function modules(file:string){
 const shared={};
 const control=controlVmFixture({actor:{token:'fixture',principal:'alice',workspace:'w',username:'alice'}}).context;
 function load(){
  const exports:Record<string,any>={};
  const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const context=vm.createContext({exports,globalThis:shared,Symbol,AsyncLocalStorage,Request,URL,Headers,Map,structuredClone,fetch,process,
   require:(name:string)=>name==='./control-context'?control:name==='./compat'?{compatibilityContext:async(request:Request)=>({token:'fixture',principal:request.headers.get('x-test-user')||'alice',workspace:'w',username:request.headers.get('x-test-user')||'alice'})}:name==='./mode'?{isStorageCoreEnabled:()=>true}:name==='./server'||name==='./evidence'?{}:require(name)});
  new vm.Script(code,{filename:file}).runInContext(context);return exports;
 }
 return [load(),load()];
}
for(const [file,run,get] of [
 ['src/lib/storage-core/datasets.ts','withCoreDatasets','getCoreDatasetContext'],
 ['src/lib/storage-core/evaluators.ts','withCoreEvaluators','getCoreEvaluatorContext'],
 ['src/lib/storage-core/reports.ts','withCoreReports','getCoreReportContext'],
])test('independent module instances share only the active request scope: '+file,async()=>{
 const [first,second]=modules(file);assert.equal(second[get](),undefined);
 await first[run](new Request('http://localhost/internal'),async()=>{
  assert.equal(second[get]()?.actor.username,'alice');
  await second[run](new Request('http://localhost/internal',{headers:{'x-test-user':'bob'}}),async()=>{assert.equal(first[get]()?.actor.username,'bob');await new Promise(resolve=>setImmediate(resolve));assert.equal(first[get]()?.actor.username,'bob');});
  assert.equal(second[get]()?.actor.username,'alice');
 });assert.equal(first[get](),undefined);assert.equal(second[get](),undefined);
});
test('trusted Agent workspace and model survive module reload without losing request isolation',async()=>{
 const [first,second]=modules('src/lib/engine/general-agent/trusted-context.ts');const recorder=async()=>{};
 await first.runWithTrustedCoreAgentContext({trustedWorkspaceDir:'/isolated/alice',trustedModel:{model:'selected'},recordCoreTrace:recorder},async()=>{
  assert.equal(second.getTrustedCoreAgentContext()?.trustedWorkspaceDir,'/isolated/alice');
  const selected=second.getTrustedCoreAgentContext();selected.trustedModel.model='modified';assert.equal(first.getTrustedCoreAgentContext()?.trustedModel.model,'selected');
  await second.runWithTrustedCoreAgentContext({trustedWorkspaceDir:'/isolated/bob',trustedModel:{model:'other'},recordCoreTrace:recorder},async()=>assert.equal(first.getTrustedCoreAgentContext()?.trustedWorkspaceDir,'/isolated/bob'));
  assert.equal(second.getTrustedCoreAgentContext()?.trustedWorkspaceDir,'/isolated/alice');
 });assert.equal(second.getTrustedCoreAgentContext(),undefined);
});
