import assert from 'node:assert/strict';
import test from 'node:test';
import { buildComparisonCaseRows } from '@/lib/evaluation-harness/case-comparison-view';

const groups = [{ key: 'A', evaluatorIds: ['judge-a'] }, { key: 'B', evaluatorIds: ['judge-b'] }];
const row = (id: string, groupKey: string | null, comparisonKey: string) => ({ id, groupKey, comparisonKey, comparisonStatus: groupKey ? 'matched' : 'shared' });
const result = (caseId: string, evaluatorId: string, score: number | null, status = 'done') => ({ caseId, evaluatorId, score, status });

test('同一 Case 的 A/B 执行并排，只有单侧的 Case 仍保留', () => {
  const rows = buildComparisonCaseRows([row('a', 'A', 'one'), row('only-b', 'B', 'two'), row('b', 'B', 'one')], [result('a', 'judge-a', 0), result('b', 'judge-b', 100)], groups, () => 'res');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].a?.id, 'a');
  assert.equal(rows[0].b?.id, 'b');
  assert.equal(rows[0].a?.scores.overall, 0);
  assert.equal(rows[0].b?.scores.overall, 100);
  assert.equal(rows[1].a, undefined);
  assert.equal(rows[1].b?.id, 'only-b');
});

test('评估器对比共用 Trace，但各列只计算本组评估器并保留人工分', () => {
  const rows = buildComparisonCaseRows([row('shared', null, 'shared')], [
    { ...result('shared', 'judge-a', 10), humanScore: 70 },
    result('shared', 'judge-b', 90),
  ], groups, () => 'res');
  assert.equal(rows[0].a?.id, rows[0].b?.id);
  assert.equal(rows[0].a?.scores.overall, 70);
  assert.equal(rows[0].a?.scores.adjusted, 1);
  assert.equal(rows[0].b?.scores.overall, 90);
});

test('未出分不显示为零，也不借用另一组的评分', () => {
  const rows = buildComparisonCaseRows([row('shared', null, 'shared')], [result('shared', 'judge-a', 80), result('shared', 'judge-b', null, 'failed')], groups, () => 'traj');
  assert.equal(rows[0].a?.scores.overall, 80);
  assert.equal(rows[0].b?.scores.overall, null);
  assert.equal(rows[0].b?.scores.failed, 1);
});

test('历史分组丢失的记录不伪装为两组共用', () => {
  const rows = buildComparisonCaseRows([{ ...row('unknown', null, 'unknown'), comparisonStatus: 'unmatched' }], [result('unknown', 'judge-a', 80)], groups, () => 'res');
  assert.equal(rows[0].a, undefined);
  assert.equal(rows[0].b, undefined);
  assert.equal(rows[0].unassigned?.id, 'unknown');
});
