import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateAbScoring } from '@/lib/skill-analysis/ab-scoring';

// v2.1 算法（详见 docs/skill-ab-scoring.md）的回归测试。
// 每个 test 名标注算法对应小节,便于阅读时跳转公式。

function run(score: number, tokenUsage: number, skillTriggered = true) {
  return {
    status: score >= 60 ? 'pass' : 'fail',
    score,
    tokenUsage,
    timeCost: '10s',
    toolCallCount: 3,
    skillTriggered,
  };
}

test('§6.2 关卡 1: 没有完成配对时返回 insufficient', () => {
  const result = calculateAbScoring({}, { repeatRounds: 1 });

  assert.equal(result.canScore, false);
  assert.equal(result.totalScore, null);
  assert.equal(result.decision, 'insufficient');
  assert.equal(result.sampleSize, 0);
  assert.equal(result.capability.deltaScore, null);
});

test('§3 §4 §5: 单对样本依然出综合分（minSampleSize=1 兜底）', () => {
  // A: score=80, tokens=100; B: score=90, tokens=110, triggered=true
  // Δscore = 10 → capability = 50+10×2.5 = 75
  // Δtoken = 10% → baseCost = 100-10/20×20 = 90; cap≥75 → +15 → clamp 100
  // invokeRate=100%, R=1 → variance=0 兜底 → stability = 100
  // min(75,100,100) = 75 → 全好 → direct-release
  const result = calculateAbScoring({
    c1: { a: { runs: [run(80, 100, false)] }, b: { runs: [run(90, 110, true)] } },
  }, { repeatRounds: 1 });

  assert.equal(result.canScore, true);
  assert.equal(result.sampleSize, 1);
  assert.equal(result.capability.deltaScore, 10);
  assert.equal(result.capability.score, 75);
  assert.equal(result.cost.score, 100);
  assert.equal(result.cost.baseCost, 90);
  assert.equal(result.stability.score, 100);
  assert.equal(result.totalScore, 75);
  assert.equal(result.decision, 'direct-release');
  assert.equal(result.policyVersion, 'agent-skill-scoring-v2.1');
});

test('§3.1 §4.1 §5.1: 20 case × 3 轮的综合算例', () => {
  // 14/20 case 在 A 侧高分(80/82/84), 6/20 低分(40/42/44)
  // 17/20 case 在 B 侧高分(90/91/92), 3/20 低分(40/41/42)
  // avgEvalA = (14×246+6×126)/60 = 70
  // avgEvalB = (17×273+3×123)/60 = 83.5
  // Δscore = 13.5 → capability = 50+13.5×2.5 = 83.75
  // Δtoken = 35% → baseCost = 80-(35-20)/80×40 = 72.5; cap≥75 → +15 → 87.5
  // 每 case 内 B pass 序列方差=0 → stability = 100% × 1 = 100
  // total = min(83.75, 87.5, 100) = 84
  const states = Object.fromEntries(Array.from({ length: 20 }, (_, index) => {
    const aPass = index < 14;
    const bPass = index < 17;
    return [`c${index}`, {
      a: { runs: [run(aPass ? 80 : 40, 100, false), run(aPass ? 82 : 42, 100, false), run(aPass ? 84 : 44, 100, false)] },
      b: { runs: [run(bPass ? 90 : 40, 135, true), run(bPass ? 91 : 41, 135, true), run(bPass ? 92 : 42, 135, true)] },
    }];
  }));

  const result = calculateAbScoring(states, { repeatRounds: 3 });

  assert.equal(result.sampleSize, 20);
  // 主指标（v2.1 口径）
  assert.equal(result.capability.avgEvalScoreA, 70);
  assert.equal(result.capability.avgEvalScoreB, 83.5);
  assert.equal(result.capability.deltaScore, 13.5);
  assert.equal(result.capability.score, 83.8);   // round(83.75, 1)
  // 辅助通过率（v1.1 兼容指标）
  assert.equal(result.capability.passRateA, 70);
  assert.equal(result.capability.passRateB, 85);
  assert.equal(result.capability.deltaPp, 15);
  // 成本（含能力耦合）
  assert.equal(result.cost.deltaTokenPct, 35);
  assert.equal(result.cost.baseCost, 72.5);
  assert.equal(result.cost.score, 87.5);
  // 稳定性
  assert.equal(result.stability.invokeRate, 100);
  assert.equal(result.stability.variance, 0);
  assert.equal(result.stability.score, 100);
  // 综合 + 决策
  assert.equal(result.totalScore, 84);
  assert.equal(result.decision, 'direct-release');
});

test('§4.1 §6.2: 能力提升不足 + Token +150% → 成本打回', () => {
  // 3/5 case 高分(80→90), 2/5 低分(40→40), tokens 100→250 (Δ=150%)
  // avgEvalA = 64, avgEvalB = 70 → Δscore=6 → capability = 65
  // Δtoken=150% → baseCost = 40-(150-100)/100×40 = 20; cap 在 [50,75) → 不耦合 → 20
  // cost < 40 → rejectCategory='cost', total = min(65, 20, 100) = 20
  const states = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [
    `c${index}`,
    {
      a: { runs: [run(index < 3 ? 80 : 40, 100, false)] },
      b: { runs: [run(index < 3 ? 90 : 40, 250, true)] },
    },
  ]));

  const result = calculateAbScoring(states, { repeatRounds: 1 });

  assert.equal(result.capability.deltaScore, 6);
  assert.equal(result.capability.score, 65);
  assert.equal(result.cost.deltaTokenPct, 150);
  assert.equal(result.cost.score, 20);
  assert.equal(result.decision, 'reject');
  assert.equal(result.rejectCategory, 'cost');
  assert.equal(result.totalScore, 20);
});

test('§5.4: 单轮重复时方差不可计算, 按 variance=0 处理, stability 仅由 invokeRate 决定', () => {
  // 4/5 case B 侧 pass, invokeRate=100%, 每 case 仅 1 轮 → variance=null
  // varianceComputable=false, 但稳定性分仍按 coeff=1 计算 = invokeScore = 100
  const states = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [
    `c${index}`,
    {
      a: { runs: [run(index < 3 ? 80 : 40, 100, false)] },
      b: { runs: [run(index < 4 ? 90 : 40, 100, true)] },
    },
  ]));

  const result = calculateAbScoring(states, { repeatRounds: 1 });

  assert.equal(result.stability.variance, null);
  assert.equal(result.stability.varianceComputable, false);
  assert.equal(result.stability.score, result.stability.invokeScore);
});

test('§4.1: 能力差时成本被扣 20 分，触发拒绝', () => {
  // 1/3 case 高分; B 评测分整体偏低 → capability < 50
  // Δtoken=50% → baseCost = 80 - (50-20)/80×40 = 65; cap<50 → -20 → 45
  // 但 capability < 50 → 命中 capability reject gate
  const states = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [
    `c${index}`,
    {
      a: { runs: [run(70, 100, false)] },
      b: { runs: [run(index === 0 ? 90 : 30, 150, true)] },
    },
  ]));

  const result = calculateAbScoring(states, { repeatRounds: 1 });

  // 命中能力拒绝（capability 列在最前,优先打回）
  assert.equal(result.decision, 'reject');
  assert.equal(result.rejectCategory, 'capability');
  // 即便如此 cost.baseCost / cost.score 仍按公式输出, 便于下钻
  assert.equal(result.cost.deltaTokenPct, 50);
  assert.equal(result.cost.baseCost, 65);
  // cap < 50 → -20 耦合
  assert.equal(result.cost.score, 45);
});

test('§3.2 数据质量护栏: A/B 评测均分都极低 → data-quality', () => {
  const states = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [
    `c${index}`,
    {
      a: { runs: [run(2, 100, false)] },
      b: { runs: [run(3, 100, true)] },
    },
  ]));

  const result = calculateAbScoring(states, { repeatRounds: 1 });

  assert.equal(result.capability.verdict, 'data-quality');
  assert.ok(result.capability.dataQualityIssue);
});

test('每个维度都返回 breakdown.steps，方便 UI 下钻展示', () => {
  const result = calculateAbScoring({
    c1: { a: { runs: [run(60, 100, false)] }, b: { runs: [run(80, 120, true)] } },
  }, { repeatRounds: 1 });

  assert.ok(result.capability.breakdown.steps.length >= 3);
  assert.ok(result.cost.breakdown.steps.length >= 3);
  assert.ok(result.stability.breakdown.steps.length >= 3);
  assert.match(result.capability.breakdown.reference, /ab-scoring/);
  assert.ok(result.totalScoreBreakdown.steps.length >= 3);
});
