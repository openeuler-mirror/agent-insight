import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFallbackDiagnosis,
  parseDiagnosisResponse,
  type SkillDiagnosisSnapshot,
} from '@/lib/skill-analysis/diagnosis';

function makeSnapshot(overrides?: Partial<SkillDiagnosisSnapshot>): SkillDiagnosisSnapshot {
  return {
    skillName: 'demo-skill',
    version: 1,
    overall: {
      weightedScore: 82,
      coveredCount: 4,
      totalCount: 4,
      missingDimensions: [],
      selectedDimensionsThisRun: [],
    },
    ab: {
      configured: true,
      hasResult: true,
      status: 'done',
      scoreA: 82,
      scoreB: 86,
      delta: 4,
      pValue: 0.2,
      sampleCount: 12,
      recommendation: 'flat',
    },
    trace: {
      configured: true,
      hasResult: true,
      status: 'done',
      score: 80,
      fullyEvaluatedCount: 3,
      totalTraceCount: 3,
      highDeviationCount: 1,
    },
    recall: {
      configured: true,
      hasResult: true,
      status: 'done',
      score: 78,
      passRate: 0.78,
      truePositiveRate: 0.8,
      falsePositiveRate: 0.1,
      itemCount: 18,
      positiveCount: 9,
    },
    static: {
      configured: true,
      hasResult: true,
      status: 'done',
      score: 90,
      passedCount: 6,
      totalCount: 6,
      issueCount: 0,
    },
    ...overrides,
  };
}

test('buildFallbackDiagnosis prioritizes A/B regression', () => {
  const result = buildFallbackDiagnosis(makeSnapshot({
    ab: {
      configured: true,
      hasResult: true,
      status: 'done',
      scoreA: 75,
      scoreB: 60,
      delta: -15,
      pValue: 0.01,
      sampleCount: 8,
      recommendation: 'down',
    },
  }));
  assert.match(result.problem, /不建议上线/);
});

test('buildFallbackDiagnosis reports coverage gaps before low-score dimensions', () => {
  const result = buildFallbackDiagnosis(makeSnapshot({
    overall: {
      weightedScore: 50,
      coveredCount: 3,
      totalCount: 4,
      missingDimensions: ['recall'],
      selectedDimensionsThisRun: [],
    },
    recall: {
      configured: false,
      hasResult: false,
      status: 'unconfigured',
      score: null,
      passRate: null,
      truePositiveRate: null,
      falsePositiveRate: null,
      itemCount: 0,
      positiveCount: 0,
    },
  }));
  assert.match(result.problem, /覆盖仍不完整/);
  assert.match(result.suggestion, /补齐可运行维度/);
});

test('buildFallbackDiagnosis points to recall when it is the weakest completed dimension', () => {
  const result = buildFallbackDiagnosis(makeSnapshot({
    recall: {
      configured: true,
      hasResult: true,
      status: 'done',
      score: 42,
      passRate: 0.42,
      truePositiveRate: 0.4,
      falsePositiveRate: 0.3,
      itemCount: 20,
      positiveCount: 10,
    },
  }));
  assert.match(result.problem, /召回分析/);
});

test('parseDiagnosisResponse tolerates fenced json', () => {
  const parsed = parseDiagnosisResponse('```json\n{"problem":"a","suggestion":"b"}\n```');
  assert.deepEqual(parsed, { problem: 'a', suggestion: 'b' });
});
