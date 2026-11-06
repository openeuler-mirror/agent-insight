import assert from 'node:assert/strict';
import test from 'node:test';
import { requiredStagesFor, scenarioResult } from '../../shared/core.mjs';
import { assertTraceOnlyRequest, assertTraceOnlyResult, assertFourFieldSummary } from './trace-only-evidence.mjs';

const trace = { taskId: 'native-1', executionId: 'row-1', input: 'original task', output: 'original answer' };
const payload = () => ({ traceSource: 'existing', evaluatorIds: ['preset-task-completion-no-ref'], cases: [{ executionId: trace.executionId, taskId: trace.taskId, input: trace.input, actualOutput: trace.output, referenceOutput: null, evaluatorContext: null }], configSnapshot: { traceSource: 'existing', datasetId: null, caseIds: [trace.executionId] } });

test('004 must finish both Trace evaluations, diagnosis, optimization and candidate execution', () => {
  const stages = requiredStagesFor('004').map(id => ({ id, status: 'PASS' }));
  assert.equal(scenarioResult(stages,'004').status, 'PASS');
  for (const id of ['diagnosis','candidate-run','candidate-evaluation','persistence']) assert.notEqual(scenarioResult(stages.filter(s=>s.id!==id),'004').status, 'PASS');
});

test('trace-only request rejects dataset input, references and a different Trace', () => {
  assert.doesNotThrow(()=>assertTraceOnlyRequest(payload(), trace));
  for (const modify of [p=>p.datasetId='hidden',p=>p.cases[0].datasetCaseId='hidden',p=>p.cases[0].referenceOutput='answer',p=>p.cases[0].evaluatorContext={secret:'context'},p=>p.cases[0].datasetInput='question',p=>p.cases[0].taskId='old',p=>p.traceSource='generate',p=>p.evaluatorIds=['preset-agent-task-completion']]) {
    const p=payload();modify(p);assert.throws(()=>assertTraceOnlyRequest(p,trace));
  }
});

test('trace-only result needs persisted empty dependencies, matching actual output and a meaningful score', () => {
  const detail={ status:'done', configSnapshot:payload().configSnapshot, cases:[{id:'case-1',taskId:trace.taskId,input:trace.input,actualOutput:trace.output,referenceOutput:null,caseValues:{}}], results:[{caseId:'case-1',evaluatorId:'preset-task-completion-no-ref',status:'done',score:0.9,summary:'requirements fulfilled'}] };
  assert.equal(assertTraceOnlyResult(detail,trace).score,90);
  for(const mutate of [d=>d.configSnapshot.datasetId='hidden',d=>d.cases[0].caseValues={datasetCaseId:'hidden'},d=>d.results[0].score=null,d=>d.results[0].score=0.79,d=>d.results[0].summary='',d=>d.cases[0].actualOutput='stale']){const d=structuredClone(detail);mutate(d);assert.throws(()=>assertTraceOnlyResult(d,trace));}
});

test('candidate must keep facts and provide exactly the four-field summary', () => {
 const text='root认证失败351次，150.183.249.110占80次；authentication failure; 日志证据\nE2E-SUMMARY {"total_lines":2000,"root_ssh_failures":351,"top_source":"150.183.249.110","top_source_failures":80}';
 assert.equal(assertFourFieldSummary(text).total_lines,2000);
 for(const value of [text.replace('2000','1999'),text.replace('"total_lines":2000,',''),text+'\nE2E-SUMMARY {}',text.replace('authentication failure;','no evidence')])assert.throws(()=>assertFourFieldSummary(value));
});

test('loaded Skill proof supports numbered read output but rejects partial, wrong and stale content', async () => {
 const {assertLoadedSkill}=await import('./trace-only-evidence.mjs');
 const file='/isolated/skill/SKILL.md',content='---\nname: demo\n---\n\n# Instructions\n  keep indentation\n';
 const call=body=>({function:{name:'read',arguments:JSON.stringify({path:file})},output:body});
 const output='Read file '+file+', lines 1-6\n'+content.trimEnd().split('\n').map((line,i)=>`${i+1}: ${line}`).join('\n');
 assert.doesNotThrow(()=>assertLoadedSkill([call(output)],file,content));
 assert.throws(()=>assertLoadedSkill([call(output.replace('keep indentation','wrong'))],file,content));
 assert.throws(()=>assertLoadedSkill([call(output.split('\n').slice(0,-1).join('\n'))],file,content));
 assert.throws(()=>assertLoadedSkill([{...call(output),function:{name:'read',arguments:'{"path":"/other/SKILL.md"}'}}],file,content));
});

test('serialized Trace query is decoded exactly, without accepting partial matches', async()=>{
 const {decodeTraceInput}=await import('./trace-only-evidence.mjs');
 assert.equal(decodeTraceInput(JSON.stringify('original task')),'original task');assert.equal(decodeTraceInput('original task'),'original task');assert.notEqual(decodeTraceInput('prefix original task'),'original task');
});

test('dataset-free optimization needs explicit skipped behavior, not an incomplete or synthetic run', async()=>{
 const {assertDatasetFreeVerification}=await import('./trace-only-evidence.mjs');const proof={structural:true,behavioral:{ok:true,measured:0,skipped:'无有效行为用例'}};
 assert.doesNotThrow(()=>assertDatasetFreeVerification(proof));
 for(const change of [p=>p.behavioral.measured=1,p=>delete p.behavioral.skipped,p=>p.behavioral.incomplete='failed',p=>p.structural=false]){const p=structuredClone(proof);change(p);assert.throws(()=>assertDatasetFreeVerification(p));}
});

test('diagnosis compares authoritative stored serialization while verifying API content equivalence', async()=>{
 const {interactionProof}=await import('./trace-only-evidence.mjs');
 const one=[{role:'assistant',content:'original'}],reordered=[{content:'original',role:'assistant'}];
 assert.doesNotThrow(()=>interactionProof([{...one[0],_payloadVersion:'transport-version'}],reordered));
 const proof=interactionProof(one,reordered);assert.ok(proof.storedHash);assert.notEqual(proof.apiHash,proof.storedHash);
 assert.throws(()=>interactionProof(one,[{role:'assistant',content:'changed'}]));
 assert.doesNotThrow(()=>interactionProof(one,[{...one[0],tool_calls:[]}]));
 assert.doesNotThrow(()=>interactionProof([{...one[0],tool_calls:[]}],one));
 assert.throws(()=>interactionProof(one,[{...one[0],tool_calls:[{function:{name:'shell',arguments:'read file'}}]}]));
 assert.throws(()=>interactionProof(one,[{...one[0],tool_calls:null}]));
});

test('004 cannot pass without formal Skill binding and completed Skill-step verification',()=>{
 const stages=requiredStagesFor('004').map(id=>({id,status:'PASS'}));
 for(const id of ['skill-binding','skill-verification']){assert.ok(stages.some(s=>s.id===id));assert.notEqual(scenarioResult(stages.filter(s=>s.id!==id),'004').status,'PASS');}
});

test('native Skill association needs real loading plus the correct stored name and version', async()=>{
 const {assertNativeSkillBinding}=await import('./trace-only-evidence.mjs');
 const expected={name:'private-skill',version:0};const trace={skill:'private-skill',skill_version:0};
 const tools=[{function:{name:'skill',arguments:'{"id":"private-skill"}'},output:'loaded'}];
 assert.doesNotThrow(()=>assertNativeSkillBinding(trace,tools,expected));
 for(const [row,calls] of [[{...trace,skill:'other'},tools],[{...trace,skill_version:1},tools],[trace,[{function:{name:'read',arguments:'{"path":"/skills/private-skill/SKILL.md"}'}}]],[{skill:null,skill_version:null},tools]])assert.throws(()=>assertNativeSkillBinding(row,calls,expected));
});

test('Skill-step verification requires a complete report bound to this Trace', async()=>{
 const {assertSkillVerification}=await import('./trace-only-evidence.mjs');
 const data={row:{status:'done'},skillsAnalysis:{status:'done',interactionHash:'actual',skillKeyActionComparison:{status:'ok',referenceKeyActionCount:1,actualExtractedStepCount:2},keyActionResults:[{actionId:'step-1',actionContent:'analyze file',coverage:'covered',traceComparisonAnalysis:'tool ran on the actual file'}]}};
 assert.doesNotThrow(()=>assertSkillVerification(data,'actual'));
 for(const change of [d=>d.row.status='failed',d=>d.skillsAnalysis.interactionHash='old',d=>d.skillsAnalysis.keyActionResults=[],d=>d.skillsAnalysis.keyActionResults[0].traceComparisonAnalysis='',d=>d.skillsAnalysis.skillKeyActionComparison.referenceKeyActionCount=0]){const d=structuredClone(data);change(d);assert.throws(()=>assertSkillVerification(d,'actual'));}
});

test('minimal 004 Skill actions must all be covered rather than skipped or partially satisfied', async()=>{
 const {assertSkillVerification}=await import('./trace-only-evidence.mjs');
 for(const coverage of ['partial','missing','not_applicable'])assert.throws(()=>assertSkillVerification({row:{status:'done'},skillsAnalysis:{status:'done',interactionHash:'actual',skillKeyActionComparison:{status:'ok',referenceKeyActionCount:1,actualExtractedStepCount:2},keyActionResults:[{actionId:'step-1',actionContent:'analyze',coverage,traceComparisonAnalysis:'explanation'}]}},'actual'));
});

test('native loading proves the entire selected Skill body rather than merely a matching name',async()=>{
 const {assertLoadedSkill}=await import('./trace-only-evidence.mjs');
 const content='---\nname: selected\ndescription: example\n---\n\n# Instructions\nRun the script and cite evidence.\n';
 const call=output=>({function:{name:'skill',arguments:'{"id":"selected"}'},output});
 assert.equal(assertLoadedSkill([call('<skill_content>\n# Instructions\nRun the script and cite evidence.\n</skill_content>')],'/selected/SKILL.md',content).nativeLoad,true);
 for(const output of ['loaded selected','# Instructions\nRun the wrong script.'])assert.throws(()=>assertLoadedSkill([call(output)],'/selected/SKILL.md',content));
});

test('004 success scope may exclude only the formal unselected error branch proven by actual script JSON',async()=>{
 const {assertSkillVerification}=await import('./trace-only-evidence.mjs');
 const data={row:{status:'done'},skillsAnalysis:{status:'done',interactionHash:'actual',skillKeyActionComparison:{status:'ok',referenceKeyActionCount:2,actualExtractedStepCount:2},keyActionResults:[{actionId:'analyze',actionContent:'analyze log',coverage:'covered',traceComparisonAnalysis:'actual JSON and original log'},{actionId:'error',actionContent:'report invalid input',coverage:'not_applicable',traceComparisonAnalysis:'script succeeded'}]}};
 const flow={steps:[{id:'analyze',description:'analyze log'},{id:'error',description:'非零退出时没有可分析结果'}],branches:[{condition:'脚本退出码为 0 且输出 JSON 有效',trueStepId:'analyze',falseStepId:'error'}]};
 const scriptResult={total_lines:2000,root_ssh_failures:351,top_source:'150.183.249.110',top_source_failures:80,evidence:['authentication failure; user=root']};
 const checked=assertSkillVerification(data,'actual',{flow,scriptResult});assert.equal(checked.coreCovered,1);assert.equal(checked.unselectedBranches.length,1);
 for(const condition of ['统计脚本退出码是否为 0，即是否获得有效 JSON 分析结果','退出码是否为零并得到有效 JSON']){const question=structuredClone(flow);question.branches[0].condition=condition;assert.equal(assertSkillVerification(data,'actual',{flow:question,scriptResult}).coreCovered,1);}
 const nonzero=structuredClone(flow);nonzero.branches=[{condition:'脚本退出码非 0，表示输入不符合契约且没有可分析结果',trueStepId:'error',falseStepId:'analyze'}];
 assert.equal(assertSkillVerification(data,'actual',{flow:nonzero,scriptResult}).coreCovered,1);
 for(const change of [p=>p.branches[0].trueStepId='analyze',p=>p.branches[0].falseStepId='missing',p=>p.branches[0].condition='脚本退出码非 1']){const wrong=structuredClone(nonzero);change(wrong);assert.throws(()=>assertSkillVerification(data,'actual',{flow:wrong,scriptResult}));}
 for(const change of [p=>p.flow.branches=[],p=>p.flow.branches[0].falseStepId='analyze',p=>p.scriptResult.evidence=[],p=>p.scriptResult.root_ssh_failures=0,p=>p.flow.branches[0].condition='some unrelated branch']){const proof=structuredClone({flow,scriptResult});change(proof);assert.throws(()=>assertSkillVerification(data,'actual',proof));}
 const partial=structuredClone(data);partial.skillsAnalysis.keyActionResults[0].coverage='partial';assert.throws(()=>assertSkillVerification(partial,'actual',{flow,scriptResult}));
 const duplicate=structuredClone(data);duplicate.skillsAnalysis.keyActionResults[1].actionId='analyze';assert.throws(()=>assertSkillVerification(duplicate,'actual',{flow,scriptResult}));
});

test('Trace audit excludes formal system evaluators but retains actual extra business runs even with internal-looking IDs',async()=>{
 const {businessTraceAudit}=await import('./trace-only-evidence.mjs');
 const row=(taskId,agentName,query='task')=>({taskId,agentName,query});
 const rows=[row('baseline','build'),row('candidate','build'),row('judge','trace-quality-evaluator'),row('completion','task-completion-evaluator'),row('unrelated','build','other')];
 assert.deepEqual(businessTraceAudit(rows,'task'),{businessTraceIds:['baseline','candidate'],internalTraceIds:['completion','judge']});
 for(const agent of ['build','skill-debug-executor','batch-eval-agent','grayscale-skill-agent',null]){const checked=businessTraceAudit([...rows,row('trace-quality-evaluator-extra',agent)],'task');assert.ok(checked.businessTraceIds.includes('trace-quality-evaluator-extra'));assert.equal(checked.businessTraceIds.length,3);}
});
import {assertFactComparison} from './trace-only-evidence.mjs';
test('fact comparison verifies script/report values across headings, tables and JSON',()=>{
 const rows='root_ssh_failures：脚本值 351，报告值 351\ntop_source：脚本值 150.183.249.110，报告值 150.183.249.110\ntop_source_failures：脚本值 80，报告值 80';
 for(const title of ['核对：','## 核对','### 核对（逐项比对脚本 JSON 与报告）','**核对结果**','逐项比较'])assert.doesNotThrow(()=>assertFactComparison(title+'\n'+rows));
 assert.doesNotThrow(()=>assertFactComparison('|字段|脚本 JSON 值|报告值|\n|---|---|---|\n|root_ssh_failures|351|351|\n|top_source|150.183.249.110|150.183.249.110|\n|top_source_failures|80|80|'));
 assert.doesNotThrow(()=>assertFactComparison(rows+'\ntotal_lines 脚本值 = 2000'));
 assert.doesNotThrow(()=>assertFactComparison('|字段|脚本值|报告值|\n|---|---|---|\n|root_ssh_failures|351|351|\n|top_source|150.183.249.110|150.183.249.110|\n|top_source_failures|80|80 (22.8%)|'));
 assert.doesNotThrow(()=>assertFactComparison(rows.replaceAll('值 ','值为 ')));
 assert.doesNotThrow(()=>assertFactComparison(rows.replaceAll('值 ','值是 ')));
 assert.doesNotThrow(()=>assertFactComparison(JSON.stringify({root_ssh_failures:{script:351,report:351},top_source:{script:'150.183.249.110',report:'150.183.249.110'},top_source_failures:{script:80,report:80}})));
 for(const text of ['已核对，放心使用','**核对**：结果一致','root 失败351次',rows.replace('报告值 351','报告值 350'),rows.replace('脚本值 351，报告值 351','脚本值 351（复核 351），报告值 350'),rows.replace('报告值 80','报告值 81'),rows.replace('报告值 150.183.249.110','报告值 127.0.0.1'),rows.split('\n').slice(0,2).join('\n'),rows.replaceAll('报告值','说明'),'脚本值和报告值\nroot_ssh_failures:351/351\ntop_source:150.183.249.110/150.183.249.110\ntop_source_failures:80/80'])assert.throws(()=>assertFactComparison(text));
});

test('004 recognizes the formal grouped success/error flow without skipping core actions',async()=>{
 const {assertSkillVerification}=await import('./trace-only-evidence.mjs');
 const data={row:{status:'done'},skillsAnalysis:{status:'done',interactionHash:'actual',skillKeyActionComparison:{status:'ok',referenceKeyActionCount:2,actualExtractedStepCount:2},keyActionResults:[{actionId:'analyze',actionContent:'analyze log',coverage:'covered',traceComparisonAnalysis:'actual JSON and original log'},{actionId:'error',actionContent:'report invalid input',coverage:'not_applicable',traceComparisonAnalysis:'script succeeded'}]}};
 const flow={steps:[{id:'analyze',description:'analyze log'},{id:'error',description:'非零退出时没有可分析结果'}],branches:[],conditionalGroups:[{condition:'按退出码和 JSON 有效性选择路径',branches:[{label:'退出码为 0 且 JSON 有效',stepIds:['analyze']},{label:'退出码非 0 或 JSON 无效',stepIds:['error']}]}]};
 const scriptResult={total_lines:2000,root_ssh_failures:351,top_source:'150.183.249.110',top_source_failures:80,evidence:['authentication failure; user=root']};
 const result=assertSkillVerification(data,'actual',{flow,scriptResult});assert.equal(result.coreCovered,1);assert.equal(result.unselectedBranches.length,1);
 const exitOnly=structuredClone(flow);exitOnly.conditionalGroups[0].condition='根据统计脚本退出码选择处理路径';exitOnly.conditionalGroups[0].branches[0].label='退出码为 0：输入符合契约，继续分析';exitOnly.conditionalGroups[0].branches[1].label='退出码非 0：输入不符合契约，转述错误并立即停止';assert.equal(assertSkillVerification(data,'actual',{flow:exitOnly,scriptResult}).coreCovered,1);
 for(const change of [p=>p.flow.conditionalGroups=[],p=>p.flow.conditionalGroups[0].branches[0].stepIds.push('error'),p=>p.flow.conditionalGroups[0].branches[0].label='some unrelated branch',p=>p.flow.conditionalGroups[0].branches[0].stepIds=['unknown'],p=>p.flow.conditionalGroups[0].branches[0].label='退出码为 0 但 JSON 无效',p=>p.flow.conditionalGroups[0].branches[1].label='root SSH failures',p=>p.flow.conditionalGroups[0].branches[1].stepIds=['analyze'],p=>p.scriptResult.evidence=[]]){const proof=structuredClone({flow,scriptResult});change(proof);assert.throws(()=>assertSkillVerification(data,'actual',proof));}
 const skipped=structuredClone(data);skipped.skillsAnalysis.keyActionResults[0].coverage='not_applicable';assert.throws(()=>assertSkillVerification(skipped,'actual',{flow,scriptResult}));
});
