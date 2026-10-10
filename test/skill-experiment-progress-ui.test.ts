import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';

import { SkillExperimentProgress, type SkillExperimentProgressProps } from '@/components/skill-workbench/SkillExperimentProgress';

const finished = { total: 3, succeeded: 3, failed: 0, pending: 0 };
const evaluating = { total: 3, succeeded: 1, failed: 0, pending: 2 };
function render(props: Partial<SkillExperimentProgressProps> = {}) {
  return renderToStaticMarkup(createElement(SkillExperimentProgress, {
    status: 'running', preset: 'use-case', traceSource: 'generate',
    executionProgress: finished, evaluationProgress: evaluating, ...props,
  }));
}
function bars(html: string) {
  return [...html.matchAll(/role="progressbar" aria-label="([^"]+)"[^>]*aria-valuenow="(\d+)"[^>]*aria-valuetext="([^"]+)"/g)]
    .map(([, label, percent, text]) => ({ label, percent: Number(percent), text }));
}

test('执行结束但评测未结束时，两个进度独立显示', () => {
  const html = render();
  assert.match(html, />评测中</);
  assert.deepEqual(bars(html), [
    { label: '用例执行', percent: 100, text: '已结束 3 / 3 项' },
    { label: '结果评测', percent: 33, text: '已结束 1 / 3 项' },
  ]);
  assert.doesNotMatch(html, /第一批|剩余任务|反向用例|冻结实验配置|生成实验结论/);
});

test('触发分析使用触发判定，已有 Trace 不暗示重新执行 Agent', () => {
  assert.deepEqual(bars(render({ preset: 'trigger' })).map((bar) => bar.label), ['用例执行', '触发判定']);
  assert.deepEqual(bars(render({ traceSource: 'existing' })).map((bar) => bar.label), ['Trace 就绪', '结果评测']);
});

test('A/B 执行和评测分别展示两侧的实际进度', () => {
  const html = render({
    preset: 'skill-ab', traceSource: 'existing', versionALabel: 'v1', versionBLabel: 'v2',
    sideProgress: {
      a: { executionProgress: finished, evaluationProgress: finished },
      b: { executionProgress: evaluating, evaluationProgress: { total: 3, succeeded: 0, failed: 0, pending: 3 } },
    },
    executionProgress: { total: 6, succeeded: 4, failed: 0, pending: 2 },
  });
  assert.match(html, />执行中</);
  assert.deepEqual(bars(html), [
    { label: 'A v1 · 用例执行', percent: 100, text: '已结束 3 / 3 项' },
    { label: 'B v2 · 用例执行', percent: 33, text: '已结束 1 / 3 项' },
    { label: 'A v1 · 结果评测', percent: 100, text: '已结束 3 / 3 项' },
    { label: 'B v2 · 结果评测', percent: 0, text: '已结束 0 / 3 项' },
  ]);
});

test('失败和未评测项达到 100% 时明确标为存在失败，不再显示运行中', () => {
  const html = render({
    status: 'failed',
    executionProgress: { total: 3, succeeded: 1, failed: 2, pending: 0 },
    evaluationProgress: { total: 3, succeeded: 0, failed: 1, pending: 0, skipped: 2 },
  });
  assert.deepEqual(bars(html).map((bar) => bar.percent), [100, 100]);
  assert.match(html, /已结束 · 存在失败项/);
  assert.match(html, /2 项执行失败，1 项评测失败，2 项未评测/);
  assert.doesNotMatch(html, /正在|运行中|全部成功/);
});

test('成功、未计分和取消状态有各自的结束提示', () => {
  assert.match(render({ status: 'done', evaluationProgress: finished }), />已完成</);
  const unscored = render({ status: 'done', evaluationProgress: { ...finished, succeeded: 2, unscored: 1 } });
  assert.match(unscored, /已结束 · 存在未计分项/);
  assert.equal(bars(unscored)[1].percent, 100);
  const cancelled = render({ status: 'cancelled' });
  assert.match(cancelled, />已取消</);
  assert.equal(bars(cancelled)[1].percent, 33);
  assert.doesNotMatch(cancelled, /正在/);
});

test('仍有未结束项时不四舍五入到 100%，空数据和未知进度不伪造完成', () => {
  const unfinished = { total: 1000, succeeded: 999, failed: 0, pending: 1 };
  assert.equal(bars(render({ evaluationProgress: unfinished }))[1].percent, 99);
  const empty = { total: 0, succeeded: 0, failed: 0, pending: 0 };
  const html = render({ executionProgress: empty, evaluationProgress: empty });
  assert.deepEqual(bars(html).map((bar) => bar.percent), [0, 0]);
  assert.doesNotMatch(html, /NaN|Infinity/);
  assert.match(render({ executionProgress: null, evaluationProgress: null }), /进度暂不可用/);
});
