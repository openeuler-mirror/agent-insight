import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const skillDir = path.join(process.cwd(), 'skills', 'agent-debug-diagnosis');
const inspectScript = path.join(skillDir, 'scripts', 'agentdebug_inspect.py');
const validateScript = path.join(skillDir, 'scripts', 'agentdebug_validate.py');

function modules() {
  return Object.fromEntries(
    ['memory', 'reflection', 'planning', 'action', 'system'].map(module => [
      module,
      { module, content: '', confidence: 0, source: module === 'action' ? 'raw_tool' : module === 'system' ? 'system' : 'implicit' },
    ]),
  );
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-debug-inspect-'));
  const inputPath = path.join(dir, 'agent-debug-input.json');
  const staticPath = path.join(dir, 'agent-debug-static.json');
  const finalPath = path.join(dir, 'agent-debug-final.json');
  const turns = [
    { turnIndex: 1, traceStepIndex: 1, role: 'user', text: '不要修改后端代码，只调整 Skill。', toolCalls: [] },
    {
      turnIndex: 2,
      traceStepIndex: 2,
      role: 'assistant',
      agentName: 'design-reviewer',
      text: '我先读取设计文档。',
      toolCalls: [{ name: 'read_file', status: 'ok', args: { path: 'design.md', session: 's1' }, output: '完整设计内容' }],
    },
    {
      turnIndex: 3,
      traceStepIndex: 3,
      role: 'assistant',
      agentName: 'design-reviewer',
      text: '刚才内容被压缩，需要重新读取完整设计文档。',
      toolCalls: [{ name: 'read_file', status: 'ok', args: { path: 'design.md', session: 's2' }, output: '完整设计内容' }],
    },
    {
      turnIndex: 4,
      traceStepIndex: 4,
      role: 'assistant',
      text: '运行测试。',
      toolCalls: [{ name: 'bash', status: 'error', args: { command: 'npm test' }, output: 'FAILED example' }],
    },
    { turnIndex: 5, traceStepIndex: 5, role: 'assistant', text: '测试成功完成。', toolCalls: [] },
  ];
  const stepRecords = turns.map(turn => ({
    step: turn.traceStepIndex,
    diagnosticStep: turn.turnIndex,
    traceStepIndex: turn.traceStepIndex,
    traceNodeLabel: `节点 #${turn.traceStepIndex}`,
    traceNodeKind: 'llm',
    anchorId: `event:${turn.traceStepIndex}`,
    modules: modules(),
  }));
  const phase1Grid = [{
    step: 3,
    traceStepIndex: 3,
    traceNodeLabel: '节点 #3',
    traceNodeKind: 'llm',
    anchorId: 'event:3',
    module: 'action',
    errorDetected: true,
    errorType: 'redundant_call',
    severity: 'low',
    evidence: '重复读取 design.md',
    reasoning: '相同参数重复调用。',
    confidence: 0.9,
  }];
  const issues = [{
    id: 'N3-action-redundant_call',
    step: 3,
    traceStepIndex: 3,
    traceNodeLabel: '节点 #3',
    traceNodeKind: 'llm',
    anchorId: 'event:3',
    module: 'action',
    errorType: 'redundant_call',
    severity: 'low',
    evidence: '重复读取 design.md',
    reasoning: '相同参数重复调用。',
    confidence: 0.9,
  }];
  const staticReport = {
    schemaVersion: 1,
    execution: { id: 'execution-1' },
    triage: { fatalDiagnosis: false, category: 'normal', confidence: 0.9, evidence: [], notes: [] },
    stepRecords,
    phase1Grid,
    issues,
    staticSummary: { stepCount: 5, issueCount: 1 },
  };
  const finalReport = {
    triage: staticReport.triage,
    stepRecords,
    phase1Grid,
    issues,
    findings: [],
    rootCause: null,
    humanSummary: '发现重复读取，但未造成任务失败。',
  };
  fs.writeFileSync(inputPath, JSON.stringify({
    schemaVersion: 1,
    execution: { id: 'execution-1', taskId: 'task-1', framework: 'test', query: '检查执行过程' },
    turns,
    traceBundle: { nodeCount: 5, artifactCount: 0 },
  }));
  fs.writeFileSync(staticPath, JSON.stringify(staticReport));
  fs.writeFileSync(finalPath, JSON.stringify(finalReport));
  return { dir, inputPath, staticPath, finalPath, finalReport };
}

function runJson(script: string, args: string[]) {
  return JSON.parse(execFileSync('python3', [script, ...args], { encoding: 'utf8' }));
}

test('agent-debug inspect summary exposes bounded candidate signals for all modules', () => {
  const data = fixture();
  const summary = runJson(inspectScript, ['summary', '--input', data.inputPath, '--static', data.staticPath]);

  assert.equal(summary.counts.turns, 5);
  assert.deepEqual(Object.keys(summary.semanticCandidateSignals), ['memory', 'reflection', 'planning', 'action', 'system']);
  assert.equal(summary.semanticCandidateSignals.memory.explicitRereadMentions, 1);
  assert.equal(summary.semanticCandidateSignals.reflection.possibleSuccessAfterFailedTool, 1);
  assert.equal(summary.semanticCandidateSignals.planning.repeatedCallGroups, 1);
  assert.equal(summary.semanticCandidateSignals.action.failedToolCalls, 1);
  assert.equal(summary.tail.at(-1).step, 5);
});

test('agent-debug inspect searches context and normalizes repeated call arguments', () => {
  const data = fixture();
  const search = runJson(inspectScript, [
    'search', '--input', data.inputPath, '--terms', '压缩,重新读取', '--context', '1',
  ]);
  const repeated = runJson(inspectScript, [
    'repeated-calls', '--input', data.inputPath, '--tool', 'read_file',
  ]);

  assert.equal(search.totalMatches, 1);
  assert.equal(search.matches[0].step, 3);
  assert.equal(search.matches[0].before[0].step, 2);
  assert.equal(repeated.totalGroups, 1);
  assert.equal(repeated.groups[0].count, 2);
  assert.equal(repeated.groups[0].target, 'design.md');
});

test('agent-debug validator rejects deletion of static evidence', () => {
  const data = fixture();
  const valid = runJson(validateScript, ['--input', data.finalPath, '--static', data.staticPath]);
  assert.equal(valid.ok, true);

  fs.writeFileSync(data.finalPath, JSON.stringify({ ...data.finalReport, phase1Grid: [], issues: [] }));
  const invalid = spawnSync('python3', [validateScript, '--input', data.finalPath, '--static', data.staticPath], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stdout, /删除了静态 issue/);
  assert.match(invalid.stdout, /丢失静态单元格/);
});

test('agent-debug runner sends metadata and paths instead of a long turn summary', () => {
  const runner = fs.readFileSync(path.join(process.cwd(), 'src/lib/engine/agent-debug/runner.ts'), 'utf8');
  const reportStore = fs.readFileSync(path.join(process.cwd(), 'src/lib/engine/agent-debug/report-store.ts'), 'utf8');
  const route = fs.readFileSync(path.join(process.cwd(), 'src/app/api/observe/executions/[executionId]/agent-debug/route.ts'), 'utf8');
  assert.match(runner, /agentdebug_inspect\.py summary/);
  assert.match(runner, /归一化 turn 数/);
  assert.doesNotMatch(runner, /归一化 Step 摘要/);
  assert.doesNotMatch(runner, /turnToPromptRecord/);
  assert.doesNotMatch(runner, /40_000/);
  assert.match(runner, /agent-debug-diagnosis-skill@0\.3/);
  assert.match(reportStore, /"generator" = \?/);
  assert.match(route, /generator: AGENT_DEBUG_GENERATOR/);
});
