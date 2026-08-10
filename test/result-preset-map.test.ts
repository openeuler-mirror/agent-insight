// 结果预置评估器：分发 id→metric、evidence→points 映射（注入 fake，不真调 LLM）。
import path from 'node:path';
import fs from 'node:fs';
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

test('trace 接入不触发结果评测，结果类预置评估器仍使用独立核心', () => {
  const ingestFiles = [
    'src/app/api/ingest/upload/route.ts',
    'src/app/api/ingest/proxy/[taskId]/end/route.ts',
    'src/lib/ingest/otel-consumer/consumer.ts',
  ];
  for (const file of ingestFiles) {
    const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(source, /scheduleResultEvaluation|result-quality-evaluator/, `${file} 不应触发结果评测`);
  }

  const presetSource = fs.readFileSync(
    path.resolve(__dirname, '../src/lib/engine/experiment/result-preset-evaluators.ts'),
    'utf8',
  );
  assert.match(presetSource, /result-metric-evaluator/);
  assert.doesNotMatch(presetSource, /result-quality-evaluator/);
});
