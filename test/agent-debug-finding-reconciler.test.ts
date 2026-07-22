import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileDetectorFindings } from '@/lib/engine/agent-debug/finding-reconciler';
import type { AgentDebugDetectorFinding, AgentDebugFinding } from '@/lib/engine/agent-debug/types';

const coreFindings: AgentDebugFinding[] = [
  {
    id: 'finding-tool-error',
    severity: 'medium',
    impact: 'recovered_cost',
    summary: '主探针依赖缺失。',
    evidence: 'service-status-probe: command not found',
    issueRefs: [{ issueId: 'N9-system-tool_execution_error', role: 'root' }],
    correctionGuidance: '安装缺失依赖。',
    confidence: 0.9,
  },
  {
    id: 'finding-repeat-loop',
    severity: 'low',
    impact: 'risk',
    summary: '多次重复执行相同采集命令。',
    evidence: '节点 #15 至 #33 重复执行。',
    issueRefs: [{ issueId: 'N15-action-redundant_call', role: 'root' }],
    correctionGuidance: '限制重复次数。',
    confidence: 0.72,
  },
];

const detectorFinding: AgentDebugDetectorFinding = {
  id: 'trajectory-5-15',
  kind: 'trajectory',
  pattern: 'non_termination',
  severity: 'high',
  summary: '采集流程未终止。',
  facts: ['区间约 11 个 turn。', '约 100% 的 turn 无新进展。'],
  mechanism: '输出截断与 RETRY_HINT 共同触发重复采集。',
  faultChain: ['输出被截断', '出现 RETRY_HINT', '重复相同命令'],
  anchors: [
    { traceStepIndex: 12, anchorId: 'event:n1:9' },
    { traceStepIndex: 32, anchorId: 'event:n1:29' },
  ],
  correctionGuidance: '修复输出截断并增加重试上限。',
  confidence: 0.84,
  detector: 'trajectory-loop@1.0.0',
  details: {
    span: { fromStep: 12, toStep: 32, turnCount: 11 },
    cycleCount: 11,
    noProgressRatio: 1,
  },
};

test('merges detector facts without deleting a distinct core tool-error finding', () => {
  const result = reconcileDetectorFindings({
    coreFindings,
    detectorFindings: [detectorFinding],
    decisions: [{
      detectorFindingId: detectorFinding.id,
      action: 'merge',
      targetFindingId: 'finding-repeat-loop',
      patch: {
        severity: 'high',
        impact: 'quality_degrading',
      },
    }],
  });

  assert.equal(result.findings.length, 2);
  assert.ok(result.findings.some(finding => finding.id === 'finding-tool-error'));
  assert.equal(result.findings[0].id, 'finding-repeat-loop');
  assert.equal(result.findings[0].summary, '多次重复执行相同采集命令。');
  assert.deepEqual(result.detectorFindings, []);
  assert.deepEqual(result.findings[0].supplementalEvidence?.[0].details, detectorFinding.details);
  assert.deepEqual(result.findings[0].supplementalEvidence?.[0].anchors, detectorFinding.anchors);
  assert.equal(JSON.stringify(result.findings[0].supplementalEvidence).includes('trajectory-loop'), false);
});

test('never downgrades a frozen core finding through a merge patch', () => {
  const result = reconcileDetectorFindings({
    coreFindings,
    detectorFindings: [detectorFinding],
    decisions: [{
      detectorFindingId: detectorFinding.id,
      action: 'merge',
      targetFindingId: 'finding-tool-error',
      patch: { severity: 'low', impact: 'risk', confidence: 0.1 },
    }],
  });
  const target = result.findings.find(finding => finding.id === 'finding-tool-error');
  assert.equal(target?.severity, 'medium');
  assert.equal(target?.impact, 'recovered_cost');
  assert.equal(target?.confidence, 0.9);
  assert.equal(target?.summary, '主探针依赖缺失。');
});

test('keeps a detector finding independent when the merge target is invalid', () => {
  const result = reconcileDetectorFindings({
    coreFindings,
    detectorFindings: [detectorFinding],
    decisions: [{
      detectorFindingId: detectorFinding.id,
      action: 'merge',
      targetFindingId: 'missing-finding',
    }],
  });

  assert.equal(result.findings.length, coreFindings.length);
  assert.deepEqual(result.detectorFindings.map(finding => finding.id), [detectorFinding.id]);
  assert.equal(result.decisions[0].action, 'independent');
});

test('preserves a valid relation when distinct findings stay independent', () => {
  const result = reconcileDetectorFindings({
    coreFindings,
    detectorFindings: [detectorFinding],
    decisions: [{
      detectorFindingId: detectorFinding.id,
      action: 'independent',
      relatedFindingId: 'finding-tool-error',
    }],
  });

  assert.equal(result.detectorFindings[0].relatedFindingId, 'finding-tool-error');
});

test('defaults unmentioned detector findings to independent instead of dropping them', () => {
  const result = reconcileDetectorFindings({
    coreFindings,
    detectorFindings: [detectorFinding],
    decisions: [],
  });
  assert.deepEqual(result.detectorFindings.map(finding => finding.id), [detectorFinding.id]);
  assert.equal(result.decisions[0].action, 'independent');
});
