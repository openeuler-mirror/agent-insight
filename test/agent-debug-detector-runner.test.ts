import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const runner = path.join(process.cwd(), 'skills', 'agent-debug-diagnosis', 'scripts', 'detector_runner.py');

function run(args: string[]) {
  return JSON.parse(execFileSync('python3', [runner, ...args], { encoding: 'utf8' })) as Record<string, unknown>;
}

function runDetector(turns: Array<Record<string, unknown>>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-debug-detector-case-'));
  const input = path.join(dir, 'input.json');
  try {
    fs.writeFileSync(input, JSON.stringify({ turns }), 'utf8');
    const payload = run(['run-all', '--mode', 'one_click', '--input', input]);
    return payload.findings as Array<Record<string, unknown>>;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function detectorTurn(index: number, options: { tool?: { name: string; args: unknown }; text?: string }) {
  return {
    turnIndex: index + 1,
    sourceInteractionIndex: index,
    text: options.text || '',
    toolCalls: options.tool ? [{ name: options.tool.name, args: options.tool.args, status: 'ok' }] : [],
    anchorIds: ['anchor-' + index],
    traceStepIndex: index + 1,
    traceNodeLabel: options.tool ? '工具调用 · ' + options.tool.name : '模型调用 · LLM',
  };
}

test('discovers Skill-local detectors from detector.json without a server registry', () => {
  const payload = run(['list']);
  const detectors = payload.detectors as Array<Record<string, unknown>>;
  assert.deepEqual(detectors.map(item => item.name), ['trajectory-loop']);
  assert.equal(detectors[0].entrypoint, 'detect.py');
});

test('targeted matching only selects a detector when its symptom keywords match', () => {
  const matched = run(['match', '--mode', 'targeted', '--query', '为什么这个 Agent 一直重复调用工具，像死循环？']);
  assert.deepEqual((matched.detectors as Array<Record<string, unknown>>).map(item => item.name), ['trajectory-loop']);

  const ordinary = run(['match', '--mode', 'targeted', '--query', '请解释一下这条建议是什么意思']);
  assert.deepEqual(ordinary.detectors, []);
});

test('runs the migrated trajectory detector through the generic runner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-debug-detector-'));
  const input = path.join(dir, 'input.json');
  const turns = Array.from({ length: 16 }, (_, index) => ({
    turnIndex: index + 1,
    sourceInteractionIndex: index,
    text: '',
    toolCalls: [{ name: 'read_file', args: { path: '/design/spec.md' }, status: 'ok' }],
    anchorIds: [`anchor-${index}`],
    traceStepIndex: index + 1,
    traceNodeLabel: '工具调用 · read_file',
  }));
  fs.writeFileSync(input, JSON.stringify({ turns }), 'utf8');
  const payload = run(['run-all', '--mode', 'one_click', '--input', input]);
  const findings = payload.findings as Array<Record<string, unknown>>;
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'trajectory');
  assert.equal(findings[0].detector, 'trajectory-loop@1.0.0');
  assert.ok(Array.isArray(findings[0].facts));
  assert.ok(findings[0].details && typeof findings[0].details === 'object');
});


test('does not flag diverse work with distinct targets', () => {
  const turns = Array.from({ length: 20 }, (_, index) => detectorTurn(index, {
    tool: { name: 'read_file', args: { path: '/src/file_' + index + '.ts' } },
  }));
  assert.deepEqual(runDetector(turns), []);
});

test('does not flag a short retry below the repeat threshold', () => {
  const turns = [
    ...Array.from({ length: 3 }, (_, index) => detectorTurn(index, {
      tool: { name: 'read_file', args: { path: '/x.md' } },
    })),
    ...Array.from({ length: 11 }, (_, offset) => detectorTurn(offset + 3, {
      tool: { name: 'edit', args: { path: '/y_' + (offset + 3) + '.ts' } },
    })),
  ];
  assert.deepEqual(runDetector(turns), []);
});

test('detects a repeated assistant-message loop through the generic runner', () => {
  const turns = Array.from({ length: 16 }, (_, index) => detectorTurn(index, {
    text: '收到催促，立即开始评审工作。首先读取功能设计说明书和需求规格说明书。',
  }));
  const findings = runDetector(turns);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pattern, 'non_termination');
  const details = findings[0].details as Record<string, unknown>;
  assert.ok(Number(details.cycleCount) >= 10);
});
