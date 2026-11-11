import {executionModel} from '../../shared/model-config.mjs';
import assert from 'node:assert/strict';
import {poll} from '../../shared/runtime.mjs';
export const RAS_EVALUATOR='preset-ras-reliability-detection-recovery';
const time=value=>typeof value==='number'?value:Date.parse(value);
function evidenceCounts(events){
 const actionResults=events.filter(e=>e.type==='action_result');
 return {anomalies:events.filter(e=>e.type==='anomaly').length,anomalyKinds:[...new Set(events.filter(e=>e.type==='anomaly').map(e=>e.anomalyKind))],thinkingDetections:events.filter(e=>e.type==='anomaly'&&['llm_thinking_loop','llm_thinking_dead_loop'].includes(e.anomalyKind)).length,actionResults:actionResults.length,successfulAborts:actionResults.filter(e=>{try{const p=JSON.parse(e.payloadJson);return p.action==='abort_stream'&&p.ok===true&&String(p.channel).includes('session.abort');}catch{return false;}}).length};
}
export async function waitForRasEvidence(readEvents,{timeoutMs=60000,intervalMs=1000}={}){
 let latest=[];
 try{return await poll(async()=>latest=await readEvents(),rows=>{const counts=evidenceCounts(rows);return counts.thinkingDetections>0&&counts.successfulAborts>0;},timeoutMs,intervalMs);}
 catch(error){throw new Error('Incomplete RAS evidence: '+JSON.stringify(evidenceCounts(latest)),{cause:error});}
}
export function assertRasRequest(payload,expected){
 assert.equal(payload.datasetId,expected.datasetId);assert.deepEqual(payload.datasetCaseIds,[expected.caseId]);assert.equal(payload.traceSource,'generate');assert.equal(payload.configSnapshot?.fiOrchestrate,true);assert.equal(payload.agentTimeoutSeconds,300);
 assert.deepEqual(payload.evaluatorIds,[RAS_EVALUATOR]);for(const [k,v] of Object.entries({workerId:expected.clientId,platform:'opencode',agent:'build',model:executionModel()}))assert.equal(payload.executionTarget?.[k],v);return {caseId:expected.caseId,clientId:expected.clientId};
}
export function assertFiNativeInterruption(manifest,nativeEvents,taskId){
 assert.equal(manifest.termination_reason,'fault_intercepted','FI must classify native abort before zero process exit');
 assert.equal(manifest.agent_execution_status,'interrupted','Native abort cannot be classified as finished');
 const event=nativeEvents.find(e=>e.type==='error'&&e.sessionID===taskId&&e.error?.name==='MessageAbortedError'&&e.error?.data?.message==='Aborted');
 assert.ok(event,'FI interruption requires the current native session abort');
 return {taskId,exitCode:manifest.exit_code,terminationReason:manifest.termination_reason,agentExecutionStatus:manifest.agent_execution_status,nativeAbortTimestamp:event.timestamp};
}
export function assertRasEvidence({run,events,nativeEvents,nativeSession,protectedStop},expected){
 assert.equal(run.user,expected.user);assert.equal(run.workerId,expected.clientId);assert.equal(run.sessionTaskId,expected.taskId);assert.equal(run.fault,'thinking-dead-loop');assert.equal(String(run.submode),'2');assert.equal(run.status,'completed');assert.equal(Boolean(run.faultActivated),true);assert.ok(!run.stopRequested&&!protectedStop,'Test protection cannot count as RAS recovery');
 assert.ok(events.length);for(const event of events){assert.equal(event.user,expected.user);assert.equal(event.taskId,expected.taskId);}
 const detection=events.find(e=>e.type==='anomaly'&&['llm_thinking_loop','llm_thinking_dead_loop'].includes(e.anomalyKind));assert.ok(detection,'No real thinking loop detection');
 const receipts=events.filter(e=>e.type==='action_result').map(e=>({...e,payload:JSON.parse(e.payloadJson)}));const abort=receipts.find(e=>e.payload.action==='abort_stream'&&e.payload.ok===true&&String(e.payload.channel).includes('session.abort'));assert.ok(abort,'No successful native abort receipt');
 let text=nativeEvents.filter(e=>e.type==='text'&&e.sessionID===expected.taskId).map(e=>e.part?.text||'').join('');
 if(nativeSession){assert.equal(nativeSession.taskId,expected.taskId);assert.equal(nativeSession.user,expected.user);const anchor=JSON.parse(detection.payloadJson).trace_anchor;assert.ok(anchor?.message_id&&anchor?.part_id,'Native Trace requires anomaly anchors');const message=nativeSession.interactions.find(m=>m.role==='assistant'&&m.messageID===anchor.message_id);assert.ok(message,'Anomaly message absent from native Trace');const part=message.parts?.find(p=>p.id===anchor.part_id&&p.type==='text');assert.ok(part&&typeof part.text==='string','Anomaly text part absent from native Trace');text=part.text;}
 assert.ok(text.length>=1000,'Insufficient native fault output');assert.ok((text.match(/磁盘|上下文/g)||[]).length>=10,'Fault text not actually observed');
 const stopped=nativeEvents.find(e=>e.type==='error'&&e.sessionID===expected.taskId&&e.error?.name==='MessageAbortedError'&&e.error?.data?.message==='Aborted');assert.ok(stopped,'Native stream was not aborted');
 const anomaly=JSON.parse(detection.payloadJson);const detectedAt=time(anomaly.timestamp>0?anomaly.timestamp:detection.ts),receiptAt=time(abort.ts),stoppedAt=time(stopped.timestamp);assert.ok(Number.isFinite(detectedAt)&&Number.isFinite(receiptAt)&&Number.isFinite(stoppedAt),'Missing event timestamps');assert.ok(!receipts.some(e=>e.payload.action==='abort_stream'&&(e.payload.ok===false||e.payload.phase==='failed')),'Native abort has a contradictory failure receipt');
 const terminating=abort.payload.phase==='terminating'&&!(anomaly.timestamp>0);
 if(terminating){assert.ok(nativeSession,'Pre-abort receipt requires the persisted native Trace');assert.deepEqual(abort.payload.trace_anchor,anomaly.trace_anchor,'Receipt and detection reference different native anchors');assert.ok(stoppedAt>=receiptAt,'Native stop preceded the pre-abort receipt');assert.ok(Math.abs(detectedAt-receiptAt)<=60000,'Queued detection and pre-abort receipt do not correlate');}
 else assert.ok(receiptAt>=detectedAt&&stoppedAt>=detectedAt,'Abort did not follow detection');
 assert.ok(Math.abs(stoppedAt-detectedAt)<=60000,'Containment exceeded 60 second budget');assert.ok(Math.abs(stoppedAt-receiptAt)<=60000,'Native abort and receipt do not correlate');
 return {taskId:expected.taskId,runId:run.runId,detectedEventId:detection.id,abortEventId:abort.id,detectedAt,receiptAt,stoppedAt,nativeFaultChars:text.length,orderingBasis:terminating?'terminating_receipt_and_native_anchor':anomaly.timestamp>0?'client_detection_timestamp':'legacy_server_order',abortChannel:abort.payload.channel,protectedStop:false};
}
export function assertRasEvaluation(detail,expected){
 assert.equal(detail.status,'done');assert.equal(detail.cases.length,1);const item=detail.cases[0];assert.equal(item.taskId,expected.taskId);const values=detail.results.filter(r=>r.caseId===item.id);assert.equal(values.length,1);const value=values[0];assert.equal(value.evaluatorId,RAS_EVALUATOR);assert.equal(value.status,'done');assert.equal(value.score<=1?value.score*100:value.score,100);assert.ok(value.summary?.trim());const points=value.points||JSON.parse(value.pointsJson||'[]');for(const label of ['故障检测','触发处置','故障消解']){const matches=points.filter(p=>p.label===label);assert.equal(matches.length,1,`Missing dimension ${label}`);assert.equal(matches[0].status,'covered');assert.equal(matches[0].score,100);}return {experimentId:detail.id,taskId:expected.taskId,score:value.score,points,summary:value.summary};
}
