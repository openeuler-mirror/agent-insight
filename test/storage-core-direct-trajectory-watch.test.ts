import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
test('direct auto-watch seed validation uses trusted core Trace evidence without legacy list reads',async()=>{
 let legacy=0;const context={actor:{username:'alice'},request:new Request('http://localhost'),options:{}};const requested:string[]=[];
 const deps:Record<string,unknown>={'@/lib/storage/data-service':{readRecords:async()=>{legacy++;throw Error('Legacy Trace reads forbidden');}},'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},'@/lib/storage-core/experiments':{requireCoreExperimentContext:()=>context},'@/lib/storage-core/evidence':{readTraceEvidence:async(_req:unknown,{taskId}:{taskId:string})=>{requested.push(taskId);return {evidence:{execution:{id:'execution',taskId,agentName:'agent'},session:{interactions:[]}}};}},'@/lib/engine/observability/agent-registration':{getPrimaryObservedAgentName:()=>''},'@/lib/evaluator-agent':{isEvaluatorTraceRecord:()=>false,getPrimaryExecutionAgentName:(record:{agentName:string})=>record.agentName,isEvaluatorAgentName:()=>false}};
 const module={exports:{}};vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/engine/evaluation/trajectory-auto-watch-helper.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:(name:string)=>deps[name]||{},Set,Map,Date,JSON});
 const api=module.exports as Record<string,Function>;const resolution=await api.resolveSingleTrajectoryCandidateAgent('alice',['task','task']);assert.equal(resolution.agent,'agent');assert.deepEqual(requested,['task']);assert.equal(legacy,0);
 await assert.rejects(api.resolveSingleTrajectoryCandidateAgent('forged',['task']),error=>(error as {status:number}).status===403);
});
