import assert from 'node:assert/strict';
import test from 'node:test';
import {isolateTestDatabase} from './helpers/isolated-test-db';
isolateTestDatabase('collector-graph');
import * as original from '../src/lib/storage/data-service';
import * as core from '../src/lib/storage-core/collector-preparation';
import golden from './fixtures/collector-preparation-golden.json';
const at='2026-11-17T00:00:00.000Z';
function setup(data:any){const reservation:any={trace_id:'root-trace',task_id:data.task_id,execution_id:data.upload_id||data.task_id,operation_key:'graph',operation:'snapshot',state:'reserved',input_hash:'a'.repeat(64),base_revision:'0',source_revision:'0',received_at_ms:Date.parse(at),completed_at_ms:null,operation_request:{data},provenance:{legacy_username:'collector-golden-owner',framework:data.framework},snapshot:null};const frozen:any={version:1,actor:{principal:'p',workspace:'w',username:'collector-golden-owner'},binding:core.collectorPreparationBinding(reservation),configs:[],skills:[],active_skill_versions:{},evaluation_results:{},settings:{autoEvaluationEnabled:false},allow_snapshot_shrink:true,execution_match:null,thread_id:null};return {reservation,frozen};}
function noClock(value:any):any{if(Array.isArray(value))return value.map(noClock);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!/(?:timeInfo|timing|timestamp|createdAt|completedAt|startedAt|endedAt|started_at|ended_at|startTime|endTime)/i.test(k)).map(([k,v])=>[k,noClock(v)]));return value;}

test('derived plans preserve fields that the original child upsert does not write and seal each child Session representation',async()=>{
 const item=golden.cases.find((c:any)=>c.children?.length) as any;assert.ok(item);
 const {reservation,frozen}=setup(structuredClone(item.input));const initial:any=await core.prepareCoreCollectorSnapshot(reservation,frozen);const child=initial.children[0];
 const previous={...child.snapshot.execution,answerScore:77,isAnswerCorrect:false,judgmentReason:'original reason',label:'manual label',cost:0.4,sourceKind:'prior origin'};
 frozen.graph_context={version:1,children:[{execution_id:previous.id,task_id:previous.taskId,source_revision:'1',snapshot:{execution:previous,session:child.snapshot.session},session_json:JSON.stringify(child.snapshot.session),execution_skills:[]}],retire_candidates:[],sweep:true,root_execution_skills:[]};
 const result:any=await core.prepareCoreCollectorSnapshot(reservation,frozen);for(const key of ['answerScore','isAnswerCorrect','judgmentReason','label','cost','sourceKind'])assert.deepEqual(result.children[0].snapshot.execution[key],(previous as any)[key],key);
 assert.equal(result.children[0].serialized_session_json,JSON.stringify(result.children[0].snapshot.session));assert.notEqual(result.children[0].serialized_session_json,result.serialized_session_json);
});

test('derived Session without a source clock keeps its first Session start while its Execution uses the current fallback',async()=>{
 const item=golden.cases.find((c:any)=>c.children?.length) as any;const data=noClock(item.input);const {reservation,frozen}=setup(data);
 const preview=original.prepareSubagentExecutions({parentExecutionId:reservation.execution_id,parentTaskId:reservation.task_id,parentFramework:data.framework,parentUser:frozen.actor.username,interactions:data.interactions},at);assert.ok(preview.children.length);assert.equal(preview.children[0].sessionHasStart,false);
 const first:any=await core.prepareCoreCollectorSnapshot(reservation,frozen);const child=first.children[0];const oldSession={...child.snapshot.session,startTime:'2026-01-01T00:00:00.000Z',endTime:'2026-01-01T00:00:01.000Z'};
 frozen.graph_context={version:1,children:[{execution_id:child.snapshot.execution.id,task_id:child.snapshot.execution.taskId,source_revision:'1',snapshot:{execution:child.snapshot.execution,session:oldSession},session_json:JSON.stringify(oldSession),execution_skills:[]}],retire_candidates:[],sweep:true,root_execution_skills:[]};
 const value:any=await core.prepareCoreCollectorSnapshot(reservation,frozen);assert.equal(value.children[0].snapshot.session.startTime,oldSession.startTime);assert.equal(value.children[0].snapshot.session.endTime,oldSession.endTime);assert.equal(value.children[0].snapshot.execution.timestamp,at);
});

test('ThreadOnly private plan uses snapshot authority and creates no Trace snapshot',()=>{
 const prepare=(core as any).prepareCoreCollectorThread;assert.equal(typeof prepare,'function');
 const data={threadOnly:true,framework:'codex',traceThread:{sourceThreadId:'source',events:[{eventKey:'one',kind:'turn',startedAt:at,payload:{z:0,a:null}}]}};
 const {reservation,frozen}=setup(data);Object.assign(reservation,{trace_id:null,task_id:null,execution_id:null,operation:'thread_only'});frozen.binding=core.collectorPreparationBinding(reservation);frozen.thread_id='thread';
 const value=prepare(reservation,frozen);assert.equal(value.snapshot,null);assert.equal(value.thread.thread.id,'thread');assert.equal(value.thread.events[0].payloadJson,'{"z":0,"a":null}');assert.deepEqual(value.children,[]);
});

test('original Skill origin selection keeps prior valid locators while applying incoming version and validation rules',()=>{
 const prepare=(original as any).prepareExecutionSkills;assert.equal(typeof prepare,'function');
 const prior=[{skillName:'s',skillVersion:0,isPrimary:true,origin:{clientId:'c',platform:'opencode',targetMode:'execution_origin',originRef:'origin_0123456789abcdef01234567',displayPath:'before',observedSkillVersion:0}}];
 const value=prepare([{name:'s',version:0},{name:'s',version:0}],{user:'alice',primaryName:'s'},prior);assert.equal(value.length,1);assert.equal(value[0].origin.originRef,prior[0].origin.originRef);assert.equal(value[0].isPrimary,true);
 const incoming=prepare([{name:'s',version:0}],{origins:[{skillName:'s',skillVersion:0,clientId:'new',platform:' OPENCODE ',targetMode:'execution_origin',originRef:'origin_0123456789abcdef01234567',displayPath:'after'}]},prior);assert.equal(incoming[0].origin.clientId,'new');assert.equal(incoming[0].origin.platform,'opencode');
 assert.equal(prepare([{name:'s',version:0}],{origins:[{skillName:'s',clientId:'new',platform:'opencode',targetMode:'execution_origin',originRef:'bad'}]},prior)[0].origin,null);
});
