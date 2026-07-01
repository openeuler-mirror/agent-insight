import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveOpencodeExecutionFields } from '@/lib/engine/observability/opencode-derived-metrics';
import { extractDebugJobTokenUsage } from '@/lib/skill-analysis/grayscale-utils';

// runGeneralAgent 在 chat() 之后用与落库 Execution.tokens **完全同源**的链路补 token：
//   client.listMessages → normalizeEvaluatorExecutionInteractions → deriveOpencodeExecutionFields
// 这里直接驱动其中的纯函数 deriveOpencodeExecutionFields（token 真值计算本体），输入用
// normalize 产出的 interaction 形状（assistant 消息带 usage，含 cache.{read,write} 与 total）。
const INTERACTIONS = [
  { role: 'user', content: 'analyze the trace', timeInfo: { created: 1000 } },
  {
    role: 'assistant',
    content: 'step 1',
    timeInfo: { created: 1100, completed: 1500 },
    usage: { input: 52000, output: 1200, reasoning: 0, cache: { read: 8000, write: 4000 }, total: 65200 },
  },
  {
    role: 'assistant',
    content: 'step 2',
    timeInfo: { created: 1600, completed: 2000 },
    usage: { input: 61000, output: 900, reasoning: 0, cache: { read: 15000, write: 0 }, total: 76900 },
  },
  {
    role: 'assistant',
    content: 'final report',
    timeInfo: { created: 2100, completed: 2600 },
    usage: { input: 70000, output: 18000, reasoning: 0, cache: { read: 0, write: 0 }, total: 88000 },
  },
];

// 逐条 usage.total 相加（65200 + 76900 + 88000），与 deriveOpencodeExecutionFields 一致。
const EXPECTED_TOTAL = 65200 + 76900 + 88000; // 230100

test('deriveOpencodeExecutionFields sums per-message token usage (Execution.tokens 真值链路)', () => {
  const derived = deriveOpencodeExecutionFields(INTERACTIONS);
  assert.equal(derived.tokens, EXPECTED_TOTAL);
  assert.equal(derived.input_tokens, 183000);
  assert.equal(derived.output_tokens, 20100);
  assert.equal(derived.cache_read_input_tokens, 23000);
  assert.equal(derived.cache_creation_input_tokens, 4000);
  assert.equal(derived.llm_call_count, 3);
});

test('debug job token usage is non-zero after a real run (regression for tokenUsage=0)', () => {
  // 复刻 runner 把 derived 合并进 stats 的形状，再走 route.ts 同一条解析路径。
  const derived = deriveOpencodeExecutionFields(INTERACTIONS);
  const stats = {
    eventCount: 500,
    textDeltaCount: 120,
    toolCallCount: 9,
    subagentCount: 0,
    eventTypeCounter: {},
    totalTokens: derived.tokens,
    tokens: {
      input: derived.input_tokens,
      output: derived.output_tokens,
      reasoning: derived.reasoning_tokens,
      cache: { read: derived.cache_read_input_tokens, write: derived.cache_creation_input_tokens },
    },
  };

  const usage = extractDebugJobTokenUsage(stats);
  assert.equal(usage, EXPECTED_TOTAL);
  // 验收点：量级合理（几万~几十万），不再是修复前那个恒为 0。
  assert.ok(usage > 50_000, `expected a realistic token magnitude, got ${usage}`);
});

test('an empty run (no completion messages) derives 0 tokens and parses to 0 without throwing', () => {
  const derived = deriveOpencodeExecutionFields([]);
  assert.equal(derived.tokens, 0);
  const stats = {
    eventCount: 0,
    textDeltaCount: 0,
    toolCallCount: 0,
    subagentCount: 0,
    eventTypeCounter: {},
    totalTokens: derived.tokens,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  assert.equal(extractDebugJobTokenUsage(stats), 0);
});
