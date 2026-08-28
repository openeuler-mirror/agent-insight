import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertOptimizationTransition,
  canTransitionOptimization,
  computeSkillSnapshotHash,
  displayStaticQualitySeverity,
  isWorkbenchActiveView,
  isWorkbenchSource,
  isWorkbenchTaskType,
  isBlockingStaticQualityIssue,
  makeWorkbenchTaskIdempotencyKey,
} from '../src/lib/skill-workbench/domain';
import {
  evaluateSkillTriggerAnalysis,
  formatWorkbenchTriggerDatasetTimestamp,
  SKILL_TRIGGER_ANALYZER_EVALUATOR_ID,
  SKILL_TRIGGER_ANALYZER_EVIDENCE,
} from '../src/lib/skill-workbench/trigger-evaluator';
import { resolveStaticQualityGate } from '../src/lib/skill-workbench/evaluation-service';
import { optimizationRecordsSyncKey } from '../src/lib/skill-workbench/sync-channel';

test('候选版质量规则通过后可直接发布，并兼容历史复测状态', () => {
  assert.equal(canTransitionOptimization('optimizing', 'pending_retest'), true);
  assert.equal(canTransitionOptimization('pending_retest', 'published'), true);
  assert.equal(canTransitionOptimization('pending_retest', 'retesting'), true);
  assert.equal(canTransitionOptimization('retesting', 'published'), true);
  assert.equal(canTransitionOptimization('retesting', 'retest_passed'), true);
  assert.equal(canTransitionOptimization('retest_passed', 'published'), true);
  assert.throws(
    () => assertOptimizationTransition('optimizing', 'published'),
    /Invalid skill optimization transition/,
  );
});

test('发布和放弃是终态', () => {
  assert.equal(canTransitionOptimization('published', 'optimizing'), false);
  assert.equal(canTransitionOptimization('abandoned', 'retesting'), false);
});

test('优化记录同步键只在服务端发布状态发生变化时改变', () => {
  const pending = optimizationRecordsSyncKey([
    { id: 'record-b', status: 'abandoned', publishedVersion: null, updatedAt: '2026-08-28T10:00:00.000Z' },
    { id: 'record-a', status: 'pending_retest', publishedVersion: null, updatedAt: '2026-08-28T09:00:00.000Z' },
  ]);
  assert.equal(pending, optimizationRecordsSyncKey([
    { id: 'record-a', status: 'pending_retest', publishedVersion: null, updatedAt: '2026-08-28T09:00:00.000Z' },
    { id: 'record-b', status: 'abandoned', publishedVersion: null, updatedAt: '2026-08-28T10:00:00.000Z' },
  ]));
  assert.notEqual(pending, optimizationRecordsSyncKey([
    { id: 'record-a', status: 'published', publishedVersion: 3, updatedAt: '2026-08-28T10:01:00.000Z' },
    { id: 'record-b', status: 'abandoned', publishedVersion: null, updatedAt: '2026-08-28T10:00:00.000Z' },
  ]));
});

test('工作台视图和来源只接受显式值域', () => {
  assert.equal(isWorkbenchActiveView('detail'), true);
  assert.equal(isWorkbenchActiveView('static'), false);
  assert.equal(isWorkbenchSource('uploaded'), true);
  assert.equal(isWorkbenchSource('hub'), false);
  assert.equal(isWorkbenchTaskType('retest'), true);
  assert.equal(isWorkbenchTaskType('static'), false);
});

test('任务幂等键对相同目标稳定，对版本和目标引用敏感', () => {
  const base = makeWorkbenchTaskIdempotencyKey({
    type: 'evaluation',
    skillName: 'incident-diagnosis',
    version: 3,
    targetRef: 'snapshot-a',
  });
  assert.equal(base, makeWorkbenchTaskIdempotencyKey({
    type: 'evaluation',
    skillName: 'incident-diagnosis',
    version: 3,
    targetRef: 'snapshot-a',
  }));
  assert.notEqual(base, makeWorkbenchTaskIdempotencyKey({
    type: 'evaluation',
    skillName: 'incident-diagnosis',
    version: 4,
    targetRef: 'snapshot-a',
  }));
});

test('Skill 快照 hash 与对象插入顺序和路径分隔符无关', () => {
  const left = computeSkillSnapshotHash({
    'references/runbook.md': 'runbook',
    'SKILL.md': 'skill',
  });
  const right = computeSkillSnapshotHash({
    'SKILL.md': 'skill',
    'references\\runbook.md': 'runbook',
  });
  assert.equal(left, right);
  assert.notEqual(left, computeSkillSnapshotHash({ 'SKILL.md': 'changed' }));
  assert.notEqual(
    computeSkillSnapshotHash({ 'SKILL.md': 'same', 'scripts/check.sh': 'old' }),
    computeSkillSnapshotHash({ 'SKILL.md': 'same', 'scripts/check.sh': 'new' }),
  );
});

test('触发分析使用独立确定性评估器，数据集名称时间精确到秒', () => {
  assert.equal(SKILL_TRIGGER_ANALYZER_EVALUATOR_ID, 'skill-trigger-analyzer');
  assert.equal(
    formatWorkbenchTriggerDatasetTimestamp(new Date(2026, 7, 19, 17, 6, 5)),
    '2026/8/19 17:06:05',
  );
  const passed = evaluateSkillTriggerAnalysis({ shouldTrigger: true, skillTriggered: true });
  assert.equal(passed.score, 100);
  assert.equal(passed.summary, '实际触发结果与预期标注一致。');
  assert.equal(passed.points?.length, 1);
  assert.deepEqual(passed.points?.[0], {
    label: '触发准确率', score: 100, status: 'covered', skillAttributable: false,
    evidence: { md: SKILL_TRIGGER_ANALYZER_EVIDENCE },
  });
  const failed = evaluateSkillTriggerAnalysis({
    shouldTrigger: true,
    skillTriggered: false,
    observation: '实际触发率 0%（命中 0/1 次）',
    reason: '这条用例用于验证 SSH 安全审计场景',
  });
  assert.equal(failed.score, 0);
  assert.equal(failed.summary, '应触发但未触发当前 Skill。');
  assert.equal(failed.points?.length, 1);
  assert.equal(failed.points?.[0].label, '触发准确率');
  assert.equal(failed.points?.[0].score, 0);
  assert.match(String(failed.points?.[0].evidence && 'md' in failed.points[0].evidence ? failed.points[0].evidence.md : ''), /触发观察：[\s\S]*原因：/);
  assert.match(failed.points?.[0].suggestion || '', /SKILL\.md/);
});

test('静态评估执行状态与质量门禁状态分开计算', () => {
  assert.equal(resolveStaticQualityGate({ status: 'pending' }).state, 'running');
  assert.equal(resolveStaticQualityGate({ hasStaleEvaluation: true }).state, 'stale');
  assert.equal(resolveStaticQualityGate({ status: 'ok', highIssueCount: 2 }).state, 'blocked');
  assert.equal(resolveStaticQualityGate({ status: 'partial', highIssueCount: 0 }).state, 'passed');
});

test('静态质量门禁只接受有证据或原因支撑的 high', () => {
  assert.equal(isBlockingStaticQualityIssue({ severity: 'high', evidence: '命中高危命令' }), true);
  assert.equal(isBlockingStaticQualityIssue({ severity: 'high', reasoning: '缺少人工确认' }), true);
  assert.equal(isBlockingStaticQualityIssue({ severity: 'high' }), false);
  assert.equal(isBlockingStaticQualityIssue({ severity: 'medium', evidence: '一般问题' }), false);
  assert.equal(displayStaticQualitySeverity({ severity: 'high' }), 'medium');
  assert.equal(displayStaticQualitySeverity({ severity: 'high', reasoning: '明确原因' }), 'high');
});
