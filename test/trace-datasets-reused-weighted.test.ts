import test from 'node:test';
import assert from 'node:assert/strict';
import { hash, lexicalFeatures, signature, POLICY, type Candidate } from '../src/lib/trace-datasets/sampling';
import { blockSample } from '../src/lib/trace-datasets/sampling/budgeted-block';
import { indexedSample } from '../src/lib/trace-datasets/sampling/budgeted-indexed';
import { agreementFeaturesSteps } from '../src/lib/trace-datasets/sampling/answer-consensus';
import { recallFeaturesSteps } from '../src/lib/trace-datasets/sampling/answer-recall';
import { sharedAnswerFeaturesSteps } from '../src/lib/trace-datasets/sampling/answer-shared';
import { tabuSample } from '../src/lib/trace-datasets/sampling/budgeted-tabu';
import { reusedSample, reusedSampleSteps } from '../src/lib/trace-datasets/sampling/budgeted-reused';
import { weightedFeaturesSteps, weightedSample } from '../src/lib/trace-datasets/sampling/answer-weighted';

function drain<T>(steps: Generator<void, T>): T { let n = steps.next(); while (!n.done) n = steps.next(); return n.value; }
function fixture() {
  const answers = new Map<string, string>(), rows: Candidate[] = [];
  for (let i = 0; i < 35; i++) {
    const input = `question ${i} ` + Array.from({ length: 8 + i * 5 }, (_, j) => `term${(i * 7 + j) % 160}`).join(' ');
    for (let v = 0; v < 1 + i % 3; v++) {
      const answer = v ? `answer ${i} useful detail explanation ${v}` : `answer ${i}`;
      const key = hash([input, answer]); answers.set(key, answer);
      rows.push({ key, inputKey: hash([input]), lexical: lexicalFeatures(input), signature: signature(input), task: ['coding', 'writing', 'unknown'][i % 3], paths: [{ key: `${key}:a`, cells: [`tool:${i % 4}`], knownDimensions: 1 }, { key: `${key}:b`, cells: ['common'], knownDimensions: 1 }] });
    }
  }
  return { rows, answers };
}

test('shared answer features exactly preserve Jaccard and F2 across duplicates, singleton and support caps', () => {
  const { rows, answers } = fixture();
  for (let i = 0; i < 40; i++) { const row = { ...rows[0], key: `extra:${i}` }; rows.push(row); answers.set(row.key, i === 1 ? answers.get(rows[0].key)! : `overlapping ${i} common detail`); }
  const combined = drain(sharedAnswerFeaturesSteps(rows, answers));
  assert.deepEqual(combined.agreement, drain(agreementFeaturesSteps(rows, answers)));
  assert.deepEqual(combined.recall, drain(recallFeaturesSteps(rows, answers)));
  assert.throws(() => drain(sharedAnswerFeaturesSteps(rows, new Map())), /SOURCE_CORRUPT/);
});

test('bulk reconstructed states preserve full core selections and diagnostics at multiple budgets and counts', () => {
  const { rows } = fixture();
  for (const k of [1, 12, 40, 500]) for (const budgetRatio of [1, 1.1, 1.2]) {
    const old = blockSample(rows, k, undefined, { budgetRatio }), next = indexedSample(rows, k, undefined, { budgetRatio });
    assert.deepEqual({ ...next, optimization: { ...next.optimization, requestedPolicy: old.optimization.requestedPolicy, effectivePolicy: old.optimization.effectivePolicy } }, old);
  }
});

test('reused pipeline preserves the entire v6.10 result, ordering, paths and default', () => {
  const { rows, answers } = fixture();
  for (const k of [1, 12, 40, 500]) {
    const old = tabuSample(rows, answers, k), next = reusedSample(rows, answers, k);
    assert.deepEqual({ ...next, optimization: { ...next.optimization, requestedPolicy: old.optimization.requestedPolicy, effectivePolicy: old.optimization.effectivePolicy } }, old);
    assert.deepEqual(reusedSample([...rows].reverse(), answers, k), next);
  }
  const snapshot = structuredClone(rows), steps = reusedSampleSteps(rows, answers, 12);
  assert.equal(steps.next().done, false); steps.return(undefined as never);
  assert.deepEqual(rows, snapshot); assert.equal(POLICY.version, 'trace-coverage-v4');
});

test('weighted consensus uses input-group document frequency and deduplicates equivalent answers', () => {
  const { rows } = fixture(), base = rows[0];
  const pool = ['a', 'b', 'duplicate', 'x', 'y'].map(key => ({ ...base, key, inputKey: ['x', 'y'].includes(key) ? key : 'q' }));
  const answers = new Map([['a', 'common'], ['b', 'common rare'], ['duplicate', 'common rare'], ['x', 'common'], ['y', 'common']]);
  const f = drain(weightedFeaturesSteps(drain(sharedAnswerFeaturesSteps(pool, answers))));
  const rare = 1 + Math.log(2);
  assert.equal(f.scores.get('a'), 5 / (5 + 4 * rare));
  assert.equal(f.scores.get('b'), 5 / (5 + rare));
  assert.equal(f.scores.get('b'), f.scores.get('duplicate'));
  assert.equal(f.scores.get('x'), 0); assert.equal(f.comparisons, 2);
});

test('weighted answer substitution preserves inputs, count, cost, coverage and every required path', () => {
  const { rows, answers } = fixture(), input = (key: string) => rows.find(r => r.key === key)!.inputKey;
  for (const k of [1, 12, 40, 500]) {
    const base = reusedSample(rows, answers, k), result = weightedSample(rows, answers, k);
    assert.deepEqual(result.selected.map(s => input(s.key)), base.selected.map(s => input(s.key)));
    assert.equal(result.optimization.tokens, base.optimization.tokens); assert.equal(result.optimization.vocabulary, base.optimization.vocabulary);
    assert.equal(new Set(result.selected.map(s => s.key)).size, result.selected.length);
    const cells = new Set(result.selected.flatMap(s => s.path.cells)); for (const cell of base.selected.flatMap(s => s.path.cells)) assert.ok(cells.has(cell));
    assert.deepEqual(result, weightedSample([...rows].reverse(), answers, k));
  }
});
