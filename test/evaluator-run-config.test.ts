import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_ENTITY_F1_RUN_CONFIG,
  DEFAULT_EXACT_MATCH_RUN_CONFIG,
  ENTITY_F1_EVALUATOR_ID,
  EXACT_MATCH_EVALUATOR_ID,
  normalizeEvaluatorRunConfigs,
  parseStoredEvaluatorRunConfigs,
  serializeEvaluatorRunConfigs,
  summarizeEvaluatorRunConfig,
} from '@/lib/evaluators/evaluator-run-config';

describe('评估器运行配置契约', () => {
  it('为已选中的可配置评估器填充严格默认值', () => {
    assert.deepEqual(
      normalizeEvaluatorRunConfigs({}, [EXACT_MATCH_EVALUATOR_ID, ENTITY_F1_EVALUATOR_ID]),
      {
        [EXACT_MATCH_EVALUATOR_ID]: DEFAULT_EXACT_MATCH_RUN_CONFIG,
        [ENTITY_F1_EVALUATOR_ID]: DEFAULT_ENTITY_F1_RUN_CONFIG,
      },
    );
  });

  it('部分配置补齐默认值并完成版本化存储往返', () => {
    const stored = serializeEvaluatorRunConfigs({
      [EXACT_MATCH_EVALUATOR_ID]: {
        caseSensitive: false,
        punctuationInsensitive: true,
      },
      [ENTITY_F1_EVALUATOR_ID]: {
        matchMode: 'fuzzy',
        fuzzyThreshold: 2,
      },
    }, [EXACT_MATCH_EVALUATOR_ID, ENTITY_F1_EVALUATOR_ID]);
    const parsed = parseStoredEvaluatorRunConfigs(
      stored,
      [EXACT_MATCH_EVALUATOR_ID, ENTITY_F1_EVALUATOR_ID],
    );
    assert.equal(parsed[EXACT_MATCH_EVALUATOR_ID]?.caseSensitive, false);
    assert.equal(parsed[EXACT_MATCH_EVALUATOR_ID]?.punctuationInsensitive, true);
    assert.equal(parsed[EXACT_MATCH_EVALUATOR_ID]?.multiCandidateScoring, 'any');
    assert.equal(parsed[ENTITY_F1_EVALUATOR_ID]?.matchMode, 'fuzzy');
    assert.equal(parsed[ENTITY_F1_EVALUATOR_ID]?.fuzzyThreshold, 2);
    assert.equal(parsed[ENTITY_F1_EVALUATOR_ID]?.caseSensitive, true);
    assert.equal(JSON.parse(stored).schemaVersion, 1);
  });

  it('数据库旧默认值空对象继续解释为严格默认配置', () => {
    const parsed = parseStoredEvaluatorRunConfigs('{}', [EXACT_MATCH_EVALUATOR_ID]);
    assert.deepEqual(parsed[EXACT_MATCH_EVALUATOR_ID], DEFAULT_EXACT_MATCH_RUN_CONFIG);
  });

  it('拒绝未知字段、未选择的配置和越界模糊阈值', () => {
    assert.throws(
      () => normalizeEvaluatorRunConfigs({
        [EXACT_MATCH_EVALUATOR_ID]: { unsupported: true },
      }, [EXACT_MATCH_EVALUATOR_ID]),
      /不支持的配置字段/,
    );
    assert.throws(
      () => normalizeEvaluatorRunConfigs({
        [EXACT_MATCH_EVALUATOR_ID]: {},
      }, [ENTITY_F1_EVALUATOR_ID]),
      /未选择评估器/,
    );
    assert.throws(
      () => normalizeEvaluatorRunConfigs({
        [ENTITY_F1_EVALUATOR_ID]: { matchMode: 'fuzzy', fuzzyThreshold: 101 },
      }, [ENTITY_F1_EVALUATOR_ID]),
      /0 到 100/,
    );
  });

  it('生成可供页面详情展示的配置摘要', () => {
    assert.equal(
      summarizeEvaluatorRunConfig(EXACT_MATCH_EVALUATOR_ID, {
        ...DEFAULT_EXACT_MATCH_RUN_CONFIG,
        caseSensitive: false,
        punctuationInsensitive: true,
      }),
      '忽略大小写、忽略标点 · 候选任一命中',
    );
    assert.equal(
      summarizeEvaluatorRunConfig(ENTITY_F1_EVALUATOR_ID, {
        ...DEFAULT_ENTITY_F1_RUN_CONFIG,
        matchMode: 'fuzzy',
        fuzzyThreshold: 2,
      }),
      '模糊匹配（距离≤2）',
    );
  });
});
