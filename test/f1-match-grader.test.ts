import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gradeF1Match, levenshteinDistance } from '@/lib/engine/evaluation/f1-match-grader';

const close = (actual: number, expected: number, tolerance = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
};

describe('F1MatchGrader', () => {
  it('完全准确的提取得满分', () => {
    const result = gradeF1Match(['北京', '上海', '广州'], ['北京', '上海', '广州']);
    assert.equal(result.score, 1);
    assert.deepEqual(
      [result.reason.truePositiveCount, result.reason.falsePositiveCount, result.reason.falseNegativeCount],
      [3, 0, 0],
    );
  });

  it('部分遗漏按 F1 公式得到 0.8', () => {
    const result = gradeF1Match(['北京', '上海'], ['北京', '上海', '广州']);
    assert.equal(result.reason.precision, 1);
    close(result.reason.recall, 2 / 3);
    close(result.score, 0.8);
  });

  it('误报按 F1 公式得到 0.8', () => {
    const result = gradeF1Match(['北京', '上海', '深圳'], ['北京', '上海']);
    close(result.reason.precision, 2 / 3);
    assert.equal(result.reason.recall, 1);
    close(result.score, 0.8);
  });

  it('同时存在遗漏和误报得到 0.4', () => {
    const result = gradeF1Match(['北京', '深圳'], ['北京', '上海', '广州']);
    assert.deepEqual(
      [result.reason.truePositiveCount, result.reason.falsePositiveCount, result.reason.falseNegativeCount],
      [1, 1, 2],
    );
    close(result.score, 0.4);
  });

  it('未提取实体时精确率为一、F1 为零', () => {
    const result = gradeF1Match([], ['北京', '上海']);
    assert.equal(result.reason.precision, 1);
    assert.equal(result.reason.recall, 0);
    assert.equal(result.score, 0);
  });

  it('标准集合为空时召回率为一、F1 为零', () => {
    const result = gradeF1Match(['北京'], []);
    assert.equal(result.reason.precision, 0);
    assert.equal(result.reason.recall, 1);
    assert.equal(result.score, 0);
  });

  it('提供 fuzzyThreshold 时自动启用模糊匹配', () => {
    const result = gradeF1Match(['北京市', '上海市'], ['北京', '上海', '广州'], { fuzzyThreshold: 2 });
    assert.equal(result.reason.config.matchMode, 'fuzzy');
    assert.equal(result.reason.truePositiveCount, 2);
    close(result.score, 0.8);
    assert.ok(result.reason.matched.every((pair) => pair.distance === 1));
  });

  it('子串匹配支持实体包含关系', () => {
    assert.equal(gradeF1Match(['北京'], ['北京市'], { matchMode: 'substring' }).score, 1);
  });

  it('重复实体不重复计分', () => {
    const result = gradeF1Match(['北京', '北京', '上海'], ['北京', '上海']);
    assert.equal(result.score, 1);
    assert.equal(result.reason.truePositiveCount, 2);
    assert.deepEqual(result.reason.predictedEntities, ['北京', '上海']);
  });

  it('中文实体抽取示例得到约 0.57', () => {
    const result = gradeF1Match(
      ['华为', '苹果', '腾讯'],
      ['华为', '阿里巴巴', '腾讯', '字节跳动'],
    );
    close(result.score, 4 / 7);
  });

  it('采用最大一对一匹配而不是可能少算 TP 的贪心匹配', () => {
    const result = gradeF1Match(['ab', 'abc'], ['abc', 'ax'], { matchMode: 'fuzzy', fuzzyThreshold: 1 });
    assert.equal(result.reason.truePositiveCount, 2);
    assert.equal(result.score, 1);
  });

  it('编辑距离按 Unicode code point 计算并校验阈值', () => {
    assert.equal(levenshteinDistance('北京', '北京市'), 1);
    assert.throws(() => gradeF1Match([], [], { fuzzyThreshold: -1 }), RangeError);
  });
});
