// 结果预置评估器：分发 id→metric、evidence→points 映射（注入 fake，不真调 LLM）。
import path from 'node:path';
process.env.DATABASE_URL = `file:${path.resolve(__dirname, '../data/witty_insight.db')}`;
import assert from 'node:assert/strict';
import test from 'node:test';
import { isResultPresetId, RESULT_PRESET_IDS } from '@/lib/engine/experiment/result-preset-evaluators';
import { getEvaluatorMeta } from '@/lib/evaluators/registry';
import { presetEvaluators } from '@/lib/evaluators/preset-evaluators';

test('四个结果预置卡已登记，category=res，仅准确性依赖参考数据', () => {
  for (const id of RESULT_PRESET_IDS) {
    assert.ok(isResultPresetId(id));
    const card = presetEvaluators.find((c) => c.id === id);
    assert.ok(card, `${id} 缺卡片`);
    const meta = getEvaluatorMeta(card!);
    assert.equal(meta.category, 'res');
    if (id === 'preset-result-accuracy') assert.deepEqual(meta.requires, ['reference']);
    else assert.deepEqual(meta.requires, []);
  }
  assert.equal(isResultPresetId('preset-agent-task-completion'), false);
});
