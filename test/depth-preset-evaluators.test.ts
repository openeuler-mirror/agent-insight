/** 回答深度性评估器的 Judge 契约与确定性计分测试。 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { JudgeOutputParseError } from '@/lib/evaluators/judge-assembly';
import { setJudgeLlmCallerForTest } from '@/lib/engine/experiment/judge-llm';
import {
  buildDepthEvaluatorOutput,
  runDepthPreset,
} from '@/lib/engine/experiment/depth-preset-evaluators';

interface DepthEvidenceJson {
  rubricVersion?: string;
  issues?: Array<{ dimension?: string }>;
}

function evidenceJson(output: { evidence?: unknown }): DepthEvidenceJson {
  return ((output.evidence as { json?: DepthEvidenceJson } | undefined)?.json ?? {});
}

const context = {
  caseInput: '请分析这个方案的取舍',
  actualOutput: '方案结构清楚，但没有比较替代路径。',
  referenceOutput: null,
  traceSummaryText: null,
  interactions: [],
  taskId: null,
  executionId: null,
};

afterEach(() => setJudgeLlmCallerForTest(null));

describe('回答深度性预置评估器', () => {
  it('通过统一 Judge 边界读取五维判断并按固定权重聚合', async () => {
    let systemPrompt = '';
    setJudgeLlmCallerForTest(async (_user, request) => {
      systemPrompt = request.system;
      return JSON.stringify({
        dimensions: [
          {
            dimension: 'causal_depth', requiredDepth: 'none', requiredDepthReason: '任务无需因果分析',
            verdict: 'met', reason: '该任务无需因果展开', suggestion: '',
          },
          {
            dimension: 'structured_reasoning', requiredDepth: 'light', requiredDepthReason: '需要清楚组织结论',
            verdict: 'partial', reason: '结构存在但推导不完整', suggestion: '补充关键推导',
          },
          {
            dimension: 'multi_perspective_tradeoff', requiredDepth: 'full', requiredDepthReason: '用户要求分析取舍',
            verdict: 'missing', reason: '没有比较替代路径', suggestion: '比较方案利弊',
          },
          {
            dimension: 'context_provision', requiredDepth: 'light', requiredDepthReason: '需要少量方案背景',
            verdict: 'met', reason: '回答给出了必要背景', suggestion: '',
          },
          {
            dimension: 'insight_synthesis', requiredDepth: 'none', requiredDepthReason: '任务没有要求推广结论',
            verdict: 'met', reason: '无需额外升华', suggestion: '',
          },
        ],
        issues: [{ dimension: 'causal_depth', reason: '没有因果解释' }],
        suggestions: ['比较方案利弊'],
      });
    });

    const output = await runDepthPreset('u', context);

    assert.match(systemPrompt, /回答深度性评估器/);
    assert.equal(output.score, 45.8);
    assert.match(output.summary ?? '', /达成 1 项、部分达成 1 项、未达成 1 项/);
    assert.equal(output.points?.find((point) => point.label === '多视角权衡')?.score, 0);
    const causalPoint = output.points?.find((point) => point.label === '原因分析深度');
    assert.equal(causalPoint?.score, undefined);
    assert.equal(causalPoint?.status, undefined);
    assert.match((causalPoint?.evidence as { md?: string })?.md ?? '', /不适用/);
    assert.equal(evidenceJson(output).rubricVersion, '1.0.0');
    assert.deepEqual(evidenceJson(output).issues, []);
  });

  it('全部维度均不适用时保留 N/A 证据但不生成总分', () => {
    const dimensions = [
      'causal_depth',
      'structured_reasoning',
      'multi_perspective_tradeoff',
      'context_provision',
      'insight_synthesis',
    ] as const;
    const output = buildDepthEvaluatorOutput({
      dimensions: dimensions.map((dimension) => ({
        dimension,
        requiredDepth: 'none' as const,
        requiredDepthReason: '简单事实题无需展开',
        verdict: 'met' as const,
        reason: '该维度不适用',
        suggestion: '',
      })),
    });
    assert.equal(output.score, undefined);
    assert.match(output.summary ?? '', /不计分/);
    assert.equal(output.points?.every((point) => point.score === undefined && point.status === undefined), true);
    assert.match((output.evidence as { json?: { unscoredReason?: string } })?.json?.unscoredReason ?? '', /均不适用/);
  });

  it('Judge 缺少维度时抛可重试解析错误', async () => {
    setJudgeLlmCallerForTest(async () => JSON.stringify({
      dimensions: [{
        dimension: 'causal_depth', requiredDepth: 'full', requiredDepthReason: '需要解释原因',
        verdict: 'met', reason: '给出了原因', suggestion: '',
      }],
      issues: [],
      suggestions: [],
    }));

    await assert.rejects(() => runDepthPreset('u', context), JudgeOutputParseError);
  });
});
