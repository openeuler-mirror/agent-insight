/**
 * similarity 族评估器全链路测试（文本相似度 / 客观答案匹配）
 *
 * 注入点在 setJudgeLlmCallerForTest（judge 边界），测试完整走：
 * 提取 JSON → 档位映射 / 信息点归组 → 代码层匹配 → 计分汇总。
 *
 * 文本相似度：LLM 五档判定 → 固定分数；合格阈值可由实验级运行配置覆盖（默认 80）。
 * 客观答案匹配：信息点提取(LLM) → 代码层精确匹配(数值/专有名词) → LLM 层语义判同 → 加权扣分。
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { setJudgeLlmCallerForTest } from '../src/lib/engine/experiment/judge-llm';
import type { FaithfulPresetContext } from '../src/lib/engine/experiment/faithful-preset-evaluators';
import { runTextSimilarity } from '../src/lib/engine/experiment/similarity-text-evaluator';
import {
  DEFAULT_SIMILARITY_TEXT_RUN_CONFIG,
  normalizeSimilarityTextRunConfig,
} from '../src/lib/evaluators/evaluator-run-config';
import {
  runAnswerMatch,
  transferChineseNumber,
  extractAllNumbers,
  extractNumberOccurrences,
} from '../src/lib/engine/experiment/similarity-answer-match-evaluator';

const USER = 'test';

function simCtx(
  actualOutput: string,
  referenceOutput: string | null,
  caseInput = '',
): FaithfulPresetContext {
  return {
    caseInput,
    actualOutput,
    referenceOutput,
    traceSummaryText: null,
    interactions: [],
    taskId: null,
    executionId: null,
    user: null,
    execution: null,
  };
}

/** 注入固定 judge 返回。 */
function inject(json: string): void {
  setJudgeLlmCallerForTest(async () => json);
}

/** 按调用顺序依次返回（客观答案匹配会先提取、后判同，最多 2 次）。 */
function injectSequence(...jsons: string[]): void {
  let i = 0;
  setJudgeLlmCallerForTest(async () => {
    const j = jsons[Math.min(i, jsons.length - 1)];
    i += 1;
    return j;
  });
}

afterEach(() => {
  setJudgeLlmCallerForTest(null);
});

// ============ 数值工具（代码层匹配的基础） ============
describe('中文数字 → 数值', () => {
  it('基本数字', () => {
    assert.strictEqual(transferChineseNumber('十'), 10);
    assert.strictEqual(transferChineseNumber('四十二'), 42);
    assert.strictEqual(transferChineseNumber('一百二十三'), 123);
    assert.strictEqual(transferChineseNumber('一千零五十'), 1050);
    assert.strictEqual(transferChineseNumber('两'), 2);
    assert.strictEqual(transferChineseNumber('一百亿'), 10000000000);
  });
  it('无法解析 → null', () => {
    assert.strictEqual(transferChineseNumber('abc'), null);
    assert.strictEqual(transferChineseNumber(''), null);
  });
});

describe('从文本提取数值', () => {
  it('阿拉伯 + 中文混合', () => {
    assert.deepStrictEqual(extractAllNumbers('3.14 与 42 和 四十二'), [3.14, 42, 42]);
    assert.deepStrictEqual(extractAllNumbers('1234.5 亿元'), [1234.5]);
    assert.deepStrictEqual(extractAllNumbers('营收大幅增长'), []);
  });
  it('阿拉伯数字后的量级词并入数值，单位写法不被拆', () => {
    assert.deepStrictEqual(extractAllNumbers('1万'), [10000]);
    assert.deepStrictEqual(extractAllNumbers('3.5亿'), [350000000]);
    assert.deepStrictEqual(extractAllNumbers('3.5亿元'), [3.5]); // 亿元是单位，不拆成 3.5 万元
    assert.deepStrictEqual(extractAllNumbers('5千元'), [5000]);
    assert.deepStrictEqual(extractNumberOccurrences('3千米'), [{ value: 3, unit: '千米' }]);
    assert.deepStrictEqual(extractNumberOccurrences('100万人'), [{ value: 1000000, unit: '人' }]);
  });
});

describe('数值与单位提取', () => {
  it('识别单位并归一化等价写法', () => {
    assert.deepStrictEqual(extractNumberOccurrences('100℃'), [{ value: 100, unit: 'c' }]);
    assert.deepStrictEqual(extractNumberOccurrences('100 °C'), [{ value: 100, unit: 'c' }]);
    assert.deepStrictEqual(extractNumberOccurrences('100 摄氏度'), [{ value: 100, unit: 'c' }]);
    assert.deepStrictEqual(extractNumberOccurrences('1234.5 亿元'), [{ value: 1234.5, unit: '亿元' }]);
    assert.deepStrictEqual(extractNumberOccurrences('耗时 5 min'), [{ value: 5, unit: 'min' }]);
  });
  it('单位只出现在范围末尾时各数值共用该单位', () => {
    assert.deepStrictEqual(extractNumberOccurrences('100-200℃'), [
      { value: 100, unit: 'c' },
      { value: 200, unit: 'c' },
    ]);
    assert.deepStrictEqual(extractNumberOccurrences('100℃-200℃'), [
      { value: 100, unit: 'c' },
      { value: 200, unit: 'c' },
    ]);
  });
  it('范围连接符不当作负号，真正的负号保留', () => {
    assert.deepStrictEqual(extractNumberOccurrences('范围 10-20'), [
      { value: 10, unit: null },
      { value: 20, unit: null },
    ]);
    assert.deepStrictEqual(extractNumberOccurrences('零下 -5℃'), [{ value: -5, unit: 'c' }]);
  });
  it('无单位或单位不可识别时为 null', () => {
    assert.deepStrictEqual(extractNumberOccurrences('面积 15，周长 16'), [
      { value: 15, unit: null },
      { value: 16, unit: null },
    ]);
  });
});

// ============ 文本相似度（LLM 模式，阈值 80） ============
describe('文本相似度评估器', () => {
  it('完全相同文本 → 100 PASS（用例：完全相同的文本）', async () => {
    inject(JSON.stringify({ level: 'semantically_same', reason: '两段文本完全相同' }));
    const r = await runTextSimilarity(USER, simCtx('The cat sat on the mat', 'The cat sat on the mat'));
    assert.strictEqual(r.score, 100);
    assert.strictEqual(r.verdict, 'pass');
    assert.strictEqual(r.points![0].status, 'covered');
  });

  it('同义改写 → 高分 PASS（用例 4：score >= 80）', async () => {
    inject(JSON.stringify({ level: 'mostly_similar', reason: '「提高工作效率」与「提升工作效率」为同义改写' }));
    const r = await runTextSimilarity(USER, simCtx('提高工作效率的方法包括合理规划时间', '如何提升工作效率？首先要做好时间管理'));
    assert.ok(r.score! >= 80);
    assert.strictEqual(r.verdict, 'pass');
  });

  it('语义不同但词汇重叠 → 低分 FAIL（用例 5：score <= 30）', async () => {
    inject(JSON.stringify({ level: 'not_similar', reason: '「苹果」是水果，「苹果手机」是数码产品，语义不同' }));
    const r = await runTextSimilarity(USER, simCtx('苹果很好吃', '苹果手机很好用'));
    assert.ok(r.score! <= 30);
    assert.strictEqual(r.verdict, 'fail');
  });

  it('边界——空文本 → 不给分（不入均分）且不调 LLM（用例 7）', async () => {
    let calls = 0;
    setJudgeLlmCallerForTest(async () => { calls += 1; return '{}'; });
    const r = await runTextSimilarity(USER, simCtx('', 'some text'));
    assert.strictEqual(r.score, undefined);
    assert.strictEqual(r.verdict, undefined);
    assert.match(r.summary!, /不记分/);
    assert.strictEqual(calls, 0);
  });

  it('参考文本为空 → 不给分且不调 LLM', async () => {
    let calls = 0;
    setJudgeLlmCallerForTest(async () => { calls += 1; return '{}'; });
    const r = await runTextSimilarity(USER, simCtx('some text', null));
    assert.strictEqual(r.score, undefined);
    assert.strictEqual(r.verdict, undefined);
    assert.strictEqual(calls, 0);
  });

  it('阈值判定——通过（score >= 80 → PASS）', async () => {
    inject(JSON.stringify({ level: 'mostly_similar', reason: '仅结尾标点差异，含义相同' }));
    const r = await runTextSimilarity(USER, simCtx('Hello World', 'Hello World!'));
    assert.ok(r.score! >= 80);
    assert.strictEqual(r.verdict, 'pass');
    assert.strictEqual(r.points![1].status, 'covered');
    assert.match(((r.points![1].evidence as { md?: string } | undefined)?.md ?? ''), /PASS/);
  });

  it('阈值判定——不通过（score < 80 → FAIL）', async () => {
    inject(JSON.stringify({ level: 'slightly_similar', reason: '仅有 Hello/World 两个词重叠，核心语义不同' }));
    const r = await runTextSimilarity(USER, simCtx('Hello World', 'Goodbye World'));
    assert.ok(r.score! < 80);
    assert.strictEqual(r.verdict, 'fail');
    assert.strictEqual(r.points![1].status, 'missing');
    assert.match(((r.points![1].evidence as { md?: string } | undefined)?.md ?? ''), /FAIL/);
  });

  it('中英文混合 → 部分相似（用例 10：score 60~80）', async () => {
    inject(JSON.stringify({ level: 'partially_similar', reason: 'AI 与人工智能语义对应，world 与 世界为双语混用、未完全同义' }));
    const r = await runTextSimilarity(USER, simCtx('AI 正在改变 world', '人工智能正在改变世界'));
    assert.ok(r.score! >= 60 && r.score! <= 80);
  });

  it('完全不同的文本 → 0 FAIL（用例 3 语义）', async () => {
    inject(JSON.stringify({ level: 'not_similar', reason: '量子计算与天气毫无关联' }));
    const r = await runTextSimilarity(USER, simCtx('Quantum computing is emerging', 'The weather is nice today'));
    assert.strictEqual(r.score, 0);
    assert.strictEqual(r.verdict, 'fail');
  });

  it('轻微编辑差异 → 高度相似 PASS（用例 2 语义）', async () => {
    inject(JSON.stringify({ level: 'mostly_similar', reason: '漏掉冠词 the，不影响语义' }));
    const r = await runTextSimilarity(USER, simCtx('The cat sat on mat', 'The cat sat on the mat'));
    assert.strictEqual(r.score, 85);
    assert.strictEqual(r.verdict, 'pass');
  });

  it('阈值默认 80，非法值由配置校验拦下（不静默回退）', () => {
    assert.strictEqual(DEFAULT_SIMILARITY_TEXT_RUN_CONFIG.threshold, 80);
    assert.strictEqual(normalizeSimilarityTextRunConfig(undefined).threshold, 80);
    assert.strictEqual(normalizeSimilarityTextRunConfig(null).threshold, 80);
    assert.strictEqual(normalizeSimilarityTextRunConfig({ threshold: 60.4 }).threshold, 60); // 小数取整
    assert.throws(() => normalizeSimilarityTextRunConfig({ threshold: 150 }), /0 到 100/);
    assert.throws(() => normalizeSimilarityTextRunConfig({ threshold: -1 }), /0 到 100/);
    assert.throws(() => normalizeSimilarityTextRunConfig({ threshold: '80' }), /0 到 100/);
    assert.throws(() => normalizeSimilarityTextRunConfig({ threshold: true }), /0 到 100/);
  });

  it('未配置阈值 → 用默认 80 判定', async () => {
    inject(JSON.stringify({ level: 'partially_similar', reason: '部分语义重合' }));
    const r = await runTextSimilarity(USER, simCtx('a', 'b'));
    assert.strictEqual(r.score, 65);
    assert.strictEqual(r.verdict, 'fail'); // 65 < 80
  });

  it('阈值可配置：threshold=60 → partially_similar(65) PASS（默认 80 下该档 FAIL）', async () => {
    inject(JSON.stringify({ level: 'partially_similar', reason: '部分语义重合' }));
    const r = await runTextSimilarity(USER, simCtx('a', 'b'), { threshold: 60 });
    assert.strictEqual(r.score, 65);
    assert.strictEqual(r.verdict, 'pass');
    assert.match(((r.points![1].evidence as { md?: string } | undefined)?.md ?? ''), /PASS/);
    assert.match(((r.points![1].evidence as { md?: string } | undefined)?.md ?? ''), /≥ 60|≥60/);
  });

  it('阈值可配置：threshold=90 → mostly_similar(85) FAIL（默认 80 下该档 PASS）', async () => {
    inject(JSON.stringify({ level: 'mostly_similar', reason: '高度相似' }));
    const r = await runTextSimilarity(USER, simCtx('a', 'b'), { threshold: 90 });
    assert.strictEqual(r.score, 85);
    assert.strictEqual(r.verdict, 'fail');
    assert.match(((r.points![1].evidence as { md?: string } | undefined)?.md ?? ''), /FAIL/);
    assert.match(((r.points![1].evidence as { md?: string } | undefined)?.md ?? ''), /< 90/);
  });

  it('LLM 返回未知档位 → 抛解析错误（可重试）', async () => {
    inject(JSON.stringify({ level: 'sort_of_similar', reason: 'x' }));
    await assert.rejects(
      () => runTextSimilarity(USER, simCtx('a', 'b')),
      /未知的相似度档位/,
    );
  });

  it('JSON fence 容错解析', async () => {
    inject('```json\n' + JSON.stringify({ level: 'not_similar', reason: '不同' }) + '\n```');
    const r = await runTextSimilarity(USER, simCtx('a', 'b'));
    assert.strictEqual(r.score, 0);
  });
});


// ============ 客观答案匹配（三阶段混合） ============
describe('客观答案匹配评估器', () => {
  it('用例 1：完全匹配——同义表述（回答 10，标准 十）→ 100', async () => {
    injectSequence(
      JSON.stringify({ points: [{ type: 'number', text: '十' }] }),
      JSON.stringify({ judgments: [{ index: 1, result: 'matched', reason: '回答的 10 即标准答案的十' }] }),
    );
    const r = await runAnswerMatch(USER, simCtx('10', '十', '100 的平方根是多少？'));
    assert.strictEqual(r.score, 100);
    assert.strictEqual(r.points![0].status, 'covered');
    assert.match(((r.points![0].evidence as { md?: string } | undefined)?.md ?? ''), /LLM 层语义判同/);
  });

  it('用例 2：格式不同但等价（3.14 vs 3.14159）→ 50（部分覆盖）', async () => {
    injectSequence(JSON.stringify({ points: [{ type: 'number', text: '3.14159' }] }));
    const r = await runAnswerMatch(USER, simCtx('3.14', '3.14159...', '圆周率前三位？'));
    assert.strictEqual(r.score, 50);
    assert.strictEqual(r.points![0].status, 'partial');
    assert.match(((r.points![0].evidence as { md?: string } | undefined)?.md ?? ''), /截断/);
  });

  it('部分覆盖时 summary 不自称「与标准答案一致」', async () => {
    injectSequence(JSON.stringify({ points: [{ type: 'number', text: '3.14159' }] }));
    const r = await runAnswerMatch(USER, simCtx('3.14', '3.14159...', '圆周率前三位？'));
    assert.strictEqual(r.verdict, 'fail');
    assert.match(r.summary!, /部分覆盖/);
    assert.doesNotMatch(r.summary!, /一致/);
  });

  it('用例 3：同义转述（LLM 层）→ 100', async () => {
    injectSequence(
      JSON.stringify({ points: [{ type: 'conclusion', text: 'Transformer 的核心是 Self-Attention 机制' }] }),
      JSON.stringify({
        judgments: [{ index: 1, result: 'matched', reason: '回答以「自注意力机制」描述同一概念' }],
      }),
    );
    const r = await runAnswerMatch(USER, simCtx(
      '自注意力机制允许模型在编码时关注输入序列的所有位置',
      'Transformer 的核心是 Self-Attention 机制，它能捕捉序列中任意两个位置之间的依赖关系',
      'Transformer 的核心机制是什么？',
    ));
    assert.strictEqual(r.score, 100);
    assert.match(((r.points![0].evidence as { md?: string } | undefined)?.md ?? ''), /LLM 层语义判同/);
  });

  it('用例 4：关键数值缺失 → 30（数值 -20）', async () => {
    injectSequence(
      JSON.stringify({ points: [{ type: 'number', text: '1234.5' }, { type: 'conclusion', text: '营收为 1234.5 亿元' }] }),
      JSON.stringify({
        judgments: [
          { index: 1, result: 'not_matched', reason: '回答未提及任何具体数值' },
          { index: 2, result: 'matched', reason: '回答提到营收增长' },
        ],
      }),
    );
    const r = await runAnswerMatch(USER, simCtx('营收大幅增长', '营收为 1234.5 亿元', '2023 年公司营收是多少？'));
    assert.ok(r.score! <= 30);
    assert.strictEqual(r.verdict, 'fail');
  });

  it('用例 5：专有名词错误（TensorFlow vs PyTorch）→ 0', async () => {
    injectSequence(
      JSON.stringify({ points: [{ type: 'term', text: 'PyTorch' }] }),
      JSON.stringify({ judgments: [{ index: 1, result: 'not_matched', reason: '回答说的是 TensorFlow' }] }),
    );
    const r = await runAnswerMatch(USER, simCtx('TensorFlow', 'PyTorch', '最流行的深度学习框架？'));
    assert.strictEqual(r.score, 0);
  });

  it('用例 6：回答完全正确但多了无关信息 → 100', async () => {
    injectSequence(JSON.stringify({ points: [{ type: 'term', text: 'H2O' }] }));
    const r = await runAnswerMatch(USER, simCtx('水的化学式是 H2O，它是一种无色无味的液体', 'H2O', '水的化学式？'));
    assert.strictEqual(r.score, 100);
  });

  it('用例 7：回答正确但语序完全不同 → 100（LLM 判同）', async () => {
    injectSequence(
      JSON.stringify({ points: [{ type: 'conclusion', text: '先有蛋' }] }),
      JSON.stringify({ judgments: [{ index: 1, result: 'matched', reason: '回答同样给出「蛋」的结论' }] }),
    );
    const r = await runAnswerMatch(USER, simCtx(
      '蛋，因为根据进化论…',
      '先有蛋，因为基因突变发生在蛋的形成过程中',
      '先有鸡还是先有蛋？',
    ));
    assert.strictEqual(r.score, 100);
  });

  it('用例 8：核心结论遗漏 → 40（结论缺失 -10）', async () => {
    injectSequence(
      JSON.stringify({ points: [{ type: 'conclusion', text: '使用 Dropout' }, { type: 'conclusion', text: '使用正则化、早停和数据增强' }] }),
      JSON.stringify({
        judgments: [
          { index: 1, result: 'matched', reason: '回答明确提到 Dropout' },
          { index: 2, result: 'not_matched', reason: '回答未提及这些方法' },
        ],
      }),
    );
    const r = await runAnswerMatch(USER, simCtx('可以使用 Dropout', '防止过拟合的方法包括正则化、Dropout、早停和数据增强', '如何防止过拟合？'));
    assert.ok(r.score! >= 40 && r.score! <= 60);
  });

  it('用例 9：多个关键数值混合 → 100', async () => {
    injectSequence(
      JSON.stringify({ points: [{ type: 'number', text: '15' }, { type: 'number', text: '16' }] }),
      JSON.stringify({
        judgments: [
          { index: 1, result: 'matched', reason: '回答给出面积 15' },
          { index: 2, result: 'matched', reason: '回答给出周长 16' },
        ],
      }),
    );
    const r = await runAnswerMatch(USER, simCtx('面积 15，周长 16', '面积=15，周长=16', '长方形的长宽各为 5 和 3，面积和周长？'));
    assert.strictEqual(r.score, 100);
  });

  it('用例 10：回答与问题无关 → 0', async () => {
    injectSequence(
      JSON.stringify({ points: [{ type: 'term', text: '巴黎' }] }),
      JSON.stringify({ judgments: [{ index: 1, result: 'not_matched', reason: '回答说的是罗马' }] }),
    );
    const r = await runAnswerMatch(USER, simCtx('意大利的首都是罗马', '巴黎', '法国的首都是哪里？'));
    assert.strictEqual(r.score, 0);
  });

  it('边界：未标注标准答案 → 不给分（不入均分）且不调 LLM', async () => {
    let calls = 0;
    setJudgeLlmCallerForTest(async () => { calls += 1; return '{}'; });
    const r = await runAnswerMatch(USER, simCtx('some answer', null));
    assert.strictEqual(r.score, undefined);
    assert.strictEqual(r.verdict, undefined);
    assert.match(r.summary!, /不记分/);
    assert.strictEqual(calls, 0);
  });

  it('边界：标准答案无可提取信息点 → 不给分且不调判同', async () => {
    let calls = 0;
    setJudgeLlmCallerForTest(async () => {
      calls += 1;
      return JSON.stringify({ points: [] });
    });
    const r = await runAnswerMatch(USER, simCtx('some answer', '（无实质内容）'));
    assert.strictEqual(r.score, undefined);
    assert.strictEqual(r.verdict, undefined);
    assert.strictEqual(calls, 1); // 只调了提取，未调判同
  });

  it('判同返回遗漏信息点 → 抛解析错误（不静默当成未覆盖）', async () => {
    injectSequence(
      JSON.stringify({ points: [{ type: 'conclusion', text: 'A 结论' }, { type: 'conclusion', text: 'B 结论' }] }),
      JSON.stringify({ judgments: [{ index: 1, result: 'matched', reason: '回答包含' }] }), // 漏了序号 2
    );
    await assert.rejects(
      () => runAnswerMatch(USER, simCtx('A 结论', 'A 结论、B 结论', 'q')),
      /未对第 2 个信息点给出判定结果/,
    );
  });

  it('判同返回越界序号 → 抛解析错误（不误判为未覆盖）', async () => {
    injectSequence(
      JSON.stringify({ points: [{ type: 'conclusion', text: 'A 结论' }] }),
      JSON.stringify({ judgments: [{ index: 2, result: 'matched', reason: 'x' }] }),
    );
    await assert.rejects(
      () => runAnswerMatch(USER, simCtx('A 结论', 'A 结论', 'q')),
      /越界的信息点序号/,
    );
  });

  it('判同返回非法判定值 → 抛解析错误', async () => {
    injectSequence(
      JSON.stringify({ points: [{ type: 'conclusion', text: 'A 结论' }] }),
      JSON.stringify({ judgments: [{ index: 1, result: 'maybe', reason: 'x' }] }),
    );
    await assert.rejects(
      () => runAnswerMatch(USER, simCtx('A 结论', 'A 结论', 'q')),
      /非法的判定结果/,
    );
  });

  it('LLM 提取非法信息点类型 → 抛解析错误', async () => {
    injectSequence(JSON.stringify({ points: [{ type: 'key_fact', text: 'x' }] }));
    await assert.rejects(
      () => runAnswerMatch(USER, simCtx('a', 'b')),
      /未知的信息点类型/,
    );
  });

  it('核心结论缺失且覆盖超 50% → 总分上限 60', async () => {
    // 3 个点：结论 A/B 覆盖、结论 C 缺失 → base=67>50，上限 60，扣分 -10 → 57
    injectSequence(
      JSON.stringify({ points: [
        { type: 'conclusion', text: 'A 结论' },
        { type: 'conclusion', text: 'B 结论' },
        { type: 'conclusion', text: 'C 结论' },
      ] }),
      JSON.stringify({
        judgments: [
          { index: 1, result: 'matched', reason: '回答包含' },
          { index: 2, result: 'matched', reason: '回答包含' },
          { index: 3, result: 'not_matched', reason: '回答遗漏' },
        ],
      }),
    );
    const r = await runAnswerMatch(USER, simCtx('A 结论、B 结论', 'A 结论、B 结论、C 结论', 'q'));
    assert.ok(r.score! <= 60);
    assert.ok(r.score! >= 55);
  });

  it('数值单位一致 → 代码层精确匹配（不调判同）', async () => {
    injectSequence(JSON.stringify({ points: [{ type: 'number', text: '100℃' }] }));
    const r = await runAnswerMatch(USER, simCtx('水的沸点是 100℃', '水的沸点是 100℃', '水的沸点是多少？'));
    assert.strictEqual(r.score, 100);
    assert.match(((r.points![0].evidence as { md?: string } | undefined)?.md ?? ''), /代码层精确匹配：回答包含数值 100℃/);
  });

  it('单位别名等价（℃ 与 摄氏度）→ 代码层命中', async () => {
    injectSequence(JSON.stringify({ points: [{ type: 'number', text: '100 ℃' }] }));
    const r = await runAnswerMatch(USER, simCtx('沸点为 100 摄氏度', '沸点为 100 ℃', '水的沸点是多少？'));
    assert.strictEqual(r.score, 100);
    assert.match(((r.points![0].evidence as { md?: string } | undefined)?.md ?? ''), /代码层/);
  });

  it('数值相同但单位不同 → 代码层不判覆盖，交 LLM（100℃ vs 100℉）', async () => {
    const prompts: string[] = [];
    setJudgeLlmCallerForTest(async (_u, req) => {
      prompts.push(req.user);
      return prompts.length === 1
        ? JSON.stringify({ points: [{ type: 'number', text: '100℃' }] })
        : JSON.stringify({ judgments: [{ index: 1, result: 'not_matched', reason: '回答给的是华氏度，与标准答案的摄氏度不等价' }] });
    });
    const r = await runAnswerMatch(USER, simCtx('水的沸点是 100℉', '水的沸点是 100℃', '水的沸点是多少？'));
    assert.strictEqual(prompts.length, 2); // 代码层未命中，走到判同
    assert.strictEqual(r.score, 0);
    assert.match(((r.points![0].evidence as { md?: string } | undefined)?.md ?? ''), /LLM 层/);
  });

  it('数值范围只命中第一个数值 → 代码层不判覆盖，交 LLM', async () => {
    injectSequence(
      JSON.stringify({ points: [{ type: 'number', text: '100-200℃' }] }),
      JSON.stringify({ judgments: [{ index: 1, result: 'not_matched', reason: '回答只给出 100℃，缺少 200℃' }] }),
    );
    const r = await runAnswerMatch(USER, simCtx('反应温度 100℃', '反应温度 100-200℃', '反应温度范围？'));
    assert.strictEqual(r.score, 0);
    assert.match(((r.points![0].evidence as { md?: string } | undefined)?.md ?? ''), /LLM 层/);
  });

  it('数值范围全部命中 → 代码层精确匹配', async () => {
    injectSequence(JSON.stringify({ points: [{ type: 'number', text: '100-200℃' }] }));
    const r = await runAnswerMatch(USER, simCtx('反应温度 100℃ 到 200℃', '反应温度 100-200℃', '反应温度范围？'));
    assert.strictEqual(r.score, 100);
    assert.match(((r.points![0].evidence as { md?: string } | undefined)?.md ?? ''), /代码层精确匹配/);
  });

  it('数量级词换算后与等值数值命中（1亿吨 vs 100000000 吨）', async () => {
    injectSequence(JSON.stringify({ points: [{ type: 'number', text: '1亿吨' }] }));
    const r = await runAnswerMatch(USER, simCtx('产量为 100000000 吨', '产量为 1亿吨', '产量是多少？'));
    assert.strictEqual(r.score, 100);
    assert.match(((r.points![0].evidence as { md?: string } | undefined)?.md ?? ''), /代码层精确匹配/);
  });

  it('数量级词不再让错答拿满分（3.5亿 vs 3.5）', async () => {
    const prompts: string[] = [];
    setJudgeLlmCallerForTest(async (_u, req) => {
      prompts.push(req.user);
      return prompts.length === 1
        ? JSON.stringify({ points: [{ type: 'number', text: '3.5亿' }] })
        : JSON.stringify({ judgments: [{ index: 1, result: 'not_matched', reason: '回答给的 3.5 与标准答案的 3.5 亿不在同一量级' }] });
    });
    const r = await runAnswerMatch(USER, simCtx('营收约 3.5', '营收 3.5亿', '营收是多少？'));
    assert.strictEqual(prompts.length, 2); // 代码层对这一对不再判命中
    assert.strictEqual(r.score, 0);
  });

  it('裸数值代码层命中不终判，交判同复核语境 → 0', async () => {
    const prompts: string[] = [];
    setJudgeLlmCallerForTest(async (_u, req) => {
      prompts.push(req.user);
      return prompts.length === 1
        ? JSON.stringify({ points: [{ type: 'number', text: '3' }] })
        : JSON.stringify({ judgments: [{ index: 1, result: 'not_matched', reason: '回答中的 3 是分点序号，未给出所问数值' }] });
    });
    const r = await runAnswerMatch(USER, simCtx('以下 3 点说明这个问题：第一……', '答案是 3', '答案是几？'));
    assert.strictEqual(prompts.length, 2); // 代码层虽命中，仍需判同确认语境
    assert.strictEqual(r.score, 0);
    assert.match(((r.points![0].evidence as { md?: string } | undefined)?.md ?? ''), /LLM 层/);
  });

  it('带单位的数值命中仍是代码层终判（不调判同）', async () => {
    const prompts: string[] = [];
    setJudgeLlmCallerForTest(async (_u, req) => {
      prompts.push(req.user);
      return prompts.length === 1
        ? JSON.stringify({ points: [{ type: 'number', text: '100℃' }] })
        : JSON.stringify({ judgments: [{ index: 1, result: 'not_matched', reason: '不应走到判同' }] });
    });
    const r = await runAnswerMatch(USER, simCtx('水的沸点是 100℃', '水的沸点是 100℃', '水的沸点是多少？'));
    assert.strictEqual(prompts.length, 1);
    assert.strictEqual(r.score, 100);
  });

  it('整数前缀不是精度截断（25 vs 2）→ 未覆盖而非部分覆盖', async () => {
    injectSequence(
      JSON.stringify({ points: [{ type: 'number', text: '25' }] }),
      JSON.stringify({ judgments: [{ index: 1, result: 'not_matched', reason: '回答给的是 2，不是 25' }] }),
    );
    const r = await runAnswerMatch(USER, simCtx('有 2 个', '有 25 个', '有多少个质数？'));
    assert.strictEqual(r.points![0].status, 'missing');
    assert.strictEqual(r.score, 0);
  });

  it('报告按标准答案的信息点顺序展开（代码层命中不重排）', async () => {
    injectSequence(
      JSON.stringify({ points: [
        { type: 'conclusion', text: '结论 A' },
        { type: 'number', text: '100℃' },
        { type: 'term', text: 'BERT' },
      ] }),
      JSON.stringify({ judgments: [{ index: 1, result: 'matched', reason: '回答给出结论 A' }] }),
    );
    const r = await runAnswerMatch(USER, simCtx('结论 A，温度 100℃，模型是 BERT', '结论 A、100℃、BERT', 'q'));
    assert.deepStrictEqual(r.points!.map((p) => p.label), [
      '核心结论：结论 A',
      '关键数值：100℃',
      '专有名词：BERT',
    ]);
  });

  it('单字母术语不再子串误命中（C 不命中 CPU）', async () => {
    injectSequence(
      JSON.stringify({ points: [{ type: 'term', text: 'C' }] }),
      JSON.stringify({ judgments: [{ index: 1, result: 'not_matched', reason: '回答说的是 CPU 利用率，未提及 C 语言' }] }),
    );
    const r = await runAnswerMatch(USER, simCtx('CPU 利用率很高', 'C 语言', '哪种语言？'));
    assert.strictEqual(r.score, 0);
    assert.match(((r.points![0].evidence as { md?: string } | undefined)?.md ?? ''), /LLM 层/);
  });

  it('单字母术语按词边界命中（C 语言 → 代码层）', async () => {
    injectSequence(JSON.stringify({ points: [{ type: 'term', text: 'C' }] }));
    const r = await runAnswerMatch(USER, simCtx('C 是编译型语言', 'C', '哪种语言？'));
    assert.strictEqual(r.score, 100);
    assert.match(((r.points![0].evidence as { md?: string } | undefined)?.md ?? ''), /代码层精确匹配/);
  });

  it('术语命中要求词边界（art 不命中 start）', async () => {
    injectSequence(
      JSON.stringify({ points: [{ type: 'term', text: 'art' }] }),
      JSON.stringify({ judgments: [{ index: 1, result: 'not_matched', reason: '回答中出现的是 start 一词' }] }),
    );
    const r = await runAnswerMatch(USER, simCtx('Please start over', 'art', 'q'));
    assert.strictEqual(r.score, 0);
    assert.match(((r.points![0].evidence as { md?: string } | undefined)?.md ?? ''), /LLM 层/);
  });

  it('单个汉字术语子串无法界定边界 → 交 LLM（判同后可恢复满分）', async () => {
    let calls = 0;
    setJudgeLlmCallerForTest(async () => {
      calls += 1;
      return calls === 1
        ? JSON.stringify({ points: [{ type: 'term', text: '水' }] })
        : JSON.stringify({ judgments: [{ index: 1, result: 'matched', reason: '回答明确指出这种液体是水' }] });
    });
    const r = await runAnswerMatch(USER, simCtx('这种液体是水', '水', 'q'));
    assert.strictEqual(calls, 2); // 代码层未命中 → 走了判同
    assert.strictEqual(r.score, 100);
  });

  it('提取阶段把用户问题一并传给 LLM', async () => {
    const prompts: string[] = [];
    setJudgeLlmCallerForTest(async (_u, req) => {
      prompts.push(req.user);
      return prompts.length === 1
        ? JSON.stringify({ points: [{ type: 'conclusion', text: 'A 结论' }] })
        : JSON.stringify({ judgments: [{ index: 1, result: 'matched', reason: '回答即该结论' }] });
    });
    await runAnswerMatch(USER, simCtx('A 结论', '标准答案正文（含背景说明）', '用户问题正文'));
    assert.match(prompts[0], /【用户问题】/);
    assert.match(prompts[0], /用户问题正文/);
    assert.match(prompts[0], /标准答案正文/);
  });
});

