import assert from 'node:assert/strict';
import test from 'node:test';

import { sumOpencodeTokenUsages } from '@/lib/engine/observability/opencode-derived-metrics';
import { extractDebugJobTokenUsage } from '@/lib/skill-analysis/grayscale-utils';

// 模拟一次真实多轮 agent run：每轮 LLM 调用是一条独立 assistant message，带 opencode 原生
// info.tokens（{ input, output, reasoning, cache: { read, write } }）。这正是
// opencode-client.chat() 通过 message.updated 累积、收尾 sumOpencodeTokenUsages 合计的输入。
const MESSAGE_TOKENS = [
  { input: 52000, output: 1200, reasoning: 0, cache: { read: 8000, write: 4000 } },
  { input: 61000, output: 900, reasoning: 0, cache: { read: 15000, write: 0 } },
  { input: 70000, output: 18000, reasoning: 0, cache: { read: 0, write: 0 } },
];

// 每条 total = input + output + cacheRead + cacheWrite（reasoning=0），与落库
// Execution.tokens 的 deriveOpencodeExecutionFields 口径一致。
const EXPECTED_TOTAL =
  (52000 + 1200 + 8000 + 4000) + (61000 + 900 + 15000) + (70000 + 18000); // 230100

test('sumOpencodeTokenUsages aggregates per-message opencode token usage (Execution.tokens 口径)', () => {
  const totals = sumOpencodeTokenUsages(MESSAGE_TOKENS);
  assert.equal(totals.total, EXPECTED_TOTAL);
  assert.equal(totals.input, 183000);
  assert.equal(totals.output, 20100);
  assert.equal(totals.cacheRead, 23000);
  assert.equal(totals.cacheWrite, 4000);
});

test('sumOpencodeTokenUsages tolerates empty / degenerate input', () => {
  assert.equal(sumOpencodeTokenUsages([]).total, 0);
  assert.equal(sumOpencodeTokenUsages([null, undefined]).total, 0);
});

test('debug job token usage is non-zero after a real run (regression for tokenUsage=0)', () => {
  // 复刻 opencode-client.chat() 收尾时构造的 stats，再走 route.ts 同一条解析路径。
  const tokenTotals = sumOpencodeTokenUsages(MESSAGE_TOKENS);
  const stats = {
    eventCount: 500,
    textDeltaCount: 120,
    toolCallCount: 9,
    subagentCount: 0,
    eventTypeCounter: {},
    totalTokens: tokenTotals.total,
    tokens: {
      input: tokenTotals.input,
      output: tokenTotals.output,
      reasoning: tokenTotals.reasoning,
      cache: { read: tokenTotals.cacheRead, write: tokenTotals.cacheWrite },
    },
  };

  const usage = extractDebugJobTokenUsage(stats);
  assert.equal(usage, EXPECTED_TOTAL);
  // 验收点：量级合理（几万~几十万），不再是修复前那个恒为 0。
  assert.ok(usage > 50_000, `expected a realistic token magnitude, got ${usage}`);
});

test('an empty run (no token events captured) still parses to 0 without throwing', () => {
  const stats = {
    eventCount: 0,
    textDeltaCount: 0,
    toolCallCount: 0,
    subagentCount: 0,
    eventTypeCounter: {},
    totalTokens: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  assert.equal(extractDebugJobTokenUsage(stats), 0);
});
