/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { BenchmarkFailureNotice } from '@/components/eval/BenchmarkFailureNotice';
import { benchmarkFailurePresentation } from '@/lib/benchmark/failure-presentation';

const EXPECTED_LABELS = {
  ENOSPC: '执行端存储空间不足',
  EDQUOT: '执行端存储配额不足',
  EVENT_MONITOR_UNAVAILABLE: '失败监测通道未就绪',
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

test('legacy execution storage failures are reclassified for display without losing their original code', () => {
  const message = 'pi-agent 会话报告模型错误: Pi model: ENOSPC: no space left on device, write';
  for (const originalCode of ['MODEL_ERROR', 'WORKSPACE_PREPARE_FAILED', 'AGENT_EXIT_NONZERO', 'EXECUTION_FAILED']) {
    assert.deepEqual(benchmarkFailurePresentation(originalCode, message), {
      code: 'ENOSPC', originalCode, label: '执行端存储空间不足', message,
    });
  }
  assert.equal(benchmarkFailurePresentation(null, 'git checkout failed: No space left on device')?.code, 'ENOSPC');
  assert.equal(benchmarkFailurePresentation('MODEL_ERROR', 'EDQUOT: disk quota exceeded')?.code, 'EDQUOT');
  for (const code of ['AGENT_TIMEOUT', 'SWE_HARNESS_FAILED', 'MODEL_UNAVAILABLE']) {
    assert.equal(benchmarkFailurePresentation(code, 'a previous attempt reported ENOSPC')?.code, code);
  }
  const rendered = renderToStaticMarkup(createElement(BenchmarkFailureNotice, { code: 'MODEL_ERROR', message }));
  assert.match(rendered, /执行端存储空间不足/);
  assert.match(rendered, /ENOSPC（原始码：MODEL_ERROR）/);
  assert.match(rendered, /Pi model: ENOSPC/);
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
