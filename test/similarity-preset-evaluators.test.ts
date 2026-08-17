/**
 * similarity 族评估器全链路测试（文本相似度 / 客观答案匹配）
 *
 * 注入点在 setJudgeLlmCallerForTest（judge 边界），测试完整走：
 * 提取 JSON → 档位映射 / 信息点归组 → 代码层匹配 → 计分汇总。
 *
 * 文本相似度：LLM 五档判定 → 固定分数；阈值写死 80。
 * 客观答案匹配：信息点提取(LLM) → 代码层精确匹配(数值/专有名词) → LLM 层语义判同 → 加权扣分。
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { setJudgeLlmCallerForTest } from '../src/lib/engine/experiment/judge-llm';
import type { FaithfulPresetContext } from '../src/lib/engine/experiment/faithful-preset-evaluators';
import {
  runTextSimilarity,
  TEXT_SIMILARITY_THRESHOLD,
} from '../src/lib/engine/experiment/similarity-text-evaluator';
import {
  runAnswerMatch,
  transferChineseNumber,
  extractAllNumbers,
} from '../src/lib/engine/experiment/similarity-answer-match-evaluator';

const USER = 'test';

function simCtx(actualOutput: string, referenceOutput: string | null, caseInput = ''): FaithfulPresetContext {
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

  it('边界——空文本 → 0 且不调 LLM（用例 7）', async () => {
    let calls = 0;
    setJudgeLlmCallerForTest(async () => { calls += 1; return '{}'; });
    const r = await runTextSimilarity(USER, simCtx('', 'some text'));
    assert.strictEqual(r.score, 0);
    assert.strictEqual(calls, 0);
  });

  it('参考文本为空 → 0 不调 LLM', async () => {
    let calls = 0;
    setJudgeLlmCallerForTest(async () => { calls += 1; return '{}'; });
    const r = await runTextSimilarity(USER, simCtx('some text', null));
    assert.strictEqual(r.score, 0);
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

  it('阈值常量写死 80', () => {
    assert.strictEqual(TEXT_SIMILARITY_THRESHOLD, 80);
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
    injectSequence(JSON.stringify({ points: [{ type: 'number', text: '十' }] }));
    const r = await runAnswerMatch(USER, simCtx('10', '十', '100 的平方根是多少？'));
    assert.strictEqual(r.score, 100);
    assert.strictEqual(r.points![0].status, 'covered');
    assert.match(((r.points![0].evidence as { md?: string } | undefined)?.md ?? ''), /代码层/);
  });

  it('用例 2：格式不同但等价（3.14 vs 3.14159）→ 50（部分覆盖）', async () => {
    injectSequence(JSON.stringify({ points: [{ type: 'number', text: '3.14159' }] }));
    const r = await runAnswerMatch(USER, simCtx('3.14', '3.14159...', '圆周率前三位？'));
    assert.strictEqual(r.score, 50);
    assert.strictEqual(r.points![0].status, 'partial');
    assert.match(((r.points![0].evidence as { md?: string } | undefined)?.md ?? ''), /截断/);
  });

  it('用例 3：同义转述（LLM 层）→ 100', async () => {
    injectSequence(
      JSON.stringify({ points: [{ type: 'conclusion', text: 'Transformer 的核心是 Self-Attention 机制' }] }),
      JSON.stringify({
        judgments: [{ point: 'Transformer 的核心是 Self-Attention 机制', result: 'matched', reason: '回答以「自注意力机制」描述同一概念' }],
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
          { point: '1234.5', result: 'not_matched', reason: '回答未提及任何具体数值' },
          { point: '营收为 1234.5 亿元', result: 'matched', reason: '回答提到营收增长' },
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
      JSON.stringify({ judgments: [{ point: 'PyTorch', result: 'not_matched', reason: '回答说的是 TensorFlow' }] }),
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
      JSON.stringify({ judgments: [{ point: '先有蛋', result: 'matched', reason: '回答同样给出「蛋」的结论' }] }),
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
          { point: '使用 Dropout', result: 'matched', reason: '回答明确提到 Dropout' },
          { point: '使用正则化、早停和数据增强', result: 'not_matched', reason: '回答未提及这些方法' },
        ],
      }),
    );
    const r = await runAnswerMatch(USER, simCtx('可以使用 Dropout', '防止过拟合的方法包括正则化、Dropout、早停和数据增强', '如何防止过拟合？'));
    assert.ok(r.score! >= 40 && r.score! <= 60);
  });

  it('用例 9：多个关键数值混合 → 100', async () => {
    injectSequence(JSON.stringify({ points: [{ type: 'number', text: '15' }, { type: 'number', text: '16' }] }));
    const r = await runAnswerMatch(USER, simCtx('面积 15，周长 16', '面积=15，周长=16', '长方形的长宽各为 5 和 3，面积和周长？'));
    assert.strictEqual(r.score, 100);
  });

  it('用例 10：回答与问题无关 → 0', async () => {
    injectSequence(
      JSON.stringify({ points: [{ type: 'term', text: '巴黎' }] }),
      JSON.stringify({ judgments: [{ point: '巴黎', result: 'not_matched', reason: '回答说的是罗马' }] }),
    );
    const r = await runAnswerMatch(USER, simCtx('意大利的首都是罗马', '巴黎', '法国的首都是哪里？'));
    assert.strictEqual(r.score, 0);
  });

  it('边界：未标注标准答案 → 0 且不调 LLM', async () => {
    let calls = 0;
    setJudgeLlmCallerForTest(async () => { calls += 1; return '{}'; });
    const r = await runAnswerMatch(USER, simCtx('some answer', null));
    assert.strictEqual(r.score, 0);
    assert.strictEqual(calls, 0);
  });

  it('边界：标准答案无可提取信息点 → 0 且不调判同', async () => {
    let calls = 0;
    setJudgeLlmCallerForTest(async () => {
      calls += 1;
      return JSON.stringify({ points: [] });
    });
    const r = await runAnswerMatch(USER, simCtx('some answer', '（无实质内容）'));
    assert.strictEqual(r.score, 0);
    assert.strictEqual(calls, 1); // 只调了提取，未调判同
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
          { point: 'A 结论', result: 'matched', reason: '回答包含' },
          { point: 'B 结论', result: 'matched', reason: '回答包含' },
          { point: 'C 结论', result: 'not_matched', reason: '回答遗漏' },
        ],
      }),
    );
    const r = await runAnswerMatch(USER, simCtx('A 结论、B 结论', 'A 结论、B 结论、C 结论', 'q'));
    assert.ok(r.score! <= 60);
    assert.ok(r.score! >= 55);
  });
});

