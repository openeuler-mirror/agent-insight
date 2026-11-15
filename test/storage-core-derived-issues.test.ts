import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {createHash} from 'node:crypto';
function load(rpc:(action:string,payload:Record<string,unknown>)=>Promise<unknown>){
 const module={exports:{}};const context={actor:{username:'owner'},rpc};
 vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/storage-core/derived-issues.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:(id:string)=>id==='node:crypto'?{createHash}:{requireCoreExperimentContext:()=>context},Error,Map,Set,JSON});return module.exports as Record<string,Function>;
}
test('derived issue reader uses typed selected lists and immutable Evaluation identities without legacy SQL',async()=>{
 const calls:string[]=[];const api=load(async(action,body)=>{calls.push(action);if(action==='derived_list'){assert.equal(body.skill_id,'skill');assert.equal(body.owned_only,true);return [{id:'issue',skillId:'skill',version:1,source:'trajectory',ruleId:'rule',evaluationId:'evaluation',resolvedAt:'time',resolvedRunId:'resolved'}];}assert.equal(action,'derived_lookup');assert.equal(body.kind,'evaluation');return {id:'evaluation',runId:'run',executionId:'execution'};});
 const rows=await api.readCoreDerivedIssues({user:'owner',skillId:'skill',version:1});assert.equal(rows.length,1);assert.equal(rows[0].resolvedRunId,'resolved');assert.equal(rows[0].Evaluation.runId,'run');assert.deepEqual(calls,['derived_list','derived_lookup']);
});
test('private redacted issues reject admin or shared projections instead of impersonating owner',async()=>{
 const api=load(async()=>[{id:'issue',skillId:'skill',version:1,gold_redacted:true}]);await assert.rejects(api.readCoreDerivedIssues({user:'owner',skillId:'skill',version:1}),error=>(error as {status?:number}).status===403);
});
test('explicit foreign issue lookup still rejects administrator metadata instead of silently filtering it',async()=>{
 const api=load(async(action,body)=>{assert.equal(action,'derived_lookup');assert.equal(body.kind,'issue');return {id:'foreign',skillId:'skill',version:1,gold_redacted:true};});
 await assert.rejects(api.readCoreDerivedIssues({user:'owner',skillId:'skill',version:1,ids:['foreign']}),error=>(error as {status?:number}).status===403);
});
test('resolution uses stable semantic request identity and checks every accepted id',async()=>{
 const calls:Record<string,unknown>[]=[];const api=load(async(action,body)=>{assert.equal(action,'derived_issue_resolve');calls.push(body);return {resolved_ids:['a','b'],newly_resolved:2,resolved_run_id:'run'};});
 await api.resolveCoreDerivedIssues({user:'owner',ids:['b','a'],resolvedRunId:'run'});await api.resolveCoreDerivedIssues({user:'owner',ids:['a','b'],resolvedRunId:'run'});assert.equal(calls[0].operation_key,calls[1].operation_key);assert.deepEqual(calls[0].operation_request,calls[1].operation_request);
 const invalid=load(async()=>({resolved_ids:['a'],newly_resolved:1,resolved_run_id:'run'}));await assert.rejects(invalid.resolveCoreDerivedIssues({user:'owner',ids:['a','missing'],resolvedRunId:'run'}),error=>(error as {status?:number}).status===503);
});
