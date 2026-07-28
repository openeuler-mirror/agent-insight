/**
 * 灰度 A/B 评估器选择的回归测试。
 *
 * 锁死的故障：用户在灰度页勾了结果类预置评估器（下拉框由 presetEvaluators 派生，全都列得出来），
 * 后端曾按 2 个 legacy id 的白名单把它们**静默滤空** → backing 实验建成 0 个评估器 →
 * 评测 0 行 → run.status='fail'、output='评测失败'，UI 上没有任何原因。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { presetEvaluators } from '../src/lib/evaluators/preset-evaluators';
import {
  abEvaluatorName,
  forLegacyRowProjection,
  normalizeAbEvaluators,
  TASK_COMPLETION_EVALUATOR_ID,
  TRACE_EVALUATOR_ID,
} from '../src/lib/grayscale/ab-evaluator-selection';

test('非 legacy 的预置评估器不会被静默丢弃（本次修复的故障）', () => {
  const picked = ['preset-result-accuracy', 'preset-result-faithfulness'];
  assert.deepEqual(normalizeAbEvaluators(picked), picked);
});

test('灰度页能列出的每一张预置卡，都能原样通过归一化', () => {
  // 下拉框来源：grayscale/page.tsx 的 presetEvaluators.filter(status === 'ready')
  const selectable = presetEvaluators.filter(c => c.status === 'ready').map(c => c.id);
  assert.ok(selectable.length > 0, '预置卡里应至少有一张 ready');
  assert.deepEqual(
    normalizeAbEvaluators(selectable),
    selectable,
    '灰度页选得出来的评估器，后端必须照单全收——否则就是"选得上、跑不了、无提示"',
  );
});

test('老别名归一 + 去重 + 去空白', () => {
  assert.deepEqual(
    normalizeAbEvaluators(['trace-quality-evaluator', '  preset-result-answer  ', '', TRACE_EVALUATOR_ID]),
    [TRACE_EVALUATOR_ID, 'preset-result-answer'],
  );
});

test('列表为空时退到 fallback；fallback 也空则返回空数组（由调用方早退报错）', () => {
  assert.deepEqual(normalizeAbEvaluators([], TASK_COMPLETION_EVALUATOR_ID), [TASK_COMPLETION_EVALUATOR_ID]);
  assert.deepEqual(normalizeAbEvaluators([], 'trace-quality-evaluator'), [TRACE_EVALUATOR_ID]);
  assert.deepEqual(normalizeAbEvaluators([], ''), []);
  assert.deepEqual(normalizeAbEvaluators(null), []);
});

test('legacy 行投影仍只认那两个——这张表只有两列可读，别的评估器塞进去会被错读成轨迹分', () => {
  assert.deepEqual(
    forLegacyRowProjection([TRACE_EVALUATOR_ID, 'preset-result-accuracy', TASK_COMPLETION_EVALUATOR_ID]),
    [TRACE_EVALUATOR_ID, TASK_COMPLETION_EVALUATOR_ID],
  );
});

test('展示名从注册表派生，新增预置自动跟上；未知 id 回退成 id 本身', () => {
  for (const card of presetEvaluators) {
    assert.equal(abEvaluatorName(card.id), card.name, `${card.id} 的展示名应取自注册表`);
  }
  assert.equal(abEvaluatorName('custom-1234'), 'custom-1234');
});
