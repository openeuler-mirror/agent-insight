import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { BenchmarkFailureNotice } from '@/components/eval/BenchmarkFailureNotice';
import { benchmarkFailurePresentation } from '@/lib/benchmark/failure-presentation';

const EXPECTED_LABELS = {
  AGENT_TIMEOUT: 'Agent 执行超时',
  MODEL_ERROR: '模型调用失败',
  MODEL_NO_RESPONSE: '模型未响应',
  MODEL_START_TIMEOUT: '等待模型响应超时',
  MODEL_UNAVAILABLE: '模型不可用',
  AGENT_EXIT_NONZERO: 'Agent 异常退出',
  AGENT_NO_OUTPUT: 'Agent 无有效输出',
  TRACE_ID_MISSING: 'Trace 未上报',
};

test('Benchmark Agent failure codes have explicit Chinese labels', () => {
  for (const [code, label] of Object.entries(EXPECTED_LABELS)) {
    const failure = benchmarkFailurePresentation(code, null);
    assert.equal(failure?.code, code);
    assert.equal(failure?.label, label);
    assert.ok(failure?.message);
  }
});

test('Benchmark Agent failure presentation preserves detail and supports legacy messages', () => {
  assert.deepEqual(benchmarkFailurePresentation('AGENT_TIMEOUT', '执行超过 600 秒'), {
    code: 'AGENT_TIMEOUT',
    label: 'Agent 执行超时',
    message: '执行超过 600 秒',
  });
  assert.equal(
    benchmarkFailurePresentation(null, 'runner failed: MODEL_UNAVAILABLE')?.label,
    '模型不可用',
  );
  assert.equal(benchmarkFailurePresentation('SOMETHING_ELSE', '原始错误')?.label, 'Agent 执行失败');
  assert.equal(benchmarkFailurePresentation(null, null), null);
});

test('Benchmark failure notice renders the label, code and detail', () => {
  const detail = renderToStaticMarkup(createElement(BenchmarkFailureNotice, {
    code: 'AGENT_NO_OUTPUT',
    message: 'model.patch 为空',
  }));
  assert.match(detail, /role="alert"/);
  assert.match(detail, /Agent 无有效输出/);
  assert.match(detail, /AGENT_NO_OUTPUT/);
  assert.match(detail, /model\.patch 为空/);

  const compact = renderToStaticMarkup(createElement(BenchmarkFailureNotice, {
    code: 'MODEL_UNAVAILABLE',
    compact: true,
  }));
  assert.match(compact, /模型不可用/);
  assert.match(compact, /MODEL_UNAVAILABLE/);
});
