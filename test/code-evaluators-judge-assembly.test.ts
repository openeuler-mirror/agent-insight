import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runCodeEvaluator,
  isCodeEvaluatorId,
  CODE_EVALUATOR_IDS,
  CODE_EVAL_BUDGETS,
} from '../src/lib/evaluators/code-evaluators';
import {
  buildJudgePrompt,
  parseJudgeText,
  replacePlaceholders,
  JudgeOutputParseError,
} from '../src/lib/evaluators/judge-assembly';
import { presetEvaluators } from '../src/lib/evaluators/preset-evaluators';
import { getEvaluatorMeta } from '../src/lib/evaluators/registry';
import type { EvaluatorCard } from '../src/lib/evaluators/custom-evaluator-model';

describe('预置代码评估器', () => {
  it('五个 id 均已登记卡片且注册表类目=traj、无前置条件', () => {
    for (const id of CODE_EVALUATOR_IDS) {
      const card = presetEvaluators.find((c) => c.id === id);
      assert.ok(card, `${id} 缺卡片`);
      assert.equal(card!.evaluatorType, 'Code');
      const meta = getEvaluatorMeta(card!);
      assert.equal(meta.category, 'traj');
      assert.deepEqual(meta.requires, []);
    }
    assert.equal(isCodeEvaluatorId('preset-agent-task-completion'), false);
    assert.equal(runCodeEvaluator('unknown-id', {}), null);
  });

  it('工具可靠性：错误率折算；零调用满分；缺统计不记分', () => {
    const out = runCodeEvaluator('preset-code-tool-reliability', { toolCallCount: 10, toolCallErrorCount: 2 })!;
    assert.equal(out.score, 80);
    assert.ok('json' in (out.evidence as object));
    assert.equal(runCodeEvaluator('preset-code-tool-reliability', { toolCallCount: 0 })!.score, 100);
    const noData = runCodeEvaluator('preset-code-tool-reliability', {})!;
    assert.equal(noData.score, undefined);
    assert.ok('md' in (noData.evidence as object));
  });

  it('时延/成本/Token 预算：预算内满分、超支按比例衰减、缺数据不记分', () => {
    const b = CODE_EVAL_BUDGETS;
    assert.equal(runCodeEvaluator('preset-code-latency-budget', { latencySec: b.latencySec / 2 })!.score, 100);
    assert.equal(runCodeEvaluator('preset-code-latency-budget', { latencySec: b.latencySec * 2 })!.score, 50);
    assert.equal(runCodeEvaluator('preset-code-latency-budget', {})!.score, undefined);
    assert.equal(runCodeEvaluator('preset-code-cost-budget', { costUsd: b.costUsd * 4 })!.score, 25);
    // 单价缺失 → 不记分（而非 0 成本满分）
    const missing = runCodeEvaluator('preset-code-cost-budget', { costMissing: true, model: 'glm-x' })!;
    assert.equal(missing.score, undefined);
    assert.match((missing.evidence as { md: string }).md, /缺单价/);
    assert.equal(runCodeEvaluator('preset-code-token-efficiency', { totalTokens: b.tokensPerTask * 2 })!.score, 50);
  });

  it('冗余循环：连续 run≥3 计冗余步，高频调用入证据；无序列不记分', () => {
    const names = ['read', 'read', 'read', 'read', 'edit', 'bash', 'read', 'grep', 'grep'];
    const out = runCodeEvaluator('preset-code-redundancy-loop', { toolCallNames: names })!;
    // 连续 read×4 → 冗余 3 步 / 9 步
    const ev = (out.evidence as { json: { redundantSteps: number; consecutiveSameRuns: unknown[]; heavyRepeatedCalls: Array<{ name: string }> } }).json;
    assert.equal(ev.redundantSteps, 3);
    assert.equal(ev.consecutiveSameRuns.length, 1);
    assert.equal(ev.heavyRepeatedCalls[0]?.name, 'read'); // read 共 5 次 ≥5
    assert.equal(out.score, 66.7);
    assert.equal(runCodeEvaluator('preset-code-redundancy-loop', {})!.score, undefined);
  });
});

describe('LLM Judge 三段式组装', () => {
  const card: EvaluatorCard = {
    id: 'c1', name: 'compliance', description: '', evaluatorType: 'LLM', source: 'custom',
    targetTypes: [], objectives: [], scenarios: [], runMode: '', scoreRange: '', popularity: 0,
    mappedMetrics: [], status: 'ready', category: 'res',
    llmConfig: { model: 'deepseek-chat', systemPrompt: '评估客服回复。输入：{{input}}\n输出：{{output}}\n参考：{{reference_output}}' },
  };
  const ctx = { input: '查订单', output: '已查到', referenceOutput: '应查到并说明' };

  it('占位符替换：全量替换、缺省填(未提供)、未知占位符原样保留', () => {
    const s = replacePlaceholders('a {{input}} b {{ output }} c {{trajectory}} d {{unknown}}', ctx);
    assert.equal(s, 'a 查订单 b 已查到 c (未提供) d {{unknown}}');
  });

  it('自由模式：② 段为自行提取指令；用户提示词不被改写', () => {
    const p = buildJudgePrompt(card, ctx);
    assert.match(p.system, /输入：查订单/);
    assert.doesNotMatch(p.system, /评分点要求/); // 平台段不进用户提示词
    assert.match(p.user, /自行提取 2~6 个评分点/);
    assert.match(p.user, /只输出一个 JSON 对象/);
  });

  it('清单模式：② 段注入清单且 label 锁定说明', () => {
    const withPts = { ...card, pointsDef: [{ label: '礼貌用语', note: '敬语、无生硬否定' }, { label: '信息准确性' }] };
    const p = buildJudgePrompt(withPts, ctx);
    assert.match(p.user, /1\. 礼貌用语——敬语、无生硬否定/);
    assert.match(p.user, /2\. 信息准确性/);
    assert.match(p.user, /label 必须使用清单原文/);
  });

  it('输出解析：容忍代码块与杂文本；清单模式过滤清单外评分点', () => {
    const raw = '好的，评估如下：\n```json\n{"score": 0.86, "points": [{"label":"礼貌用语","score":90},{"label":"编造点","score":10}], "evidence": {"md":"总体合规"}}\n```\n以上。';
    const out = parseJudgeText(raw, [{ label: '礼貌用语' }]);
    assert.equal(out.score, 86); // 0-1 旧量纲自动放大
    assert.equal(out.points?.length, 1);
    assert.equal(out.points?.[0].label, '礼貌用语');
    assert.throws(() => parseJudgeText('抱歉我无法评估'), JudgeOutputParseError);
  });
});
