import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gradeRouge, tokenizeRougeText } from '@/lib/engine/evaluation/rouge-grader';

const words = (text: string) => text.toLowerCase().trim().split(/\s+/u).filter(Boolean);
const close = (actual: number, expected: number, tolerance = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
};

describe('ROUGEGrader', () => {
  it('完全相同的文本得到满分', () => {
    const result = gradeRouge('the cat sat on the mat', 'the cat sat on the mat', { tokenizer: words });
    assert.equal(result.score, 1);
    assert.equal(result.reason.rouge1.f1, 1);
    assert.equal(result.reason.rouge2.f1, 1);
    assert.equal(result.reason.rougeL.f1, 1);
  });

  it('部分覆盖按三个 F1 的算术平均计分', () => {
    const result = gradeRouge('the cat on the mat', 'the cat sat on the mat', { tokenizer: words });
    close(result.reason.rouge1.f1, 10 / 11);
    close(result.reason.rouge2.f1, 2 / 3);
    close(result.reason.rougeL.f1, 10 / 11);
    close(result.score, 0.8282828282828283);
  });

  it('完全无关文本得到零分', () => {
    assert.equal(gradeRouge('quantum computing', 'sunny weather', { tokenizer: words }).score, 0);
  });

  it('空生成文本得到零分', () => {
    assert.equal(gradeRouge('', 'some reference text', { tokenizer: words }).score, 0);
  });

  it('生成文本远长于参考时召回率为一但精确率下降', () => {
    const result = gradeRouge(
      'the cat sat on the mat and looked around the room then jumped off',
      'the cat sat on the mat',
      { tokenizer: words },
    );
    assert.equal(result.reason.rouge1.recall, 1);
    assert.equal(result.reason.rouge2.recall, 1);
    close(result.score, 0.5851851851851851);
  });

  it('极短生成文本保留高精确率和低召回率', () => {
    const result = gradeRouge('cat mat', 'the cat sat on the mat', { tokenizer: words });
    assert.equal(result.reason.rouge1.precision, 1);
    close(result.reason.rouge1.recall, 1 / 3);
    close(result.score, 1 / 3);
  });

  it('语序打乱时分别反映 bigram 与 LCS 差异', () => {
    const result = gradeRouge('on the mat sat the cat', 'the cat sat on the mat', { tokenizer: words });
    close(result.reason.rouge2.f1, 0.6);
    close(result.reason.rougeL.f1, 0.5);
    close(result.score, 0.7);
  });

  it('附加无关信息会降低精确率', () => {
    const result = gradeRouge(
      'the cat sat on the mat and it was sunny outside',
      'the cat sat on the mat',
      { tokenizer: words },
    );
    assert.equal(result.reason.rouge1.recall, 1);
    assert.ok(result.reason.rouge1.precision < 0.6);
    close(result.score, 0.6928104575163397);
  });

  it('默认分词对含中文文本使用字符级 ROUGE 并忽略标点', () => {
    const tokenized = tokenizeRougeText('苹果发布新款 iPhone！');
    assert.equal(tokenized.tokenizer, 'unicode-char(cjk)');
    assert.deepEqual(tokenized.tokens, ['苹', '果', '发', '布', '新', '款', 'i', 'p', 'h', 'o', 'n', 'e']);
    assert.ok(!tokenized.tokens.includes('！'));
  });

  it('中文摘要按确定性字符重叠计算而不引入语义相似度', () => {
    const r03 = gradeRouge(
      '苹果发布新款 iPhone',
      '苹果公司在秋季发布会上正式推出了全新的 iPhone 系列手机',
    );
    assert.equal(r03.reason.tokenizer, 'unicode-char(cjk)');
    close(r03.reason.rouge1.f1, 22 / 41);
    close(r03.reason.rouge2.f1, 14 / 39);
    close(r03.reason.rougeL.f1, 22 / 41);
    close(r03.score, ((22 / 41) + (14 / 39) + (22 / 41)) / 3);

    const r04 = gradeRouge('量子计算是前沿技术', '今天天气很好适合出去散步');
    assert.equal(r04.score, 0);

    const r07 = gradeRouge('人工智能改变世界', '人工智能正在改变整个世界');
    close(r07.reason.rouge1.f1, 0.8);
    close(r07.reason.rouge2.f1, 5 / 9);
    close(r07.reason.rougeL.f1, 0.8);
    close(r07.score, 0.7185185185185184);
  });
});
