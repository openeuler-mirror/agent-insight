import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {requiredStagesFor,scenarioResult,stageFailureStatus} from '../../shared/core.mjs';
import {assertBuiltinResources,assertBuiltinRequest,assertBuiltinResult,assertBuiltinFacts,BUILTIN_CASE_ID,BUILTIN_INPUT} from './builtin-evidence.mjs';
const fixture=JSON.parse(fs.readFileSync(new URL('../../../../src/server/builtin-example/fixtures.json',import.meta.url)));
const bundle=JSON.parse(fs.readFileSync(new URL('../../../../src/server/builtin-example/skill-bundle.json',import.meta.url)));
const canonical=JSON.parse(fixture.dataset.casesJson);
const data=()=>({id:'new-owned-dataset',user:'test-owner',name:'messages 日志分析（内置示例）',targetSkill:bundle.name,datasetKind:'ideal_output',tags:['内置示例'],cases:structuredClone(canonical)});
const files=()=>Object.fromEntries(bundle.files.map(file=>[file,file==='SKILL.md'?bundle.content:bundle.assets[file]]));
const resources=()=>assertBuiltinResources(data(),{name:bundle.name,user:'test-owner',versions:[{version:0}]},files(),'test-owner');
const payload=()=>({datasetId:'new-owned-dataset',version:0,traceSource:'generate',caseIds:[BUILTIN_CASE_ID],evaluatorIds:['preset-agent-task-completion'],executionTarget:{workerId:'own-client',platform:'opencode',agent:'build',model:'e2e/deepseek-flash'}});

test('005 must finish all required stages, not just initialize or evaluate',()=>{
 const ids=requiredStagesFor('005');for(const id of ['dataset-fixture','dataset-ui','baseline','trace-ui','diagnosis','optimization','candidate','persistence'])assert.ok(ids.includes(id));
 const stages=ids.map(id=>({id,status:'PASS'}));assert.equal(scenarioResult(stages,'005').status,'PASS');for(const id of ids)assert.notEqual(scenarioResult(stages.filter(s=>s.id!==id),'005').status,'PASS');
});
test('missing seeded builtin resources is BLOCKED, never replaced or counted as pass',()=>{
 for(const fn of [()=>assertBuiltinResources(null,{},files(),'test-owner'),()=>assertBuiltinResources(data(),null,files(),'test-owner')]){let error;try{fn();}catch(e){error=e;}assert.ok(error);assert.equal(stageFailureStatus(error),'BLOCKED');}
 assert.equal(stageFailureStatus(new Error('ordinary failure')),'FAIL');
});
test('builtin identity binds owned real seed, original case/reference and complete v0 files',()=>{
 const proof=resources();assert.equal(proof.case.id,BUILTIN_CASE_ID);assert.equal(proof.case.input,BUILTIN_INPUT);assert.equal(proof.fileCount,13);
 for(const mutate of [d=>d.user='other',d=>d.id=fixture.dataset.id,d=>d.targetSkill='replacement',d=>d.tags=[],d=>d.cases[1].input='rewritten',d=>d.cases.find(c=>c.id===BUILTIN_CASE_ID).expectedOutput='easier answer']){const d=data();mutate(d);assert.throws(()=>assertBuiltinResources(d,{name:bundle.name,user:'test-owner',versions:[{version:0}]},files(),'test-owner'));}
 const snapshot=files();snapshot['SKILL.md']+=' modified';assert.throws(()=>assertBuiltinResources(data(),{name:bundle.name,user:'test-owner',versions:[{version:0}]},snapshot,'test-owner'));
});
test('single-case generation rejects existing traces, extra cases and another client/model/evaluator',()=>{
 const expected={datasetId:'new-owned-dataset',clientId:'own-client',version:0};assert.doesNotThrow(()=>assertBuiltinRequest(payload(),expected));
 for(const modify of [p=>p.traceSource='existing',p=>p.caseIds.push('extra'),p=>p.datasetId='foreign',p=>p.version=1,p=>p.executionTarget.workerId='other',p=>p.executionTarget.model='other',p=>p.evaluatorIds=['preset-task-completion-no-ref']]){const p=payload();modify(p);assert.throws(()=>assertBuiltinRequest(p,expected));}
});
test('generated result requires original dataset case, fresh session and a real completed score',()=>{
 const original=resources().case;const expected={datasetId:'new-owned-dataset',clientId:'own-client',version:0,case:original,oldTaskIds:['seed-trace']};
 const result=()=>({id:'new-experiment',status:'done',configSnapshot:{...payload(),executionTarget:payload().executionTarget},cases:[{id:'row',taskId:'new-native-session',datasetInput:original.input,input:original.input,referenceOutput:original.expectedOutput,actualOutput:'root 认证失败351次；150.183.249.110共80次，n219076184117.netvigator.com 23次，195.129.24.210 15次，207.243.167.114 23次，60.30.224.116 20次，风险高危。',caseValues:{__agentInsightDatasetCase:{datasetId:'new-owned-dataset',caseId:BUILTIN_CASE_ID}}}],results:[{caseId:'row',evaluatorId:'preset-agent-task-completion',status:'done',score:0.95,summary:'业务要求满足'}]});
 assert.equal(assertBuiltinResult(result(),expected).score,95);
 for(const modify of [d=>d.cases[0].taskId='seed-trace',d=>d.cases[0].input='rephrased',d=>d.cases[0].referenceOutput='changed',d=>d.results[0].score=0.79,d=>d.results[0].score=null,d=>d.status='partial',d=>d.cases.push({...d.cases[0],id:'other'})]){const d=result();modify(d);assert.throws(()=>assertBuiltinResult(d,expected));}
});

test('root SSH core answer uses actual root-event top-five sources rather than only one IP',()=>{
 const answer='高危：root 认证失败351次；150.183.249.110 80次；n219076184117.netvigator.com 23次；195.129.24.210 15次；207.243.167.114 23次；60.30.224.116 20次。';
 assert.doesNotThrow(()=>assertBuiltinFacts(answer));for(const source of ['n219076184117.netvigator.com','195.129.24.210','207.243.167.114','60.30.224.116'])assert.throws(()=>assertBuiltinFacts(answer.replace(source,'omitted')));
});

test('builtin candidate summary has exactly four actual fields without imposing a new format on the original case',async()=>{
 const {assertBuiltinSummary}=await import('./builtin-evidence.mjs');const text='高危：root351次；150.183.249.110 80次；n219076184117.netvigator.com 23次；195.129.24.210 15次；207.243.167.114 23次；60.30.224.116 20次。\nE2E-SUMMARY {"total_lines":2000,"root_ssh_failures":351,"top_source":"150.183.249.110","top_source_failures":80}';
 assert.equal(assertBuiltinSummary(text).total_lines,2000);for(const value of [text.replace('2000','1999'),text.replace('"total_lines":2000,',''),text+'\nE2E-SUMMARY {}'])assert.throws(()=>assertBuiltinSummary(value));
});

test('public dataset DTO may omit owner only when authoritative read-only ownership matches',()=>{
 const d=data();delete d.user;const skill={name:bundle.name,user:'test-owner',versions:[{version:0}]};
 assert.doesNotThrow(()=>assertBuiltinResources(d,skill,files(),'test-owner',{datasetUser:'test-owner',skillUser:'test-owner'}));
 for(const ownership of [undefined,{datasetUser:'other',skillUser:'test-owner'}])assert.throws(()=>assertBuiltinResources(d,skill,files(),'test-owner',ownership));
});

test('server may freeze extra runtime definitions while preserving every submitted execution option',()=>{
 const expected={datasetId:'new-owned-dataset',clientId:'own-client',version:0,executionTarget:payload().executionTarget};const p=payload();p.executionTarget.agentParameterDefinition={runtimeKey:'opencode',definitionDigest:'same-frozen-definition'};assert.doesNotThrow(()=>assertBuiltinRequest(p,expected));p.executionTarget.agent='other';assert.throws(()=>assertBuiltinRequest(p,expected));
});
test('baseline reference omissions remain explicit evidence, while final candidate must cover all core sources',()=>{
 const answer='高危：root认证失败351次；150.183.249.110 80次。';
 const facts=assertBuiltinFacts(answer,{requireTopSources:false});assert.equal(facts.missingSources.length,4);assert.throws(()=>assertBuiltinFacts(answer));
});

test('private Case binding stripped by API requires the actual scoped database proof',()=>{
 const item=resources().case,expected={datasetId:'new-owned-dataset',clientId:'own-client',version:0,case:item,oldTaskIds:[],caseBindings:{row:{__agentInsightDatasetCase:{datasetId:'new-owned-dataset',caseId:BUILTIN_CASE_ID}}}};
 const detail={id:'experiment',status:'done',configSnapshot:payload(),cases:[{id:'row',taskId:'fresh',input:item.input,datasetInput:item.input,referenceOutput:item.expectedOutput,actualOutput:'高危，root351次；150.183.249.110 80次。',caseValues:null}],results:[{caseId:'row',evaluatorId:'preset-agent-task-completion',status:'done',score:0.85,summary:'one source omitted'}]};
 assert.equal(assertBuiltinResult(detail,expected).score,85);assert.throws(()=>assertBuiltinResult(detail,{...expected,caseBindings:{}}));const foreign=structuredClone(expected);foreign.caseBindings.row.__agentInsightDatasetCase.datasetId='other';assert.throws(()=>assertBuiltinResult(detail,foreign));
});

test('final candidate cannot pass with a partial core reference point even when all IP strings appear and score exceeds 80',()=>{
 const item=resources().case,expected={datasetId:'new-owned-dataset',clientId:'own-client',version:0,case:item,oldTaskIds:[],requireTopSources:true};
 const points=item.rootCauses.slice(0,2).map(p=>({label:p.content.slice(0,160),score:100,status:'covered'}));
 const detail={id:'experiment',status:'done',configSnapshot:payload(),cases:[{id:'row',taskId:'fresh',input:item.input,datasetInput:item.input,referenceOutput:item.expectedOutput,actualOutput:'高危：root351次；150.183.249.110 80次；n219076184117.netvigator.com 23次；195.129.24.210 15次；207.243.167.114 23次；60.30.224.116 20次。',caseValues:{__agentInsightDatasetCase:{datasetId:'new-owned-dataset',caseId:BUILTIN_CASE_ID}}}],results:[{caseId:'row',evaluatorId:'preset-agent-task-completion',status:'done',score:0.95,summary:'core facts correct',points}]};
 assert.doesNotThrow(()=>assertBuiltinResult(detail,expected));for(const status of ['partial','missing']){const d=structuredClone(detail);d.results[0].points[1].status=status;assert.throws(()=>assertBuiltinResult(d,expected));}const empty=structuredClone(detail);empty.results[0].points=[];assert.throws(()=>assertBuiltinResult(empty,expected));
});
