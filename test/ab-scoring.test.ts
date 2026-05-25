import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateAbScoring } from '@/lib/skill-analysis/ab-scoring';

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

test('calculateAbScoring returns no total score when no paired samples are complete', () => {
  const result = calculateAbScoring({}, { repeatRounds: 1 });

  assert.equal(result.canScore, false);
  assert.equal(result.totalScore, null);
  assert.equal(result.decision, 'insufficient');
  assert.equal(result.sampleSize, 0);
  assert.equal(result.capability.deltaPp, null);
});

test('calculateAbScoring outputs a total score with a single completed pair', () => {
  const result = calculateAbScoring({
    c1: { a: { runs: [run(80, 100)] }, b: { runs: [run(90, 110)] } },
  }, { repeatRounds: 1 });

  assert.equal(result.canScore, true);
  assert.equal(result.sampleSize, 1);
  assert.equal(typeof result.totalScore, 'number');
  assert.notEqual(result.decision, 'insufficient');
});

test('calculateAbScoring maps capability, cost, stability and final score', () => {
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
  assert.equal(result.capability.deltaPp, 15);
  assert.equal(result.cost.deltaTokenPct, 35);
  assert.equal(result.stability.invokeRate, 100);
  assert.equal(result.stability.variance, 0);
  assert.equal(result.capability.score, 85);
  assert.equal(result.cost.score, 72.5);
  assert.equal(result.stability.score, 100);
  assert.equal(result.totalScore, 86);
  assert.equal(result.decision, 'monitor-release');
});

test('calculateAbScoring applies cost hard gate only when capability lift is insufficient', () => {
  const states = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [
    `c${index}`,
    {
      a: { runs: [run(index < 3 ? 80 : 40, 100, false)] },
      b: { runs: [run(index < 3 ? 90 : 40, 250, true)] },
    },
  ]));

  const result = calculateAbScoring(states, { repeatRounds: 1 });

  assert.equal(result.capability.deltaPp, 0);
  assert.equal(result.cost.deltaTokenPct, 150);
  assert.equal(result.decision, 'reject');
  assert.equal(result.rejectCategory, 'cost');
  assert.equal(result.totalScore, 30);
});

test('calculateAbScoring marks variance unavailable with a single repeat', () => {
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
