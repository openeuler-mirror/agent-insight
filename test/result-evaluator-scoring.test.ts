import assert from 'node:assert/strict';
import test from 'node:test';

import {
  scoreAccuracyJudgePayload,
  type AccuracyClaim,
  type AccuracyJudgePayload,
} from '@/lib/engine/evaluation/result-accuracy-evaluator';
import {
  evaluateAnswerQuality,
  scoreAnswerCompleteness,
  scoreAnswerQuality,
  scoreAnswerRelevance,
} from '@/lib/engine/evaluation/answer-quality-evaluator';
import {
  extractOutputClaims,
  scoreFaithfulnessClaims,
} from '@/lib/engine/evaluation/faithfulness-evaluator';
import {
  scoreInstructionVerdicts,
  type StructuredResultInvoker,
} from '@/lib/engine/evaluation/instruction-adherence-evaluator';
import { aggregateTrajectoryScore } from '@/lib/engine/evaluation/trajectory-evaluator';

test('结果准确性：正确/部分正确/错误进入平均，参考答案未涉及项排除', () => {
  const claims: AccuracyClaim[] = [
    { claimId: 'C1', claim: '正确主张', sourceQuote: '正确主张' },
    { claimId: 'C2', claim: '部分正确主张', sourceQuote: '部分正确主张' },
    { claimId: 'C3', claim: '错误主张', sourceQuote: '错误主张' },
    { claimId: 'C4', claim: '参考答案未涉及主张', sourceQuote: '参考答案未涉及主张' },
  ];
  const payload: AccuracyJudgePayload = {
    claim_findings: [
      { claim_id: 'C1', status: 'correct', score: 0, expected_evidence: '依据 1', reason: '一致', confidence: 0.9 },
      { claim_id: 'C2', status: 'partially_correct', score: 0, expected_evidence: '依据 2', reason: '部分一致', confidence: 0.9 },
      { claim_id: 'C3', status: 'wrong', score: 1, expected_evidence: '依据 3', reason: '冲突', confidence: 0.9 },
      { claim_id: 'C4', status: 'not_in_reference', score: null, expected_evidence: '', reason: '未涉及', confidence: 0.9 },
    ],
    confidence: 0.95,
    reason: '准确性测试',
  };

  const result = scoreAccuracyJudgePayload({ payload, claims });
  assert.equal(result.score, 50);
  assert.deepEqual(result.evidence.counts, {
    judged: 3,
    correct: 1,
    partiallyCorrect: 1,
    wrong: 1,
    notInReference: 1,
  });
});

test('答案质量：相关性、完整性、连贯性按 30%/50%/20% 聚合', () => {
  assert.equal(scoreAnswerRelevance([
    { verdict: 'relevant' },
    { verdict: 'supporting' },
    { verdict: 'irrelevant' },
  ]), 50);
  assert.equal(scoreAnswerRelevance([{ verdict: 'supporting' }], true), 0);

  const completeness = scoreAnswerCompleteness(
    [
      { id: 'R1', importance: 3 },
      { id: 'R2', importance: 2 },
      { id: 'R3', importance: 1 },
    ],
    [
      { requirementId: 'R1', status: 'covered' },
      { requirementId: 'R2', status: 'partial' },
      { requirementId: 'R3', status: 'missing' },
    ],
  );
  assert.equal(completeness, 66.7);
  assert.equal(scoreAnswerQuality({ relevance: 50, completeness: 66.7, coherence: 75 }), 63.4);
});

test('答案质量：模型返回超过 24 条陈述时只保留前 24 条', async () => {
  const statements = Array.from({ length: 30 }, (_, index) => ({
    id: `S${index + 1}`,
    text: `陈述 ${index + 1}`,
    sourceQuote: `陈述 ${index + 1}`,
  }));
  const invoke: StructuredResultInvoker = async (prompt) => {
    if (prompt.stage === 'statement-extraction') return { statements, confidence: 1 } as never;
    if (prompt.stage === 'requirement-extraction') {
      return { requirements: [{ id: 'R1', text: '回答问题', importance: 1, sourceQuote: '问题' }], confidence: 1 } as never;
    }
    if (prompt.stage === 'relevance-verdict') {
      return {
        verdicts: statements.slice(0, 24).map((item) => ({ statementId: item.id, verdict: 'relevant', reason: '' })),
        noncommittal: { value: false, reason: '' },
        confidence: 1,
      } as never;
    }
    if (prompt.stage === 'completeness-verdict') {
      return { verdicts: [{ requirementId: 'R1', status: 'covered', reason: '', evidenceQuote: '回答' }], confidence: 1 } as never;
    }
    return {
      rating: 4,
      checks: {
        mainConclusionClear: true,
        logicalOrder: true,
        referenceConsistency: true,
        contradictions: [],
        repetitions: [],
        abruptTransitions: [],
      },
      reason: '清晰',
      confidence: 1,
    } as never;
  };

  const result = await evaluateAnswerQuality({ query: '问题', finalResult: '回答', invoke });
  const relevance = result.evidence.relevance as { verdicts: unknown[] };
  assert.equal(relevance.verdicts.length, 24);
});

test('忠实性：仅证据支持主张得分，冲突和未覆盖均计 0', () => {
  assert.equal(scoreFaithfulnessClaims([
    { status: 'supported' },
    { status: 'contradicted' },
    { status: 'not_covered' },
    { status: 'supported' },
  ]), 50);
  assert.equal(scoreFaithfulnessClaims([]), null);
});

test('准确性和忠实性共用的主张提取最多保留 20 条', async () => {
  const claims = Array.from({ length: 25 }, (_, index) => ({
    claimId: `C${index + 1}`,
    claim: `主张 ${index + 1}`,
    sourceQuote: `主张 ${index + 1}`,
    requiresExhaustiveEvidence: false,
  }));
  const invoke: StructuredResultInvoker = async () => ({ claims, confidence: 1 }) as never;
  const result = await extractOutputClaims({ query: '限制复核', finalResult: '包含很多主张', invoke });
  assert.equal(result.claims.length, 20);
});

test('指令遵循：适用约束等权计分，不适用项排除', () => {
  assert.equal(scoreInstructionVerdicts([
    { status: 'met' },
    { status: 'not_met' },
    { status: 'not_applicable' },
  ]), 50);
  assert.equal(scoreInstructionVerdicts([{ status: 'not_applicable' }]), null);
});

test('轨迹质量：完整性、工具选择、冗余按 45%/35%/20% 聚合', () => {
  const result = aggregateTrajectoryScore(
    { completeness: 0.5, toolChoice: 1, redundancy: 0.5 },
    [{ stepIndex: 1, kind: 'tool', deviation: '缺少关键动作', severity: 'high' }],
  );
  assert.equal(result.trajectoryScore, 0.675);
  assert.equal(result.scoreAggregation.highCount, 1);
});
