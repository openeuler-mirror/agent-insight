import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDebugTurns } from '@/lib/engine/agent-debug/trace-adapter';
import { detectTrajectoryFindings } from '@/lib/engine/agent-debug/trajectory-detector';
import type { DebugTurn } from '@/lib/engine/agent-debug/types';

function turn(i: number, opts: { tool?: { name: string; args: unknown }; text?: string }): DebugTurn {
  return {
    turnIndex: i + 1,
    sourceInteractionIndex: i,
    role: 'assistant',
    text: opts.text ?? '',
    toolCalls: opts.tool ? [{ name: opts.tool.name, args: opts.tool.args, status: 'ok' }] : [],
    anchorIds: [`anchor-${i}`],
    traceStepIndex: i + 1,
    traceNodeLabel: opts.tool ? `工具调用 · ${opts.tool.name}` : '模型调用 · LLM',
  };
}

test('flags a long read→re-read loop (same target repeated)', () => {
  const turns: DebugTurn[] = [];
  // 0-3: diverse setup (distinct args) — not part of the loop
  for (let i = 0; i < 4; i++) turns.push(turn(i, { tool: { name: 'bash', args: { command: `echo ${i}` } } }));
  // 4-23: same file re-read 20 times = the loop
  for (let i = 4; i < 24; i++) turns.push(turn(i, { tool: { name: 'read_file', args: { path: '/design/功能设计说明书.md' } } }));

  const findings = detectTrajectoryFindings(turns);
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.kind, 'trajectory');
  assert.equal(f.pattern, 'non_termination');
  assert.ok(f.cycleCount >= 10, `expected high cycleCount, got ${f.cycleCount}`);
  // region begins at the first *repeat* (turn 4 is the novel first read), so fromStep is 5 or 6
  assert.ok((f.span.fromStep ?? 0) >= 5 && (f.span.fromStep ?? 0) <= 6, `fromStep ${f.span.fromStep}`);
  assert.equal(f.span.toStep, 24);
  assert.ok(f.anchors.length >= 1);
  assert.ok(f.mechanism.length > 0);
  assert.ok(f.faultChain.length > 0);
  assert.ok(f.confidence > 0.5 && f.confidence <= 0.92);
});

test('stays silent on diverse non-looping work (distinct numbered targets)', () => {
  const turns: DebugTurn[] = [];
  for (let i = 0; i < 20; i++) turns.push(turn(i, { tool: { name: 'read_file', args: { path: `/src/file_${i}.ts` } } }));
  // distinct paths must NOT collapse into a single signature (no digit-stripping)
  assert.deepEqual(detectTrajectoryFindings(turns), []);
});

test('does not flag a short retry (below minRepeats)', () => {
  const turns: DebugTurn[] = [];
  for (let i = 0; i < 3; i++) turns.push(turn(i, { tool: { name: 'read_file', args: { path: '/x.md' } } }));
  for (let i = 3; i < 14; i++) turns.push(turn(i, { tool: { name: 'edit', args: { path: `/y_${i}.ts` } } }));
  assert.deepEqual(detectTrajectoryFindings(turns), []);
});

test('detects a repeated assistant-message loop (text fingerprint)', () => {
  const turns: DebugTurn[] = [];
  for (let i = 0; i < 16; i++) {
    turns.push(turn(i, { text: '收到催促，立即开始评审工作。首先读取功能设计说明书和需求规格说明书。' }));
  }
  const findings = detectTrajectoryFindings(turns);
  assert.equal(findings.length, 1);
  assert.ok(findings[0].cycleCount >= 10);
});

test('integration: detects loop from raw interactions via buildDebugTurns', () => {
  const interactions: Array<{ role: string; content: string; tool_calls?: unknown[] }> = [];
  for (let i = 0; i < 16; i++) {
    interactions.push({
      role: 'assistant',
      content: '重新读取完整设计文档。',
      tool_calls: [
        { id: `c-${i}`, function: { name: 'read_file', arguments: JSON.stringify({ path: '/design/spec.md' }) }, output: 'compressed summary ...' },
      ],
    });
  }
  const turns = buildDebugTurns(interactions);
  const findings = detectTrajectoryFindings(turns);
  assert.ok(findings.length >= 1, 'expected a trajectory finding from raw interactions');
  assert.equal(findings[0].pattern, 'non_termination');
});
