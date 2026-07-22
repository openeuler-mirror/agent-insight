import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { parseJsonObject } from '@/lib/engine/agent-debug/json';
import { buildDebugTurns } from '@/lib/engine/agent-debug/trace-adapter';

const skillDir = path.join(process.cwd(), 'skills', 'agent-debug-diagnosis');

test('agent-debug trace adapter normalizes shell tool errors', () => {
  const turns = buildDebugTurns([
    {
      role: 'assistant',
      content: '我检查目标文件。',
      tool_calls: [
        {
          id: 'call-1',
          function: {
            name: 'bash',
            arguments: JSON.stringify({ command: 'cat /tmp/missing-file' }),
          },
          output: 'cat: /tmp/missing-file: No such file or directory',
        },
      ],
    },
  ]);

  assert.equal(turns.length, 1);
  assert.equal(turns[0].toolCalls.length, 1);
  assert.equal(turns[0].toolCalls[0].name, 'bash');
  assert.equal(turns[0].toolCalls[0].status, 'error');
});

test('agent-debug trace adapter anchors multiple tool calls to distinct trace nodes', () => {
  const turns = buildDebugTurns([
    {
      role: 'user',
      content: '检查日志目录。',
    },
    {
      role: 'assistant',
      content: '我先看目录结构。',
      tool_calls: [
        {
          id: 'call-ls',
          function: {
            name: 'bash',
            arguments: JSON.stringify({ command: 'ls -la /tmp/logs' }),
          },
          output: 'total 0',
        },
        {
          id: 'call-tree',
          function: {
            name: 'bash',
            arguments: JSON.stringify({ command: 'tree /tmp/logs -L 2' }),
          },
          output: '/bin/bash: tree: command not found',
        },
      ],
    },
  ]);

  assert.equal(turns.length, 1);
  assert.equal(turns[0].toolCalls.length, 2);
  assert.equal(turns[0].toolCalls[0].anchorId, 'event:n1:2');
  assert.equal(turns[0].toolCalls[1].anchorId, 'event:n1:3');
  assert.notEqual(turns[0].toolCalls[0].anchorId, turns[0].toolCalls[1].anchorId);
  assert.equal(turns[0].toolCalls[0].traceStepIndex, 5);
  assert.equal(turns[0].toolCalls[1].traceStepIndex, 6);
  assert.equal(turns[0].traceStepIndex, 4);
});

test('agent-debug trace adapter does not treat ordinary read content as tool error', () => {
  const turns = buildDebugTurns([
    {
      role: 'assistant',
      content: '读取故障分类文档。',
      tool_calls: [
        {
          id: 'call-1',
          function: {
            name: 'read',
            arguments: JSON.stringify({ path: 'DISK_fault_scenarios.md' }),
          },
          output: '# 磁盘故障场景\n这里讨论 error、failure、故障 等概念。',
        },
      ],
    },
  ]);

  assert.equal(turns.length, 1);
  assert.equal(turns[0].toolCalls[0].status, 'ok');
});

test('agent-debug skill output parser accepts fenced JSON report', () => {
  const parsed = parseJsonObject([
    '```json',
    JSON.stringify({
      stepRecords: [],
      phase1Grid: [],
      issues: [],
      rootCause: null,
      humanSummary: '未发现明确问题。',
    }),
    '```',
  ].join('\n'));

  assert.ok(parsed);
  assert.equal(parsed.rootCause, null);
  assert.deepEqual(parsed.phase1Grid, []);
});

test('agent-debug skill owns the full diagnosis protocol references', () => {
  const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
  const references = [
    'references/01-input-and-extraction.md',
    'references/02-error-taxonomy.md',
    'references/03-phase-analysis.md',
    'references/04-output-schema.md',
  ];

  for (const reference of references) {
    assert.ok(skill.includes(reference), `SKILL.md should require ${reference}`);
    assert.ok(fs.existsSync(path.join(skillDir, reference)), `${reference} should exist`);
  }
});

test('agent-debug skill defines Chinese script-driven protocol and schema', () => {
  const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
  const phase = fs.readFileSync(path.join(skillDir, 'references/03-phase-analysis.md'), 'utf-8');
  const schema = fs.readFileSync(path.join(skillDir, 'references/04-output-schema.md'), 'utf-8');

  assert.match(skill, /agentdebug_static\.py/);
  assert.match(skill, /agentdebug_validate\.py/);
  assert.match(skill, /所有自然语言报告字段必须用中文/);
  assert.match(phase, /Phase 0：系统风险预检/);
  assert.match(phase, /不是最终结论/);
  assert.match(schema, /"triage"/);
  assert.match(schema, /shortCircuited=true/);
  assert.match(schema, /所有自然语言字段必须用中文/);
});

test('agent-debug supports multi finding protocol and blocks eval pollution', () => {
  const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
  const phase = fs.readFileSync(path.join(skillDir, 'references/03-phase-analysis.md'), 'utf-8');
  const schema = fs.readFileSync(path.join(skillDir, 'references/04-output-schema.md'), 'utf-8');
  const validator = fs.readFileSync(path.join(skillDir, 'scripts', 'agentdebug_validate.py'), 'utf-8');
  const runner = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'engine', 'agent-debug', 'runner.ts'), 'utf-8');

  assert.match(skill, /`findings`/);
  assert.match(phase, /issueRefs/);
  assert.match(schema, /"findings"/);
  assert.match(schema, /"role": "root"/);
  assert.match(validator, /validate_findings/);
  assert.match(validator, /role=root/);
  assert.match(runner, /normalizeFindings/);
  assert.match(runner, /schemaVersion:\s*3/);
  assert.doesNotMatch(runner, /answerScore/);
  assert.doesNotMatch(runner, /judgmentReason/);
  assert.doesNotMatch(runner, /parseFailures/);
});

test('agent-debug skill bundles deterministic static scripts', () => {
  const staticScript = fs.readFileSync(path.join(skillDir, 'scripts', 'agentdebug_static.py'), 'utf-8');
  const validateScript = fs.readFileSync(path.join(skillDir, 'scripts', 'agentdebug_validate.py'), 'utf-8');

  assert.match(staticScript, /command not found/);
  assert.match(staticScript, /parameter_error/);
  assert.match(staticScript, /tool_execution_error/);
  assert.match(staticScript, /no_explicit_plan/);
  assert.match(staticScript, /traceStepIndex/);
  assert.match(validateScript, /所有自然语言字段|中文|schema|triage/);
});

test('agent-debug runner uses executable opencode agent mode', () => {
  const runner = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'engine', 'agent-debug', 'runner.ts'), 'utf-8');
  assert.match(runner, /agent:\s*'build'/);
  assert.doesNotMatch(runner, /agent:\s*'plan'/);
});

test('fault diagnosis trace persistence uses one mode-specific skill label', () => {
  const generalRunner = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'engine', 'general-agent', 'runner.ts'), 'utf-8');
  const agentDebugRunner = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'engine', 'agent-debug', 'runner.ts'), 'utf-8');
  const diagnosisRoute = fs.readFileSync(path.join(process.cwd(), 'src', 'app', 'api', 'fault', 'diagnosis', 'stream', 'route.ts'), 'utf-8');

  assert.ok(generalRunner.includes('const effectiveTraceSkill = skillMeta?.name ?? input.skill ?? input.tagSkill ?? systemAgentDefinition?.traceSkill'));
  assert.equal(generalRunner.match(/skill: effectiveTraceSkill/g)?.length, 2);
  assert.match(agentDebugRunner, /tagSkill: AGENT_DEBUG_SKILL_NAME/);
  assert.match(diagnosisRoute, /tagSkill: 'agent-debug-diagnosis'/);
});

test('agent-debug runner falls back to final report file', () => {
  const runner = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'engine', 'agent-debug', 'runner.ts'), 'utf-8');
  assert.match(runner, /readAgentDebugFinalReport\(workspaceDir\)/);
  assert.match(runner, /AGENT_DEBUG_FINAL_REPORT_REL_PATH/);
  assert.match(runner, /不要只回复摘要或诊断完成说明/);
});

test('agent-debug GET exposes completed reports from older generators', () => {
  const route = fs.readFileSync(path.join(process.cwd(), 'src', 'app', 'api', 'observe', 'executions', '[executionId]', 'agent-debug', 'route.ts'), 'utf-8');

  assert.match(route, /const report = row\?\.status === 'done' \? parseReportPayload\(row\) : null/);
  assert.match(route, /existing\?\.status === 'done' && existing\.generator === AGENT_DEBUG_GENERATOR/);
});

test('agent-debug no longer uses candidate windows for analysis', () => {
  const runner = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'engine', 'agent-debug', 'runner.ts'), 'utf-8');
  const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
  assert.doesNotMatch(runner, /selectCandidateWindows|候选故障窗口/);
  assert.match(runner, /全部 turns/);
  assert.match(skill, /不使用候选窗口/);
  assert.equal(fs.existsSync(path.join(process.cwd(), 'src', 'lib', 'engine', 'agent-debug', 'candidates.ts')), false);
});

test('fault detail exposes AgentDebug diagnosis for every trace', () => {
  const page = fs.readFileSync(path.join(process.cwd(), 'src', 'app', '(main)', 'fault', 'page.tsx'), 'utf-8');
  const card = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'observe', 'AgentDebugCard.tsx'), 'utf-8');

  assert.doesNotMatch(page, /agentDebugSuggested/);
  assert.doesNotMatch(card, /suggested:\s*boolean/);
  assert.doesNotMatch(card, /!suggested && !report/);
  assert.match(page, /buildTraceExplicitErrors\(diagnosticItems, traceNodes\)/);
  assert.match(page, /const matchedNode = findBestFaultNode\(nodes, item\)\?\.node/);
  assert.match(page, /matchedNode\?\.id \|\| item\.trace_anchor\?\.step_id \|\| item\.anchor_step_id/);
  assert.doesNotMatch(page, /Insight AI/);
  assert.doesNotMatch(card, /Insight AI/);
  assert.doesNotMatch(page, /FaultKindBadge/);
  assert.doesNotMatch(card, /TraceExplicitErrorCard/);
  assert.doesNotMatch(card, /TraceExplicitErrorsSection/);
  assert.doesNotMatch(card, /原始 Trace 报错/);
});
