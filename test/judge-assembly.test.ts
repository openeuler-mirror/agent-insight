import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildJudgePrompt,
  parseJudgeText,
  replacePlaceholders,
  JudgeOutputParseError,
} from '../src/lib/evaluators/judge-assembly';
import {
  findUnsupportedCustomEvaluatorVariables,
  type EvaluatorCard,
} from '../src/lib/evaluators/custom-evaluator-model';

describe('LLM Judge 三段式组装', () => {
  const card: EvaluatorCard = {
    id: 'c1', name: 'compliance', description: '', evaluatorType: 'LLM', source: 'custom',
    targetTypes: [], objectives: [], scenarios: [], runMode: '', scoreRange: '', popularity: 0,
    mappedMetrics: [], status: 'ready', category: 'res',
    llmConfig: { model: 'deepseek-chat', systemPrompt: '评估客服回复。输入：{{input}}\n输出：{{output}}\n参考：{{reference_output}}' },
  };
  const ctx = {
    input: '客户背景：VIP。查订单',
    datasetInput: '查订单',
    output: '已查到',
    referenceOutput: '应查到并说明',
  };

  it('占位符替换：全量替换、缺省填(未提供)、未知占位符原样保留', () => {
    const s = replacePlaceholders('a {{input}} b {{dataset_input}} c {{ output }} d {{trajectory}} e {{unknown}}', ctx);
    assert.equal(s, 'a 客户背景：VIP。查订单 b 查订单 c 已查到 d (未提供) e {{unknown}}');
  });

  it('dataset_input 是受支持变量，未知变量仍会被拒绝', () => {
    assert.deepEqual(findUnsupportedCustomEvaluatorVariables('{{dataset_input}} {{output}}'), []);
    assert.deepEqual(findUnsupportedCustomEvaluatorVariables('{{dataset_input}} {{wrong_input}}'), ['wrong_input']);
  });

  it('自由模式：② 段为自行提取指令；用户提示词不被改写', () => {
    const p = buildJudgePrompt(card, ctx);
    assert.match(p.system, /输入：客户背景：VIP。查订单/);
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
