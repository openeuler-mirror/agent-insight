import assert from 'node:assert/strict';
import test from 'node:test';
import { extractCoreOutput } from '@/lib/engine/skill-generation/opencode-agent-cli/core-output';

const REPORT = 'A'.repeat(600); // 长分析报告
const NARRATION = '让我先读一下日志文件';
const POINTER = '分析完毕。核心发现已在上面摘要。';

test('多轮：最后一条是空/指针 → 取最长的分析报告（修假 0 的核心）', () => {
  const out = extractCoreOutput([NARRATION, REPORT, '', POINTER]);
  assert.equal(out, REPORT); // 报告被保住，旁白/指针/空被滤掉
});

test('不简单拼接所有：短旁白被滤掉，不污染 judge', () => {
  const out = extractCoreOutput([NARRATION, '现在跑脚本', REPORT, POINTER]);
  assert.ok(!out.includes(NARRATION), '旁白不应进入核心输出');
  assert.ok(out.includes('A'.repeat(600)), '报告应在');
});

test('分多段写报告：带上同等量级（≥50%）的兄弟消息', () => {
  const part1 = 'B'.repeat(500);
  const part2 = 'C'.repeat(400); // ≥ 500*0.5=250 → 保留
  const out = extractCoreOutput([part1, NARRATION, part2, POINTER]);
  assert.ok(out.includes('B'.repeat(500)) && out.includes('C'.repeat(400)), '两段都在');
  assert.ok(!out.includes(NARRATION), '旁白被滤');
  // 时序：part1 在 part2 前
  assert.ok(out.indexOf('B') < out.indexOf('C'));
});

test('单条消息：原样返回', () => {
  assert.equal(extractCoreOutput([REPORT]), REPORT);
});

test('全空 → fallback', () => {
  assert.equal(extractCoreOutput(['', null, undefined], { fallback: 'fb' }), 'fb');
  assert.equal(extractCoreOutput([], { fallback: 'fb' }), 'fb');
});

test('siblingRatio 可调：很短的兄弟不带进来', () => {
  const big = 'X'.repeat(1000);
  const tiny = 'Y'.repeat(100); // < 1000*0.5 → 滤掉
  assert.equal(extractCoreOutput([big, tiny]), big);
});
