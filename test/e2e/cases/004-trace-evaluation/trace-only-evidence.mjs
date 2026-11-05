import {parseSummaryJson} from '../../shared/summary-json.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { classifyTraceSource } from '../../../../src/lib/system-agent-names.ts';
import { assertSkillAnswer } from '../../shared/skill-evidence.mjs';

export function assertNoDatasetInputs(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(datasetId|datasetCaseId|datasetCaseIds|linkedDatasetIds|datasetInput|referenceOutput|expectedOutput|evaluatorContext|datasetCaseBinding)$/.test(key)) {
      assert.ok(item === null || item === undefined || item === '' || (Array.isArray(item) && item.length === 0), `Unexpected ${key} dependency`);
    }
    if (key === 'caseValuesJson' && typeof item === 'string') assertNoDatasetInputs(JSON.parse(item));
    else assertNoDatasetInputs(item);
  }
}
export function assertTraceOnlyRequest(payload, trace) {
  assertNoDatasetInputs(payload);
  assert.equal(payload.traceSource, 'existing');
  assert.equal(payload.configSnapshot.traceSource, 'existing');
  assert.deepEqual(payload.evaluatorIds, ['preset-task-completion-no-ref']);
  assert.equal(payload.cases.length, 1);
  const item = payload.cases[0];
  assert.equal(item.executionId, trace.executionId);assert.equal(item.taskId, trace.taskId);
  assert.equal(item.input, trace.input);assert.equal(item.actualOutput, trace.output);
  return { traceSource: 'existing', datasetId: null, taskId: item.taskId, evaluatorId: payload.evaluatorIds[0] };
}
export function assertTraceOnlyResult(detail, trace) {
  assertNoDatasetInputs(detail.configSnapshot);assertNoDatasetInputs(detail.cases);
  assert.equal(detail.configSnapshot.traceSource, 'existing');assert.equal(detail.status, 'done');assert.equal(detail.cases.length, 1);
  const item = detail.cases[0];assert.equal(item.taskId, trace.taskId);assert.equal(item.input, trace.input);assert.equal(item.actualOutput, trace.output);
  const results = detail.results.filter(r => r.caseId === item.id);assert.equal(results.length, 1);
  const result = results[0];assert.equal(result.evaluatorId, 'preset-task-completion-no-ref');assert.equal(result.status, 'done');
  assert.ok(typeof result.score === 'number' && Number.isFinite(result.score), 'Score missing');
  const score = result.score <= 1 ? result.score * 100 : result.score;assert.ok(score >= 80 && score <= 100, `Completion score ${score} is outside 80–100`);assert.ok(result.summary?.trim(), 'Evaluation reasoning missing');
  return { experimentId: detail.id, caseId: item.id, taskId: item.taskId, evaluatorId: result.evaluatorId, score, summary: result.summary, datasetId: null };
}
export function assertFourFieldSummary(reply) {
  assertSkillAnswer(reply.split('E2E-SUMMARY')[0], false);
  const value = parseSummaryJson(reply);assert.deepEqual(value, { total_lines: 2000, root_ssh_failures: 351, top_source: '150.183.249.110', top_source_failures: 80 });return value;
}
export function assertLoadedSkill(tools, file, expected) {
  const name=expected.match(/^name:\s*["']?([^"'\n]+?)["']?\s*$/m)?.[1];
  const body=expected.replace(/^---\s*\n[\s\S]*?\n---/, '').trim();
  for(const tool of tools){
    if(!['skill','load_skill'].includes(tool.function?.name || tool.name))continue;
    let args;try{args=JSON.parse(tool.function?.arguments || tool.arguments || '{}');}catch{continue;}
    if((args.id || args.name || args.skill)!==name)continue;
    const output=String(tool.output || '').replaceAll('\\n','\n').replaceAll('\\"','"');
    assert.ok(output.includes(body), 'Native Skill output differs from selected snapshot');
    return { file, skillName:name, nativeLoad:true, verifiedLines:expected.trimEnd().split('\n').length };
  }
  const lines = new Map();
  for (const tool of tools) {
    const args = tool.function?.arguments || tool.arguments || '{}';
    let input;try { input = typeof args === 'string' ? JSON.parse(args) : args; } catch { continue; }
    if (input.path !== file && input.filePath !== file) continue;
    for (const line of String(tool.output || '').split('\n')) {
      const match = line.match(/^(\d+): ?(.*)$/);
      if (match) {const index = Number(match[1]);assert.ok(!lines.has(index) || lines.get(index) === match[2], 'Conflicting Skill reads');lines.set(index, match[2]);}
    }
  }
  const wanted = expected.trimEnd().split('\n');
  assert.ok(lines.size >= wanted.length, 'Actual Skill read was incomplete');
  for (let i = 0; i < wanted.length; i++) assert.equal(lines.get(i + 1), wanted[i], `Loaded Skill differs at line ${i + 1}`);
  return { verifiedLines: wanted.length, file };
}
export function decodeTraceInput(value) {
  try {const parsed = JSON.parse(value);if (typeof parsed === 'string') return parsed;} catch {}
  return value;
}
export function assertDatasetFreeVerification(proof) {
  assert.equal(proof?.structural, true, 'Structural verification failed');
  assert.ok(proof.behavioral?.skipped, 'Missing explicit no-dataset skip');
  assert.equal(proof.behavioral.measured, 0);assert.equal(proof.behavioral.ok, true);assert.ok(!proof.behavioral.incomplete, 'Behavior verification failed rather than skipped');
  return { measured: 0, skipped: proof.behavioral.skipped, structural: true };
}
export function interactionProof(apiInteractions, storedInteractions) {
  const normalize=items=>items.map(item=>{
    const normalized={...item};
    if(Array.isArray(normalized.tool_calls)&&normalized.tool_calls.length===0)delete normalized.tool_calls;
    return normalized;
  });
  const content=apiInteractions.map(({_payloadVersion,...item})=>item);
  assert.ok(isDeepStrictEqual(normalize(content),normalize(storedInteractions)), 'Stored and API Trace contents differ');
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return { apiHash: hash(apiInteractions), storedHash: hash(storedInteractions) };
}
export function assertNativeSkillBinding(record, tools, expected) {
  const actual = tools.flatMap(tool => {
    if (!['skill', 'load_skill'].includes(tool.function?.name || tool.name)) return [];
    let args;try {args=JSON.parse(tool.function?.arguments || tool.arguments || '{}');} catch {return [];}
    return [args.id || args.name || args.skill];
  });
  assert.ok(actual.includes(expected.name), 'Native Skill loading call missing');
  assert.equal(record.skill, expected.name, 'Trace is not bound to the selected Skill');
  assert.equal(record.skill_version ?? record.skillVersion, expected.version, 'Trace Skill version differs');
  return { skillName: expected.name, version: expected.version, nativeLoad: true };
}
export function assertSkillVerification(data, interactionHash, scope) {
  const report=data.skillsAnalysis;
  assert.equal(data.row?.status, 'done');assert.equal(report?.status, 'done');assert.equal(report.interactionHash, interactionHash);
  assert.equal(report.skillKeyActionComparison?.status, 'ok');assert.ok(report.skillKeyActionComparison.referenceKeyActionCount>0);assert.ok(report.skillKeyActionComparison.actualExtractedStepCount>0);
  assert.ok(report.keyActionResults?.length>0, 'No Skill key-action results');
  const coverage={covered:0,partial:0,missing:0,not_applicable:0};
  for(const action of report.keyActionResults){assert.ok(action.actionId && action.actionContent?.trim());assert.ok(Object.hasOwn(coverage,action.coverage));assert.ok(action.traceComparisonAnalysis?.trim(), 'Missing action comparison evidence');coverage[action.coverage]++;}
  const unselectedBranches=[];
  const ids=report.keyActionResults.map(action=>action.actionId);assert.equal(new Set(ids).size,ids.length,'Duplicate Skill action results');
  assert.equal(ids.length,report.skillKeyActionComparison.referenceKeyActionCount);
  if(scope){
    const {flow,scriptResult}=scope;
    assert.ok(Number.isInteger(scriptResult?.total_lines)&&scriptResult.total_lines>0);
    assert.ok(Number.isInteger(scriptResult.root_ssh_failures)&&scriptResult.root_ssh_failures>0&&scriptResult.root_ssh_failures<=scriptResult.total_lines);
    assert.ok(scriptResult.top_source&&scriptResult.top_source_failures>0&&scriptResult.top_source_failures<=scriptResult.root_ssh_failures);
    assert.ok(scriptResult.evidence?.length>0,'Successful script evidence missing');
    assert.deepEqual([...ids].sort(),flow.steps.map(step=>step.id).sort(),'Verification does not match the formal Skill flow');
    for(const action of report.keyActionResults.filter(action=>action.coverage==='not_applicable')){
      const step=flow.steps.find(step=>step.id===action.actionId);
      const branch=flow.branches?.find(branch=>branch.falseStepId===step.id&&/退出码.*\b0\b|exit.*\b0\b/i.test(branch.condition)&&/JSON/i.test(branch.condition));
      const groups=(flow.conditionalGroups||[]).filter(group=>group.branches?.some(b=>b.stepIds?.includes(step.id)));
      let condition=branch?.condition;
      if(groups.length){
        assert.equal(groups.length,1,'Unselected error action belongs to ambiguous conditional groups');
        const members=groups[0].branches;
        const invalid=members.filter(b=>b.stepIds?.includes(step.id));
        const valid=members.find(b=>!b.stepIds?.includes(step.id)&&/(?:退出码(?:为|是|等于)?\s*0\b|exit(?:\s+code)?\s*(?:==?|is)?\s*0\b)/i.test(b.label)&&/JSON.*有效|有效.*JSON/i.test(b.label)&&!/无效/.test(b.label));
        assert.ok(invalid.length===1&&/退出码.*(?:非|不为|不等于|!=)\s*0|JSON.*无效/i.test(invalid[0].label)&&valid,'Unselected action is not the grouped invalid-input branch');
        condition=`${groups[0].condition}: ${invalid[0].label}`;
      }
      assert.ok(condition&&/非零|失败|无效|不符合|没有.*结果/.test(`${step.name||''} ${step.description||''}`),'Unselected branch is not a formal invalid-input branch');
      unselectedBranches.push({actionId:action.actionId,condition,reason:'Actual script returned valid nonempty JSON; invalid-input branch not executed and not counted as passed'});
    }
  }
  assert.equal(coverage.partial+coverage.missing,0,'Core Skill actions cannot be partial or missing');
  assert.equal(coverage.not_applicable,unselectedBranches.length,'Core Skill actions cannot be skipped');
  const coreActions=report.skillKeyActionComparison.referenceKeyActionCount-unselectedBranches.length;
  assert.ok(coreActions>0);assert.equal(coverage.covered,coreActions,'Not every core Skill action is covered');
  return { reportId:data.row.id, status:'done', interactionHash, referenceActions:report.skillKeyActionComparison.referenceKeyActionCount, coreActions,coreCovered:coverage.covered,unselectedBranches,actualSteps:report.skillKeyActionComparison.actualExtractedStepCount, coverage };
}

export function businessTraceAudit(rows,prompt){
  const matching=rows.filter(row=>decodeTraceInput(row.query)===prompt);
  const internal=matching.filter(row=>classifyTraceSource(row.agentName)==='system');
  return {businessTraceIds:matching.filter(row=>!internal.includes(row)).map(row=>row.taskId).sort(),internalTraceIds:internal.map(row=>row.taskId).sort()};
}

export function assertFactComparison(answer, expected={root_ssh_failures:351,top_source:'150.183.249.110',top_source_failures:80}) {
  const fields=['root_ssh_failures','top_source','top_source_failures'];
  const boundaries=[...new Set([...fields,...Object.keys(expected),'total_lines','evidence'])];
  const pairs=new Map(fields.map(field=>[field,[]]));
  const tokens=(text,field)=>typeof expected[field]==='string'?(text.match(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g)||[]):(text.match(/-?\d+(?:\.\d+)?/g)||[]).map(Number);
  let columns=null;
  for(const line of answer.split('\n')){
    if(!line.includes('|')){columns=null;continue;}
    const cells=line.trim().replace(/^\||\|$/g,'').split('|').map(cell=>cell.replace(/[*`]/g,'').trim());
    const script=cells.findIndex(cell=>/脚本|script/i.test(cell)),report=cells.findIndex(cell=>/报告|report/i.test(cell));
    if(script>=0&&report>=0&&script!==report&&!cells.some(cell=>fields.includes(cell))){columns={script,report};continue;}
    if(!columns)continue;
    for(const field of fields)if(cells.some(cell=>new RegExp('\\b'+field+'\\b').test(cell))){
      pairs.get(field).push({script:tokens(cells[columns.script]||'',field).slice(0,1),report:tokens(cells[columns.report]||'',field).slice(0,1)});
    }
  }
  for(const field of fields){
    const mentions=[...answer.matchAll(new RegExp('\\b'+field+'\\b','g'))];
    for(const match of mentions){
      let excerpt=answer.slice(match.index+field.length);
      const next=excerpt.search(new RegExp('\\b(?:'+boundaries.filter(key=>key!==field).join('|')+')\\b'));
      if(next>=0)excerpt=excerpt.slice(0,next);
      excerpt=excerpt.split('\n').filter(line=>line.trim()).slice(0,8).join('\n');
      const value=typeof expected[field]==='string'?String.raw`(?:\d{1,3}\.){3}\d{1,3}`:String.raw`-?\d+(?:\.\d+)?`;
      const readRole=role=>[...excerpt.matchAll(new RegExp('(?:'+role+')'+String.raw`(?:\s*(?:为|是))?`+String.raw`[\s"\x27\x60*]*[:：=]?[\s"\x27\x60*]*(`+value+')','gi'))].map(found=>typeof expected[field]==='string'?found[1]:Number(found[1]));
      const script=readRole(String.raw`脚本(?:\s*JSON)?\s*(?:的)?\s*(?:数?值|结果|输出)?|script(?:\s*value)?`);
      const report=readRole(String.raw`报告\s*(?:的)?\s*(?:数?值|结果|输出)?|report(?:\s*value)?`);
      if(script.length&&report.length)pairs.get(field).push({script,report});
    }
    const evidence=pairs.get(field);
    assert.ok(evidence.length&&evidence.every(pair=>pair.script.length&&pair.report.length&&[...pair.script,...pair.report].every(value=>value===expected[field])),`Fact comparison does not show matching script/report values for ${field}`);
  }
}
