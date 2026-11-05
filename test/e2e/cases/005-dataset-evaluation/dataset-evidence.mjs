import {parseSummaryJson} from '../../shared/summary-json.mjs';
import {executionModel} from '../../shared/model-config.mjs';
import assert from 'node:assert/strict';
import {assertNativeSkillBinding} from '../004-trace-evaluation/trace-only-evidence.mjs';
import {readExperimentDatasetCaseBinding} from '../../../../src/lib/engine/experiment/dataset-case-binding.ts';
export function assertDatasetRequest(payload,expected){
 assert.equal(payload.datasetId,expected.datasetId);assert.equal(payload.version,expected.version);assert.equal(payload.traceSource,'generate');assert.deepEqual(payload.caseIds,[expected.case.id]);assert.deepEqual(payload.evaluatorIds,['preset-agent-task-completion']);
 assert.equal(payload.executionTarget.workerId,expected.clientId);assert.equal(payload.executionTarget.platform,'opencode');assert.equal(payload.executionTarget.agent,'build');assert.equal(payload.executionTarget.model,executionModel());
 if(expected.executionTarget)for(const [key,value] of Object.entries(expected.executionTarget))assert.deepEqual(payload.executionTarget[key],value,`Execution option changed: ${key}`);
}
export function assertDatasetFacts(answer,truth){
 assert.match(answer,new RegExp(`(?<!\\d)${truth.rootFailures}(?!\\d)`));
 for(const [source,count] of truth.topSources.slice(0,5)){const escaped=source.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');assert.match(answer,new RegExp(`${escaped}[^\\d\\n;；]{0,80}${count}(?!\\d)`),`Root source/count missing: ${source}/${count}`);}
 return {root_ssh_failures:truth.rootFailures,topSources:truth.topSources.slice(0,5)};
}
export function assertDatasetResult(detail,expected){
 assert.equal(detail.status,'done');assertDatasetRequest({...detail.configSnapshot,version:detail.skillVersion??detail.configSnapshot.version},expected);assert.equal(detail.cases.length,1);
 const item=detail.cases[0];assert.ok(item.taskId&&!expected.oldTaskIds.includes(item.taskId),'Expected fresh business Trace');assert.equal(item.input,expected.case.input);assert.equal(item.datasetInput,expected.case.input);assert.equal(item.referenceOutput,expected.case.expectedOutput);
 const values=item.caseValues||JSON.parse(item.caseValuesJson||'{}');assert.deepEqual(readExperimentDatasetCaseBinding(values)||readExperimentDatasetCaseBinding(expected.caseBindings?.[item.id]),{datasetId:expected.datasetId,caseId:expected.case.id});
 const results=detail.results.filter(r=>r.caseId===item.id);assert.equal(results.length,1);const result=results[0];assert.equal(result.evaluatorId,'preset-agent-task-completion');assert.equal(result.status,'done');assert.ok(Number.isFinite(result.score));const score=result.score<=1?result.score*100:result.score;assert.ok(score>=80&&score<=100);assert.ok(result.summary?.trim());
 const points=result.points||JSON.parse(result.pointsJson||'[]');const coreReferenceCoverage=(expected.case.rootCauses||[]).map(reference=>{const point=points.find(p=>p.label===reference.content||p.label?.length>=Math.min(30,reference.content.length)&&reference.content.startsWith(p.label));if(expected.requireCoverage){assert.ok(point,`Reference point missing: ${reference.content}`);assert.equal(point.status,'covered',`Reference point not covered: ${reference.content}`);}return {label:reference.content,status:point?.status||'unknown',score:point?.score??null};});
 if(expected.requireCoverage){assert.ok(coreReferenceCoverage.length,'Derived reference points missing');assert.ok(points.length);for(const point of points)assert.equal(point.status,'covered','Candidate reference deviations remain');}
 return {experimentId:detail.id,caseId:expected.case.id,experimentCaseId:item.id,taskId:item.taskId,score,evaluatorId:result.evaluatorId,summary:result.summary,coreReferenceCoverage,facts:assertDatasetFacts(item.actualOutput,expected.truth)};
}
export function assertDatasetSummary(answer,truth){
 assertDatasetFacts(answer.split('E2E-SUMMARY')[0],truth);const value=parseSummaryJson(answer);assert.deepEqual(value,{total_lines:truth.totalLines,root_ssh_failures:truth.rootFailures,top_source:truth.topSources[0][0],top_source_failures:truth.topSources[0][1]});return value;
}
export function assertDatasetScriptTrace(tools,logFile,log,truth){
 const called=tools.filter(t=>{const args=String(t.function?.arguments||'');return args.includes(logFile)&&args.includes('analyze_logs.py')&&/python3?\s/.test(args);});assert.ok(called.length,'Actual script invocation missing');
 const values=called.flatMap(t=>String(t.output||'').split('\n').flatMap(line=>{try{const value=JSON.parse(line);return value&&Array.isArray(value.evidence)?[value]:[];}catch{return [];}}));assert.ok(values.length,'Actual script JSON output missing');
 const result=values.at(-1);assert.deepEqual({total_lines:result.total_lines,root_ssh_failures:result.root_ssh_failures,top_source:result.top_source,top_source_failures:result.top_source_failures},{total_lines:truth.totalLines,root_ssh_failures:truth.rootFailures,top_source:truth.topSources[0][0],top_source_failures:truth.topSources[0][1]});
 assert.deepEqual(result.top_sources,truth.topSources.slice(0,5).map(([source,count])=>({source,count})));assert.ok(result.evidence.length);const lines=new Set(log.split(/\r?\n/));for(const line of result.evidence){assert.ok(lines.has(line),'Script evidence is absent from original log');assert.ok(line.includes('authentication failure;')&&/(?:^|\s)user=root(?:\s|$)/.test(line));}return result;
}
export function assertDatasetCandidate(base,candidate,truth,forbidden=[]){
 assert.deepEqual(Object.keys(candidate).sort(),Object.keys(base).sort());for(const key of Object.keys(base).filter(key=>key!=='SKILL.md'))assert.equal(candidate[key],base[key],`Unexpected script change: ${key}`);
 const content=candidate['SKILL.md'];let cursor=0;const insertions=[];
 for(const line of base['SKILL.md'].split(/\r?\n/).filter(line=>line.trim())){const position=content.indexOf(line,cursor);assert.ok(position>=cursor,'Candidate removed or reordered baseline instructions');insertions.push(content.slice(cursor,position));cursor=position+line.length;}
 insertions.push(content.slice(cursor));const addition=insertions.join('\n');for(const field of ['E2E-SUMMARY','total_lines','root_ssh_failures','top_source','top_source_failures'])assert.ok(addition.includes(field));
 for(const value of [...forbidden,...truth.topSources.map(([host])=>host)].filter(Boolean))assert.ok(!addition.includes(value),`Candidate memorized test-specific value: ${value}`);
 for(const number of [truth.totalLines,truth.rootFailures,truth.topSources[0][1]])assert.doesNotMatch(addition,new RegExp(`(?<!\\d)${number}(?!\\d)`),'Candidate memorized expected statistic');
 return {preservedFiles:Object.keys(base),baselineInstructionsPreserved:true,appendOnly:content.startsWith(base['SKILL.md']),hardcodedTestValues:false};
}
export function assertScopedVerificationAttempts(fresh,rows,expected){
 assert.ok(fresh.includes(expected.baselineTaskId)&&fresh.includes(expected.candidateTaskId));const extra=fresh.filter(id=>![expected.baselineTaskId,expected.candidateTaskId].includes(id));const attempts=[];
 for(const taskId of extra){const found=rows.filter(row=>row.taskIds.includes(taskId));assert.equal(found.length,1,'Untracked additional business execution');const row=found[0],snapshot=row.snapshot,proof=snapshot.verification;
 assert.equal(row.user,expected.user);assert.equal(row.optimizationRecordId,expected.recordId);assert.equal(row.sourceExperimentId,expected.sourceExperimentId);assert.equal(row.status,'done');assertDatasetRequest({...snapshot,version:expected.version},expected);assert.equal(snapshot.verificationOnly,true);assert.equal(proof?.version,1);assert.equal(proof.datasetId,expected.datasetId);assert.deepEqual(proof.caseIds,[expected.case.id]);assert.equal(proof.inputHash,expected.datasetHash);assert.ok(proof.candidateHash);assert.equal(proof.result.measured,1);assert.equal(proof.result.fullCoverage,true);assert.ok(!proof.result.incomplete&&!proof.result.skipped);
 attempts.push({taskId,experimentId:row.id,candidateHash:proof.candidateHash,relativeScorePassed:proof.result.ok,score:proof.result.candMean,classification:'Actual product candidate verification attempt; retained as business execution, not final candidate PASS'});
 }return attempts;
}

export function assertDatasetTraceBinding(record,tools,{name,version,candidateRun=false}){return assertNativeSkillBinding(record,tools,{name,version:candidateRun?version+1:version});}
