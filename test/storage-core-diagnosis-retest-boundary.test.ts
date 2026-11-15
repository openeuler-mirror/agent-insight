import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
test('diagnosis retest boundary preserves live IAM and frozen-model failure statuses without legacy source queries',async()=>{
 for(const status of [403,409,503]){const cause=Object.assign(new Error('domain failure'),{status});let old=0;const module={exports:{}};
 const record={id:'record',sourceKind:'diagnosis',sourceExperimentId:'source',candidateFilesJson:'{"SKILL.md":"candidate"}',status:'pending_retest'};
 vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/skill-workbench/retest-service.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,console,require:(name:string)=>{
 if(name.endsWith('/mode'))return {isStorageCoreEnabled:()=>true};if(name.endsWith('/experiments'))return {requireCoreExperimentContext:()=>({actor:{username:'trusted'},rpc:async()=>({experiment:{id:'source',scope:''}})})};
 if(name.endsWith('/diagnosis/retest'))return {retestDiagnosisCase:async()=>{throw cause;}};
 if(name.endsWith('/prisma'))return {prismaRaw:{skillOptimizationRecord:{findFirst:async()=>record},experiment:{findFirst:async()=>{old++;throw Error('Legacy Experiment access');}}}};
 return {};
 }});
 await assert.rejects((module.exports as any).retestOptimizationCandidate({user:'trusted',skillName:'skill',recordId:'record'}),(error:any)=>error===cause);assert.equal(old,0);
 }
});
