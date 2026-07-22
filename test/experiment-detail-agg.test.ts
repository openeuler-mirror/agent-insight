// 实验详情聚合口径（detail-agg.ts 纯函数）：
// 有分/无分混合（failed/pending 不入均分）、类目归组、全失败 case、N/M 标注口径。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  caseScore,
  categorySummary,
  evaluatorBreakdown,
  groupByCategory,
  overallAverage,
  scoredRows,
  type CategoryOf,
  type ResultRowLike,
} from '@/lib/engine/experiment/detail-agg';

const CAT: Record<string, 'res' | 'traj'> = {
  'ev-res-a': 'res',
  'ev-res-b': 'res',
  'ev-traj-a': 'traj',
};
const categoryOf: CategoryOf = (id) => CAT[id] ?? 'res';

function row(partial: Partial<ResultRowLike> & { evaluatorId: string }): ResultRowLike {
  return { caseId: 'case-1', status: 'done', score: null, ...partial };
}

test('scoredRows / overallAverage：仅 done 且有分入均分', () => {
  const rows: ResultRowLike[] = [
    row({ evaluatorId: 'ev-res-a', score: 90 }),
    row({ evaluatorId: 'ev-res-b', score: 70 }),
    row({ evaluatorId: 'ev-traj-a', status: 'failed', score: null }),   // 失败无分
    row({ evaluatorId: 'ev-traj-a', status: 'pending', score: null }),  // 待执行
    row({ evaluatorId: 'ev-res-a', status: 'done', score: null }),      // done 但评估器未产分
    row({ evaluatorId: 'ev-res-b', status: 'failed', score: 55 }),      // 防御：失败行即便带分也不计
  ];
  assert.equal(scoredRows(rows).length, 2);
  assert.equal(overallAverage(rows), 80);
  // 全无分 → null（不是 0）
  assert.equal(overallAverage([row({ evaluatorId: 'ev-res-a', status: 'failed' })]), null);
  assert.equal(overallAverage([]), null);
});

test('evaluatorBreakdown：按评估器归组，N/M 与失败数正确，保持出现顺序', () => {
  const rows: ResultRowLike[] = [
    row({ caseId: 'c1', evaluatorId: 'ev-res-a', score: 80 }),
    row({ caseId: 'c2', evaluatorId: 'ev-res-a', score: 90 }),
    row({ caseId: 'c3', evaluatorId: 'ev-res-a', status: 'failed' }),
    row({ caseId: 'c1', evaluatorId: 'ev-traj-a', score: 61 }),
    row({ caseId: 'c2', evaluatorId: 'ev-traj-a', status: 'pending' }),
  ];
  const bd = evaluatorBreakdown(rows);
  assert.deepEqual(bd.map((b) => b.evaluatorId), ['ev-res-a', 'ev-traj-a']);
  const [a, t] = bd;
  assert.equal(a.avg, 85);
  assert.equal(a.scored, 2);
  assert.equal(a.total, 3);
  assert.equal(a.failed, 1);
  assert.equal(t.avg, 61);
  assert.equal(t.scored, 1);
  assert.equal(t.total, 2);
  assert.equal(t.failed, 0);
});

test('caseScore：综合/结果/轨迹按类目分别均分，均分保留 1 位小数', () => {
  const rows: ResultRowLike[] = [
    row({ evaluatorId: 'ev-res-a', score: 90 }),
    row({ evaluatorId: 'ev-res-b', score: 71 }),
    row({ evaluatorId: 'ev-traj-a', score: 60 }),
  ];
  const s = caseScore(rows, categoryOf);
  assert.equal(s.overall, 73.7); // (90+71+60)/3 = 73.666… → 73.7
  assert.equal(s.res, 80.5);
  assert.equal(s.traj, 60);
  assert.equal(s.failed, 0);
});

test('caseScore：某类目无分 → 该项 null；全失败 case → 全 null + failed 计数', () => {
  const mixed = caseScore([
    row({ evaluatorId: 'ev-res-a', score: 88 }),
    row({ evaluatorId: 'ev-traj-a', status: 'failed' }),
  ], categoryOf);
  assert.equal(mixed.overall, 88);
  assert.equal(mixed.res, 88);
  assert.equal(mixed.traj, null);
  assert.equal(mixed.failed, 1);

  const allFailed = caseScore([
    row({ evaluatorId: 'ev-res-a', status: 'failed' }),
    row({ evaluatorId: 'ev-traj-a', status: 'failed' }),
  ], categoryOf);
  assert.deepEqual(allFailed, { overall: null, res: null, traj: null, failed: 2 });
});

test('groupByCategory：按类目归组；未知评估器回退 res', () => {
  const rows: ResultRowLike[] = [
    row({ evaluatorId: 'ev-res-a', score: 90 }),
    row({ evaluatorId: 'ev-traj-a', score: 70 }),
    row({ evaluatorId: 'ev-unknown', score: 50 }), // 注册表找不到 → res
  ];
  const g = groupByCategory(rows, categoryOf);
  assert.deepEqual(g.res.map((r) => r.evaluatorId), ['ev-res-a', 'ev-unknown']);
  assert.deepEqual(g.traj.map((r) => r.evaluatorId), ['ev-traj-a']);
});

test('categorySummary：N=有分行 / M=类目结果行总数；空类目与全失败', () => {
  const s = categorySummary([
    row({ evaluatorId: 'ev-res-a', score: 96 }),
    row({ evaluatorId: 'ev-res-b', score: 100 }),
    row({ evaluatorId: 'ev-res-b', status: 'failed' }),
  ]);
  assert.equal(s.avg, 98);
  assert.equal(s.scored, 2);
  assert.equal(s.total, 3);

  assert.deepEqual(categorySummary([]), { avg: null, scored: 0, total: 0 });
  assert.deepEqual(
    categorySummary([row({ evaluatorId: 'ev-res-a', status: 'failed' })]),
    { avg: null, scored: 0, total: 1 },
  );
});
