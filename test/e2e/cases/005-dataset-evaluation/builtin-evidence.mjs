import {executionModel} from '../../shared/model-config.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {stableHash} from '../../shared/skill-archive.mjs';
import {assertSnapshot} from '../../shared/skill-evidence.mjs';
import {deriveRootSshTruth} from './builtin-truth.mjs';
import {readExperimentDatasetCaseBinding} from '../../../../src/lib/engine/experiment/dataset-case-binding.ts';
const fixture=JSON.parse(fs.readFileSync(new URL('../../../../src/server/builtin-example/fixtures.json',import.meta.url)));
const bundle=JSON.parse(fs.readFileSync(new URL('../../../../src/server/builtin-example/skill-bundle.json',import.meta.url)));
const originalCases=JSON.parse(fixture.dataset.casesJson);
export const BUILTIN_CASE_ID='951e0e4b-3eed-4d24-b1e6-83b0fb782be4';
export const BUILTIN_SKILL=bundle.name;
export const BUILTIN_DATASET='messages 日志分析（内置示例）';
export const BUILTIN_INPUT=originalCases.find(c=>c.id===BUILTIN_CASE_ID).input;
export class BuiltinSetupBlocked extends Error {constructor(message){super(message);this.code='E2E_BLOCKED';}}
export function assertBuiltinResources(dataset,skill,files,user,ownership){
 if(!dataset || !skill)throw new BuiltinSetupBlocked('Required builtin dataset or Skill was not seeded; no replacement will be created');
 assert.ok(dataset.id&&dataset.id!==fixture.dataset.id);assert.equal(dataset.user??ownership?.datasetUser,user);assert.equal(dataset.name,BUILTIN_DATASET);assert.equal(dataset.targetSkill,BUILTIN_SKILL);assert.equal(dataset.datasetKind,'ideal_output');assert.ok(dataset.tags.includes('内置示例'));
 if(!dataset.cases?.some(c=>c.id===BUILTIN_CASE_ID)||!skill.versions?.some(v=>v.version===0))throw new BuiltinSetupBlocked('Required builtin Case or v0 is missing');
 assert.equal(skill.name,BUILTIN_SKILL);assert.equal(skill.user??ownership?.skillUser,user);assert.equal(dataset.cases.length,originalCases.length);
 const keys=['id','input','expectedOutput','evaluationFocus','tags','trajectory','source','rootCauses'];
 for(const expected of originalCases){const actual=dataset.cases.find(c=>c.id===expected.id);assert.ok(actual);for(const key of keys)assert.deepEqual(actual[key],expected[key],`Builtin case changed: ${expected.id}/${key}`);}
 const expected=Object.fromEntries(bundle.files.map(file=>[file,file==='SKILL.md'?bundle.content:bundle.assets[file]]));const hashes=assertSnapshot(expected,files);
 return {datasetId:dataset.id,case:dataset.cases.find(c=>c.id===BUILTIN_CASE_ID),datasetHash:stableHash(dataset.cases),fileCount:Object.keys(files).length,hashes};
}
export function assertBuiltinRequest(payload,expected){
 assert.equal(payload.datasetId,expected.datasetId);assert.equal(payload.version,expected.version);assert.equal(payload.traceSource,'generate');assert.deepEqual(payload.caseIds,[BUILTIN_CASE_ID]);assert.deepEqual(payload.evaluatorIds,['preset-agent-task-completion']);
 assert.equal(payload.executionTarget.workerId,expected.clientId);assert.equal(payload.executionTarget.platform,'opencode');assert.equal(payload.executionTarget.agent,'build');assert.equal(payload.executionTarget.model,executionModel());
 if(expected.executionTarget)for(const [key,value] of Object.entries(expected.executionTarget))assert.deepEqual(payload.executionTarget[key],value,`Submitted execution option changed: ${key}`);
 return {datasetId:payload.datasetId,caseId:BUILTIN_CASE_ID,executionTarget:payload.executionTarget};
}
export function assertBuiltinFacts(answer,{requireTopSources=true}={}){
 assert.match(answer,/(?<!\d)351(?!\d)/);assert.ok(answer.includes('150.183.249.110'));assert.match(answer,/(?<!\d)80(?!\d)/);assert.match(answer,/高危|严重|高风险|暴力破解|爆破/);
 const sources=deriveRootSshTruth(fs.readFileSync(new URL('../../../../public/example/messages',import.meta.url),'utf8')).topSources.slice(0,5);
 const matched=([source,count])=>new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'[^\\d\\n;；]{0,80}'+count+'(?!\\d)').test(answer);
 assert.ok(matched(sources[0]),'Top source count missing');const missingSources=sources.filter(item=>!matched(item)).map(item=>item[0]);if(requireTopSources)assert.deepEqual(missingSources,[],'Final candidate omitted builtin core source facts');
 return {root_ssh_failures:351,top_source:'150.183.249.110',top_source_failures:80,missingSources};
}
export function assertBuiltinResult(detail,expected){
 assert.equal(detail.status,'done');assertBuiltinRequest({...detail.configSnapshot,version:detail.skillVersion??detail.configSnapshot.version},expected);assert.equal(detail.cases.length,1);
 const item=detail.cases[0];assert.ok(item.taskId&&!expected.oldTaskIds.includes(item.taskId),'Existing demo or baseline Trace cannot count as a fresh run');assert.equal(item.input,expected.case.input);assert.equal(item.datasetInput,expected.case.input);assert.equal(item.referenceOutput,expected.case.expectedOutput);
 const values=item.caseValues || JSON.parse(item.caseValuesJson||'{}');assert.deepEqual(readExperimentDatasetCaseBinding(values)||readExperimentDatasetCaseBinding(expected.caseBindings?.[item.id]),{datasetId:expected.datasetId,caseId:BUILTIN_CASE_ID});assertBuiltinFacts(item.actualOutput,{requireTopSources:expected.requireTopSources??false});
 const results=detail.results.filter(r=>r.caseId===item.id);assert.equal(results.length,1);const result=results[0];assert.equal(result.evaluatorId,'preset-agent-task-completion');assert.equal(result.status,'done');assert.ok(typeof result.score==='number'&&Number.isFinite(result.score));const score=result.score<=1?result.score*100:result.score;assert.ok(score>=80&&score<=100);assert.ok(result.summary?.trim());
 const coreReferenceCoverage=(expected.case.rootCauses||[]).slice(0,2).map(reference=>{const point=result.points?.find(p=>p.label?.length>=30&&reference.content.startsWith(p.label));if(expected.requireTopSources){assert.ok(point,'Core reference point missing');assert.equal(point.status,'covered','Final candidate retains a known core reference deviation');}return {label:reference.content,status:point?.status||'unknown',score:point?.score??null};});
 if(expected.requireTopSources)assert.equal(coreReferenceCoverage.length,2);
 return {experimentId:detail.id,caseId:BUILTIN_CASE_ID,experimentCaseId:item.id,taskId:item.taskId,score,evaluatorId:result.evaluatorId,summary:result.summary,coreReferenceCoverage,facts:assertBuiltinFacts(item.actualOutput,{requireTopSources:expected.requireTopSources??false})};
}
export function assertBuiltinSummary(answer){
 assertBuiltinFacts(answer.split('E2E-SUMMARY')[0]);const matches=[...answer.matchAll(/E2E-SUMMARY\s*[:：]?\s*(\{[^\n]*?\})/g)];assert.equal(matches.length,1);const value=JSON.parse(matches[0][1]);assert.deepEqual(value,{total_lines:2000,root_ssh_failures:351,top_source:'150.183.249.110',top_source_failures:80});return value;
}
