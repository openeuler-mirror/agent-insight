import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEvaluatorOutput,
  averageScore,
  deriveVerdict,
  displaySummary,
  isEvidenceRedundant,
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
    assert.equal(normalizeEvaluatorOutput({ score: 1 }).score, 100);
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

describe('结论字段 verdict / summary', () => {
  it('verdict 容忍英文别名与中文说法；未识别 → 不设（呈现层按分数派生）', () => {
    const mk = (v: unknown) => normalizeEvaluatorOutput({ verdict: v }).verdict;
    assert.equal(mk('pass'), 'pass');
    assert.equal(mk('PASSED'), 'pass');
    assert.equal(mk('达成'), 'pass');
    assert.equal(mk('partial'), 'warn');
    assert.equal(mk('部分达成'), 'warn');
    assert.equal(mk('not_met'), 'fail');
    assert.equal(mk('未通过'), 'fail');
    assert.equal(mk('garbage'), undefined);
    assert.equal(mk(42), undefined);
  });

  it('summary 压平换行并截断；空白视为未提供', () => {
    assert.equal(
      normalizeEvaluatorOutput({ summary: '  任务已完成，\n但漏了第三步。 ' }).summary,
      '任务已完成， 但漏了第三步。',
    );
    assert.equal(normalizeEvaluatorOutput({ summary: '   ' }).summary, undefined);
    const long = normalizeEvaluatorOutput({ summary: 'x'.repeat(500) }).summary!;
    assert.equal(long.length, 200);
    assert.ok(long.endsWith('…'));
  });

  it('结论字段可选，且不破坏既有退化组合', () => {
    const out = normalizeEvaluatorOutput({ verdict: 'warn', summary: '差一步', score: 65 });
    assert.deepEqual(out, { verdict: 'warn', summary: '差一步', score: 65 });
    assert.doesNotThrow(() => EvaluatorOutputSchema.parse(out));
    assert.deepEqual(normalizeEvaluatorOutput({ score: 72 }), { score: 72 });
  });

  it('deriveVerdict：80/60 分档，无分不派生', () => {
    assert.equal(deriveVerdict(100), 'pass');
    assert.equal(deriveVerdict(80), 'pass');
    assert.equal(deriveVerdict(79.9), 'warn');
    assert.equal(deriveVerdict(60), 'warn');
    assert.equal(deriveVerdict(59), 'fail');
    assert.equal(deriveVerdict(0), 'fail');
    assert.equal(deriveVerdict(null), undefined);
    assert.equal(deriveVerdict(undefined), undefined);
  });

  it('isEvidenceRedundant：证据与结论逐字相同才判重；证据更长时仍要展示', () => {
    // 预置评估器普遍把同一段 reason 既作 summary 又作 evidence
    assert.equal(isEvidenceRedundant('任务没完成，漏了来源 IP。', { md: '任务没完成，漏了来源 IP。' }), true);
    // 证据比结论长（summary 被截断过）→ 不判重，否则会把多出来的内容一起藏掉
    assert.equal(isEvidenceRedundant('任务没完成。', { md: '任务没完成。\n\n### 明细\n- 漏了来源 IP' }), false);
    assert.equal(isEvidenceRedundant('一句话结论', { json: { a: 1 } }), false);
    assert.equal(isEvidenceRedundant(null, null), false);
  });

  it('displaySummary：优先 summary，存量数据回退证据首段', () => {
    assert.equal(displaySummary('一句话结论', { md: '很长的证据' }), '一句话结论');
    // 契约加 summary 之前，结论一直被塞在 evidence.md 里
    assert.equal(
      displaySummary(null, { md: '任务未完成，缺少校验步骤。\n\n### 明细\n- 第一点\n- 第二点' }),
      '任务未完成，缺少校验步骤。',
    );
    assert.equal(displaySummary(null, { json: { a: 1 } }), undefined);
    assert.equal(displaySummary(null, null), undefined);
  });
});

describe('评估器注册表 registry', () => {
  const customWithRef: EvaluatorCard = {
    id: 'c1', name: 'compliance', description: '', evaluatorType: 'LLM', source: 'custom',
    targetTypes: [], objectives: [], scenarios: [], runMode: '', scoreRange: '', popularity: 0,
    mappedMetrics: [], status: 'ready', category: 'res',
    llmConfig: { model: 'deepseek-chat', systemPrompt: '对照 {{reference_output}} 评估 {{output}}' },
  };

  it('预置元数据声明结果/轨迹类目及参考答案、工具目录依赖', () => {
    const tc = getEvaluatorMeta({ id: 'preset-agent-task-completion', source: 'preset' } as EvaluatorCard);
    assert.deepEqual(tc, { category: 'res', requires: ['reference'] });
    const tq = getEvaluatorMeta({ id: 'preset-agent-trace-quality', source: 'preset' } as EvaluatorCard);
    assert.deepEqual(tq, { category: 'traj', requires: [] });
    const depth = getEvaluatorMeta({ id: 'preset-depth-result', source: 'preset' } as EvaluatorCard);
    assert.deepEqual(depth, { category: 'res', requires: [] });
    for (const id of ['preset-agent-tool-utilization', 'preset-agent-tool-selection']) {
      const toolMeta = getEvaluatorMeta({ id, source: 'preset' } as EvaluatorCard);
      assert.deepEqual(toolMeta, { category: 'traj', requires: ['tool_catalog'] });
    }
  });

  it('自建评估器 requires 由提示词占位符推导', () => {
    assert.deepEqual(getEvaluatorMeta(customWithRef).requires, ['reference']);
    const noRef = { ...customWithRef, llmConfig: { model: 'm', systemPrompt: '评估 {{output}}' } };
    assert.deepEqual(getEvaluatorMeta(noRef).requires, []);
  });

  it('标签派生包含 来源/类型/类目/依赖参考数据', () => {
    assert.deepEqual(deriveEvaluatorTags(customWithRef), ['自建', 'LLM Judge', '看结果', '依赖参考数据']);
  });

  it('硬门控要求所有 case 满足参考答案或 Tool/Skill 目录依赖', () => {
    const meta = { category: 'res' as const, requires: ['reference' as const] };
    const g1 = gateEvaluator(meta, [
      { hasReference: true, hasToolCatalog: false },
      { hasReference: false, hasToolCatalog: false },
    ]);
    assert.equal(g1.usable, false);
    assert.match(g1.reason ?? '', /1 个未标注/);
    assert.equal(gateEvaluator(meta, [{ hasReference: true, hasToolCatalog: false }]).usable, true);
    assert.equal(gateEvaluator(meta, []).usable, false);
    assert.equal(gateEvaluator({ category: 'traj', requires: [] }, []).usable, true);

    const toolMeta = { category: 'traj' as const, requires: ['tool_catalog' as const] };
    assert.equal(gateEvaluator(toolMeta, [{ hasReference: false, hasToolCatalog: true }]).usable, true);
    assert.equal(gateEvaluator(toolMeta, [{ hasReference: false, hasToolCatalog: false }]).usable, false);
  });
});
