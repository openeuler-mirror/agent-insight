import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEvaluatorOutput,
  averageScore,
  EvaluatorOutputSchema,
} from '../src/lib/evaluators/eval-output';
import { getEvaluatorMeta, deriveEvaluatorTags, gateEvaluator } from '../src/lib/evaluators/registry';
import type { EvaluatorCard } from '../src/lib/evaluators/custom-evaluator-model';

describe('评估器输出统一契约 normalizeEvaluatorOutput', () => {
  it('完整输出原样收敛且通过 schema 校验', () => {
    const out = normalizeEvaluatorOutput({
      score: 96,
      points: [
        { label: '识别根因', score: 98, evidence: { md: '**已覆盖**' } },
        { label: '匹配明细', evidence: { json: { verdict: 'hit' } } },
      ],
      evidence: { md: '总评' },
    });
    assert.equal(out.score, 96);
    assert.equal(out.points?.length, 2);
    assert.equal(out.points?.[1].score, undefined);
    assert.doesNotThrow(() => EvaluatorOutputSchema.parse(out));
  });

  it('任意退化组合合法：仅 score / 仅 evidence / 全空', () => {
    assert.deepEqual(normalizeEvaluatorOutput({ score: 72 }), { score: 72 });
    assert.deepEqual(normalizeEvaluatorOutput({ evidence: 'judge 说明文字' }), { evidence: { md: 'judge 说明文字' } });
    assert.deepEqual(normalizeEvaluatorOutput({}), {});
    assert.deepEqual(normalizeEvaluatorOutput(null), {});
  });

  it('score 清洗：越界 clamp、字符串数字、0-1 旧量纲放大、非数值丢弃', () => {
    assert.equal(normalizeEvaluatorOutput({ score: 120 }).score, 100);
    assert.equal(normalizeEvaluatorOutput({ score: -5 }).score, 0);
    assert.equal(normalizeEvaluatorOutput({ score: '88' }).score, 88);
    assert.equal(normalizeEvaluatorOutput({ score: 0.85 }).score, 85);
    assert.equal(normalizeEvaluatorOutput({ score: 'abc' }).score, undefined);
  });

  it('非法评分点逐条丢弃而非整体失败；裸对象证据视为 json', () => {
    const out = normalizeEvaluatorOutput({
      points: [{ label: '' }, { nope: 1 }, { label: '有效', score: 0.9 }],
      evidence: { verdict: 'hit', matched: [] },
    });
    assert.equal(out.points?.length, 1);
    assert.equal(out.points?.[0].score, 90);
    assert.deepEqual(out.evidence, { json: { verdict: 'hit', matched: [] } });
  });

  it('评分点归因字段：status/skillAttributable/suggestion/anchors 归一化', () => {
    const out = normalizeEvaluatorOutput({
      points: [{
        label: '完整性', score: 30,
        status: 'partial', skillAttributable: true,
        suggestion: '  补齐 trace 埋点  ', anchors: ['step-3', ' step-7 ', ''],
      }],
    });
    const p = out.points![0];
    assert.equal(p.status, 'partial');
    assert.equal(p.skillAttributable, true);
    assert.equal(p.suggestion, '补齐 trace 埋点');
    assert.deepEqual(p.anchors, ['step-3', 'step-7']);
    assert.doesNotThrow(() => EvaluatorOutputSchema.parse(out));
  });

  it('归因字段全可选：不填则完全不出现（向后兼容）', () => {
    const out = normalizeEvaluatorOutput({ points: [{ label: '仅名字与分', score: 88 }] });
    assert.deepEqual(out.points![0], { label: '仅名字与分', score: 88 });
  });

  it('status 容忍原评估器 coverage 词汇与中文；not_applicable/未知→不设', () => {
    const mk = (s: string) => normalizeEvaluatorOutput({ points: [{ label: 'x', status: s }] }).points![0].status;
    assert.equal(mk('covered'), 'covered');
    assert.equal(mk('已覆盖'), 'covered');
    assert.equal(mk('missing'), 'missing');
    assert.equal(mk('not_applicable'), undefined);
    assert.equal(mk('garbage'), undefined);
  });

  it('averageScore：无分不进分母，全无分返回 null', () => {
    assert.equal(averageScore([{ score: 96 }, { score: 100 }, { score: undefined }]), 98);
    assert.equal(averageScore([{ score: null }, {}]), null);
  });
});

describe('评估器注册表 registry', () => {
  const customWithRef: EvaluatorCard = {
    id: 'c1', name: 'compliance', description: '', evaluatorType: 'LLM', source: 'custom',
    targetTypes: [], objectives: [], scenarios: [], runMode: '', scoreRange: '', popularity: 0,
    mappedMetrics: [], status: 'ready', category: 'res',
    llmConfig: { model: 'deepseek-chat', systemPrompt: '对照 {{reference_output}} 评估 {{output}}' },
  };

  it('预置元数据：任务完成度=res+依赖参考；轨迹质量=traj 无前置', () => {
    const tc = getEvaluatorMeta({ id: 'preset-agent-task-completion', source: 'preset' } as EvaluatorCard);
    assert.deepEqual(tc, { category: 'res', requires: ['reference'] });
    const tq = getEvaluatorMeta({ id: 'preset-agent-trace-quality', source: 'preset' } as EvaluatorCard);
    assert.deepEqual(tq, { category: 'traj', requires: [] });
  });

  it('自建评估器 requires 由提示词占位符推导', () => {
    assert.deepEqual(getEvaluatorMeta(customWithRef).requires, ['reference']);
    const noRef = { ...customWithRef, llmConfig: { model: 'm', systemPrompt: '评估 {{output}}' } };
    assert.deepEqual(getEvaluatorMeta(noRef).requires, []);
  });

  it('标签派生包含 来源/类型/类目/依赖参考数据', () => {
    assert.deepEqual(deriveEvaluatorTags(customWithRef), ['自建', 'LLM Judge', '看结果', '依赖参考数据']);
  });

  it('硬门控：任一 case 未标注参考 → 不可用并给出原因；全满足 → 可用', () => {
    const meta = { category: 'res' as const, requires: ['reference' as const] };
    const g1 = gateEvaluator(meta, [{ hasReference: true }, { hasReference: false }]);
    assert.equal(g1.usable, false);
    assert.match(g1.reason ?? '', /1 个未标注/);
    assert.equal(gateEvaluator(meta, [{ hasReference: true }]).usable, true);
    assert.equal(gateEvaluator(meta, []).usable, false);
    assert.equal(gateEvaluator({ category: 'traj', requires: [] }, []).usable, true);
  });
});
