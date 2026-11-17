import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import matter from 'gray-matter';
import ts from 'typescript';

const golden=JSON.parse(fs.readFileSync('test/fixtures/storage-core-trigger/original-derived-golden.json','utf8')) as {cases:Array<Record<string,unknown>>};
function builder(){
 const fixtureModule={exports:{}};const poison=new Proxy({},{get:()=>{throw Error('Pure Trigger builder read legacy dynamic/static authority');}});
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/engine/evaluation/derive-trigger-opt-points.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,{module:fixtureModule,exports:fixtureModule.exports,require:(name:string)=>name==='gray-matter'?matter:name==='@/lib/storage/prisma'?{prismaRaw:poison}:{listTriggerEvalRuns:()=>{throw Error('Pure builder read old Trigger history');}},Date,Set,Map,Math});
 return fixtureModule.exports as {buildTriggerOptPoint:(args:unknown,history:unknown[])=>Record<string,unknown>|null;TRIGGER_OPT_GENERATOR:string};
}
for(const item of golden.cases)test('original Trigger aggregate golden: '+item.id,()=>{
 const api=builder();const content='---\nname: fixture-trigger\ndescription: '+JSON.stringify(item.currentDescription)+'\n---\nFULL TESTED BODY';
 const actual=api.buildTriggerOptPoint({user:'legacy-alice',skillName:'fixture-trigger',skillVersion:0,triggerRunId:'public-run',skillVersionContent:content,results:item.results,passRate:item.passRate,truePositiveRate:item.truePositiveRate,falsePositiveRate:item.falsePositiveRate,runsPerQuery:3,triggerThreshold:.5},item.history as unknown[]);
 assert.deepEqual(actual?JSON.parse(JSON.stringify({generator:api.TRIGGER_OPT_GENERATOR,...actual})):null,item.expected);
});

for(const item of golden.cases)test('sealed Trigger packet keeps public Run identity and frozen history: '+item.id,()=>{
 const api=builder(),fixtureModule={exports:{}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/storage-core/trigger-derived.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,{module:fixtureModule,exports:fixtureModule.exports,require:(name:string)=>name==='gray-matter'?matter:api,Number});
 const history=(item.history as Array<Record<string,unknown>>).map(row=>({version:row.version,passRate:row.passRate,content:'---\ndescription: '+JSON.stringify(row.description)+'\n---\nOLD FROZEN BODY'}));
 const manifest={legacy_owner:'legacy-alice',skill:{id:'skill-a',name:'fixture-trigger',version:0,content:'---\ndescription: '+JSON.stringify(item.currentDescription)+'\n---\nFROZEN BODY'},params:{runsPerQuery:3,triggerThreshold:.5},history};
 const packet=(fixtureModule.exports as {buildCoreTriggerDerived:(work:unknown,manifest:unknown,report:unknown)=>{evaluations:Array<Record<string,unknown>>;skillIssues:Array<Record<string,unknown>>}}).buildCoreTriggerDerived({handle:{experiment_id:'original-public-run',attempt_id:'recovery-attempt'}},manifest,{items:item.results,passRate:item.passRate,truePositiveRate:item.truePositiveRate,falsePositiveRate:item.falsePositiveRate});
 assert.equal(packet.skillIssues.length,item.shouldWrite?1:0);assert.equal(packet.evaluations.length,packet.skillIssues.length);
 if(item.shouldWrite){const evaluation=packet.evaluations[0],issue=packet.skillIssues[0];assert.equal(evaluation.runId,'original-public-run');assert.equal(evaluation.executionId,null);assert.equal(evaluation.user,'legacy-alice');assert.equal(evaluation.version,0);assert.equal(issue.evaluationId,evaluation.id);const expected=item.expected as Record<string,unknown>;for(const key of Object.keys(expected))assert.deepEqual(key==='generator'?evaluation[key]:issue[key],expected[key]);}
});
