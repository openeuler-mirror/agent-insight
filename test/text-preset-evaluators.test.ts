import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isTextPresetId,
  parseEntityList,
  runTextPreset,
  TEXT_PRESET_IDS,
} from '@/lib/engine/experiment/text-preset-evaluators';
import type { FaithfulPresetContext } from '@/lib/engine/experiment/faithful-preset-evaluators';
import { getEvaluatorMeta } from '@/lib/evaluators/registry';
import { presetEvaluators } from '@/lib/evaluators/preset-evaluators';

function context(actualOutput: string, referenceOutput: string | null): FaithfulPresetContext {
  return {
    caseInput: '',
    actualOutput,
    referenceOutput,
    traceSummaryText: null,
    interactions: [],
    taskId: null,
    executionId: null,
  };
}

describe('文本预置评估器接入', () => {
  it('三张 Code 卡均登记为结果评估且依赖参考答案', () => {
    for (const id of TEXT_PRESET_IDS) {
      assert.ok(isTextPresetId(id));
      const card = presetEvaluators.find((candidate) => candidate.id === id);
      assert.ok(card, `${id} 缺少预置卡`);
      assert.equal(card.evaluatorType, 'Code');
      assert.deepEqual(getEvaluatorMeta(card).requires, ['reference']);
      assert.equal(getEvaluatorMeta(card).category, 'res');
    }
    assert.equal(isTextPresetId('preset-result-accuracy'), false);
  });

  it('ROUGE 完全相同文本映射为平台百分制满分', async () => {
    const output = await runTextPreset(
      'preset-text-rouge',
      context('the cat sat on the mat', 'the cat sat on the mat'),
    );
    assert.equal(output.score, 100);
    assert.deepEqual(output.points?.map((point) => point.score), [100, 100, 100]);
  });

  it('精确匹配预置支持参考答案 JSON 多候选', async () => {
    const output = await runTextPreset(
      'preset-text-exact-match',
      context('OK', '["OK", "Okay", "O.K."]'),
    );
    assert.equal(output.score, 100);
    assert.equal(output.verdict, 'pass');
  });

  it('精确匹配预置应用页面可配置的大小写、标点、空白和全半角归一化', async () => {
    const output = await runTextPreset(
      'preset-text-exact-match',
      context('  ＯＫ！  ', '["ok"]'),
      {
        caseSensitive: false,
        punctuationInsensitive: true,
        whitespaceNormalization: true,
        widthNormalization: true,
        multiCandidateScoring: 'any',
      },
    );
    assert.equal(output.score, 100);
    const evidence = output.evidence as { json?: { config?: unknown } } | undefined;
    assert.deepEqual(
      evidence?.json?.config,
      {
        caseSensitive: false,
        punctuationInsensitive: true,
        whitespaceNormalization: true,
        widthNormalization: true,
        multiCandidateScoring: 'any',
      },
    );
  });

  it('实体 F1 接受严格 JSON 字符串数组并展示 TP/FP/FN', async () => {
    const output = await runTextPreset(
      'preset-text-entity-f1',
      context('["北京", "深圳"]', '["北京", "上海", "广州"]'),
    );
    assert.equal(output.score, 40);
    assert.match(output.summary ?? '', /TP=1，FP=1，FN=2/);
    assert.deepEqual(output.points?.map((point) => point.score), [50, 33.3, 40]);
  });

  it('实体 F1 预置支持模糊匹配和子串匹配配置', async () => {
    const fuzzy = await runTextPreset(
      'preset-text-entity-f1',
      context('["Beijng"]', '["Beijing"]'),
      {
        matchMode: 'fuzzy',
        fuzzyThreshold: 1,
        caseSensitive: true,
        widthNormalization: false,
        whitespaceNormalization: false,
      },
    );
    assert.equal(fuzzy.score, 100);

    const substring = await runTextPreset(
      'preset-text-entity-f1',
      context('["北京市"]', '["北京"]'),
      {
        matchMode: 'substring',
        fuzzyThreshold: 1,
        caseSensitive: true,
        widthNormalization: false,
        whitespaceNormalization: false,
      },
    );
    assert.equal(substring.score, 100);
  });

  it('Agent 实体输出格式错误记零分，参考格式错误则不计分', async () => {
    const badActual = await runTextPreset(
      'preset-text-entity-f1',
      context('[北京, 上海]', '["北京", "上海"]'),
    );
    assert.equal(badActual.score, 0);
    assert.equal(badActual.verdict, 'fail');

    const badReference = await runTextPreset(
      'preset-text-entity-f1',
      context('["北京"]', '[北京]'),
    );
    assert.equal(badReference.score, undefined);
    assert.match(badReference.summary ?? '', /参考答案格式无效/);
  });

  it('缺少参考答案时不计分', async () => {
    const output = await runTextPreset('preset-text-rouge', context('answer', null));
    assert.equal(output.score, undefined);
    assert.match(output.summary ?? '', /未标注参考答案/);
  });

  it('实体列表解析拒绝非字符串项', () => {
    assert.deepEqual(parseEntityList('["北京", "上海"]'), ['北京', '上海']);
    assert.throws(() => parseEntityList('["北京", 1]'), /JSON 字符串数组/);
  });
});
