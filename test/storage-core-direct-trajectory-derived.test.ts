import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {createHash} from 'node:crypto';
function load(){let legacy=0;const module={exports:{}};vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/engine/evaluation/derive-skill-opt-points.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:(name:string)=>name==='crypto'?{createHash}:{prismaRaw:new Proxy({},{get(){legacy++;throw Error('Legacy access forbidden');}})},Date,JSON,Set,console});return {api:module.exports as Record<string,Function>,get legacy(){return legacy;}};}
const args={user:'alice',taskId:'task',runId:'run',trajectoryRow:{id:'row',deviationStepsJson:JSON.stringify([{stepIndex:2,deviation:'bad tool',severity:'medium',improvementSuggestion:'fix'},{stepIndex:3,deviation:'noise',severity:'low'}]),rootCauseStep:'#2',reasonText:'reason',rawAnalysisJson:JSON.stringify({resultSkillMode:'skill-aware',result_issues:[{kind:'format',summary:'bad format',severity:'medium'}]})},skills:[{name:'skill',version:2}]};
test('pure derived artifacts preserve existing issue decisions and stable lineage IDs without ORM',()=>{
 const f=load();assert.equal(typeof f.api.deriveOptPointArtifacts,'function');const options={executionId:'execution',lineage:'attempt-1',skills:[{id:'skill-id',name:'skill',activeVersion:1}]};
 const result=f.api.deriveOptPointArtifacts(args,options);assert.equal(result.evaluations.length,1);assert.equal(result.skillIssues.length,2);assert.equal(result.skillIssues[0].severity,'high');assert.equal(result.skillIssues[0].suggestedFix,'fix');assert.equal(result.skillIssues[1].category,'格式偏差');assert.equal(result.evaluations[0].version,2);assert.equal(result.evaluations[0].executionId,'execution');
 assert.deepEqual(JSON.parse(JSON.stringify(result)),JSON.parse(JSON.stringify(f.api.deriveOptPointArtifacts(args,options))));assert.notEqual(result.evaluations[0].id,f.api.deriveOptPointArtifacts(args,{...options,lineage:'attempt-2'}).evaluations[0].id);assert.equal(f.legacy,0);
});
test('pure derived artifacts preserve no-skill and unknown-skill exclusions',()=>{
 const f=load();assert.equal(typeof f.api.deriveOptPointArtifacts,'function');const options={executionId:null,lineage:'a',skills:[]};assert.equal(f.api.deriveOptPointArtifacts(args,options).evaluations.length,0);assert.equal(f.api.deriveOptPointArtifacts({...args,trajectoryRow:{...args.trajectoryRow,rawAnalysisJson:'{"resultSkillMode":"no-skill"}'}},{...options,skills:[{id:'s',name:'skill',activeVersion:1}]}).skillIssues.length,0);
});
