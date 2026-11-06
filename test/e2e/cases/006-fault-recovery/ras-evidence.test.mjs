import test from 'node:test';import assert from 'node:assert/strict';
import {requiredStagesFor,scenarioResult} from '../../shared/core.mjs';
const mod=await import('./ras-evidence.mjs').catch(()=>({}));
const expected={user:'test-user',clientId:'client-1',datasetId:'dataset-1',caseId:'case-1',taskId:'ses-main'};
function evidence(){return {run:{user:expected.user,workerId:expected.clientId,sessionTaskId:expected.taskId,fault:'thinking-dead-loop',submode:'2',faultActivated:true,status:'completed',stopRequested:false},events:[{id:'a',user:expected.user,taskId:expected.taskId,type:'anomaly',anomalyKind:'llm_thinking_loop',ts:1000,payloadJson:'{}'},{id:'b',user:expected.user,taskId:expected.taskId,type:'action_result',ts:1100,payloadJson:JSON.stringify({action:'abort_stream',ok:true,channel:'session.abort'})}],nativeEvents:[{type:'text',sessionID:expected.taskId,part:{text:'明白，我先看看当前磁盘状况和之前的工作上下文，再开始测试。'.repeat(80)}},{type:'error',sessionID:expected.taskId,timestamp:1200,error:{name:'MessageAbortedError',data:{message:'Aborted'}}}],protectedStop:false};}
test('006 cannot pass with only installation or missing recovery evidence',()=>{const required=requiredStagesFor('006');assert.ok(required.includes('recovery'));assert.ok(required.includes('ras-evidence'));assert.equal(scenarioResult(required.map(id=>({id,status:'PASS'})),'006').status,'PASS');assert.equal(scenarioResult(required.filter(id=>id!=='recovery').map(id=>({id,status:'PASS'})),'006').status,'PARTIAL');});
test('real fault, matching detection, successful native abort and session form a proof',()=>{assert.equal(typeof mod.assertRasEvidence,'function');assert.equal(mod.assertRasEvidence(evidence(),expected).taskId,expected.taskId);});
test('planned or failed action and natural completion cannot prove recovery',()=>{assert.equal(typeof mod.assertRasEvidence,'function');for(const change of [x=>x.events.pop(),x=>x.events[1].payloadJson=JSON.stringify({action:'abort_stream',ok:false}),x=>x.nativeEvents.pop(),x=>x.protectedStop=true,x=>x.run.stopRequested=true,x=>x.run.faultActivated=false,x=>x.nativeEvents[0].part.text='任务成功']){const x=evidence();change(x);assert.throws(()=>mod.assertRasEvidence(x,expected));}});
test('evidence for another user, client, session or later detection is rejected',()=>{assert.equal(typeof mod.assertRasEvidence,'function');for(const change of [x=>x.run.user='other',x=>x.run.workerId='other',x=>x.events[0].taskId='other',x=>x.events[1].user='other',x=>x.nativeEvents[1].sessionID='other',x=>x.events[0].ts=2000]){const x=evidence();change(x);assert.throws(()=>mod.assertRasEvidence(x,expected));}});
test('006 request must contain only selected reliability case and evaluator',()=>{assert.equal(typeof mod.assertRasRequest,'function');const p={datasetId:'dataset-1',datasetCaseIds:['case-1'],traceSource:'generate',agentTimeoutSeconds:300,executionTarget:{workerId:'client-1',platform:'opencode',agent:'build',model:'e2e/deepseek-flash'},evaluatorIds:['preset-ras-reliability-detection-recovery'],configSnapshot:{fiOrchestrate:true}};assert.doesNotThrow(()=>mod.assertRasRequest(p,expected));for(const changed of [{...p,datasetCaseIds:['case-1','other']},{...p,configSnapshot:{fiOrchestrate:false}},{...p,agentTimeoutSeconds:3600},{...p,executionTarget:{...p.executionTarget,workerId:'other'}}])assert.throws(()=>mod.assertRasRequest(changed,expected));});
test('unknown or absent reliability dimension never passes',()=>{assert.equal(typeof mod.assertRasEvaluation,'function');const d={status:'done',cases:[{id:'case-result',taskId:'ses-main'}],results:[{caseId:'case-result',evaluatorId:'preset-ras-reliability-detection-recovery',status:'done',score:100,summary:'真实证据支持检测和中断',points:['故障检测','触发处置','故障消解'].map(label=>({label,status:'covered',score:100}))}]};assert.equal(mod.assertRasEvaluation(d,expected).score,100);d.results[0].points.pop();assert.throws(()=>mod.assertRasEvaluation(d,expected));});

test('006 rejects delayed abort beyond the 60 second containment budget',()=>{const x=evidence();x.nativeEvents[1].timestamp=62001;x.events[1].ts=62000;assert.throws(()=>mod.assertRasEvidence(x,expected));});
test('006 uses original anomaly timestamp instead of asynchronous server ingest time',()=>{const x=evidence();x.events[0].ts=1400;x.events[0].payloadJson=JSON.stringify({timestamp:1000});assert.equal(mod.assertRasEvidence(x,expected).detectedAt,1000);});
test('006 accepts interrupted partial output from native Trace only with exact anomaly anchors',()=>{const x=evidence();const text=x.nativeEvents.shift().part.text;x.events[0].payloadJson=JSON.stringify({timestamp:1000,trace_anchor:{message_id:'m1',part_id:'p1'}});x.nativeSession={taskId:expected.taskId,user:expected.user,interactions:[{role:'assistant',messageID:'m1',parts:[{id:'p1',type:'text',text}]}]};assert.equal(mod.assertRasEvidence(x,expected).nativeFaultChars,text.length);for(const change of [y=>y.nativeSession.user='other',y=>y.nativeSession.taskId='other',y=>y.nativeSession.interactions[0].messageID='other',y=>y.nativeSession.interactions[0].parts[0].id='other']){const y=structuredClone(x);change(y);assert.throws(()=>mod.assertRasEvidence(y,expected));}});

test('FI completion and interrupted generation are separate and require same-session native evidence',()=>{
 assert.equal(typeof mod.assertFiNativeInterruption,'function');
 const manifest={exit_code:0,termination_reason:'fault_intercepted',agent_execution_status:'interrupted'};
 const native=evidence().nativeEvents;const proof=mod.assertFiNativeInterruption(manifest,native,expected.taskId);assert.equal(proof.exitCode,0);assert.equal(proof.agentExecutionStatus,'interrupted');
 for(const changed of [{...manifest,agent_execution_status:'finished'},{...manifest,termination_reason:'process_exited'},{...manifest,termination_reason:'timeout'}])assert.throws(()=>mod.assertFiNativeInterruption(changed,native,expected.taskId));
 assert.throws(()=>mod.assertFiNativeInterruption(manifest,native,'ses-other'));
 assert.throws(()=>mod.assertFiNativeInterruption(manifest,native.filter(e=>e.type!=='error'),expected.taskId));
});

function terminatingEvidence(){
 const x=evidence(),text=x.nativeEvents.shift().part.text,anchor={message_id:'m1',part_id:'p1',channel:'llm_output'};
 x.events[0].ts=1101;x.events[0].payloadJson=JSON.stringify({trace_anchor:anchor});x.events[1].payloadJson=JSON.stringify({action:'abort_stream',ok:true,phase:'terminating',channel:'session.abort',trace_anchor:anchor});
 x.nativeSession={taskId:expected.taskId,user:expected.user,interactions:[{role:'assistant',messageID:'m1',parts:[{id:'p1',type:'text',text}]}]};return x;
}
test('pre-abort terminating receipt may be ingested before its matching queued anomaly',()=>{
 const proof=mod.assertRasEvidence(terminatingEvidence(),expected);assert.equal(proof.orderingBasis,'terminating_receipt_and_native_anchor');assert.ok(proof.receiptAt<proof.detectedAt);
});
test('terminating receipt cannot prove success without exact anchor, native stop or when a failure was reported',()=>{
 for(const change of [x=>{const p=JSON.parse(x.events[1].payloadJson);p.trace_anchor.part_id='other';x.events[1].payloadJson=JSON.stringify(p)},x=>delete x.nativeSession,x=>x.nativeEvents.pop(),x=>x.nativeEvents[0].timestamp=1000,x=>x.events.push({...x.events[1],id:'failure',payloadJson:JSON.stringify({...JSON.parse(x.events[1].payloadJson),ok:false,phase:'failed'})})]){const x=terminatingEvidence();change(x);assert.throws(()=>mod.assertRasEvidence(x,expected));}
});
test('original client detection timestamp remains authoritative for terminating receipts',()=>{
 const x=terminatingEvidence();x.events[0].payloadJson=JSON.stringify({...JSON.parse(x.events[0].payloadJson),timestamp:2000});assert.throws(()=>mod.assertRasEvidence(x,expected));
});
