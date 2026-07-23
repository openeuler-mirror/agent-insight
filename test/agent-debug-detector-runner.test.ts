import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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


test("targeted run-all reads the query from the Skill input file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-debug-targeted-input-"));
  const input = path.join(dir, "input.json");
  try {
    fs.writeFileSync(input, JSON.stringify({ query: "为什么一直重复调用工具，像死循环？", turns: [] }), "utf8");
    const payload = run(["run-all", "--mode", "targeted", "--input", input]);
    assert.deepEqual((payload.runs as Array<{ detector: { name: string } }>).map(item => item.detector.name), ["trajectory-loop"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("final validator requires every detector fact to stay independent or merge losslessly", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-debug-final-validator-"));
  const corePath = path.join(dir, "core.json");
  const detectorsPath = path.join(dir, "detectors.json");
  const finalPath = path.join(dir, "final.json");
  const issue = {
    id: "N1-action-redundant_call", step: 1, traceStepIndex: 1, module: "action",
    errorType: "redundant_call", severity: "medium", evidence: "重复调用", reasoning: "无进展", confidence: 0.8,
  };
  const coreFinding = {
    id: "finding-loop", severity: "medium", impact: "quality_degrading", summary: "存在重复调用。",
    evidence: "节点 1 出现重复。", issueRefs: [{ issueId: issue.id, role: "root" }],
    correctionGuidance: "增加终止条件。", confidence: 0.8,
  };
  const detectorFinding = {
    id: "trajectory-1-8", kind: "trajectory", severity: "high", summary: "调用未终止。",
    facts: ["连续 8 次重复调用。"], mechanism: "缺少终止条件", faultChain: ["重复调用"],
    anchors: [{ traceStepIndex: 1, anchorId: "anchor-1" }], correctionGuidance: "限制重试次数。",
    confidence: 0.9, details: { cycleCount: 8 }, detector: "trajectory-loop@1.0.0",
  };
  const core = { triage: {}, stepRecords: [], phase1Grid: [], issues: [issue], findings: [coreFinding], rootCause: null, humanSummary: "主诊断" };
  const final = {
    ...core,
    findings: [{ ...coreFinding, supplementalEvidence: [{
      summary: detectorFinding.summary, severity: detectorFinding.severity, facts: detectorFinding.facts,
      mechanism: detectorFinding.mechanism, faultChain: detectorFinding.faultChain, anchors: detectorFinding.anchors,
      correctionGuidance: detectorFinding.correctionGuidance, confidence: detectorFinding.confidence, details: detectorFinding.details,
    }] }],
    detectorFindings: [],
  };
  try {
    fs.writeFileSync(corePath, JSON.stringify(core), "utf8");
    fs.writeFileSync(detectorsPath, JSON.stringify({ findings: [detectorFinding] }), "utf8");
    fs.writeFileSync(finalPath, JSON.stringify(final), "utf8");
    const validator = path.join(process.cwd(), "skills", "agent-debug-diagnosis", "scripts", "agentdebug_validate.py");
    execFileSync("python3", [validator, "--input", finalPath, "--core", corePath, "--detectors", detectorsPath], { encoding: "utf8" });

    fs.writeFileSync(finalPath, JSON.stringify({ ...final, findings: [coreFinding] }), "utf8");
    const rejected = spawnSync("python3", [validator, "--input", finalPath, "--core", corePath, "--detectors", detectorsPath], { encoding: "utf8" });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stdout, /既未独立保留，也未无损合入/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
