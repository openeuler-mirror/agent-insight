import test from 'node:test';
import assert from 'node:assert/strict';
import { POLICY, lengthBucket, type Candidate, type Selection } from '../src/lib/trace-datasets/sampling';
import { type AgreementFeatures } from '../src/lib/trace-datasets/sampling/answer-consensus';
import { pairwiseImproveSteps, pairwiseSample, pairwiseSampleSteps } from '../src/lib/trace-datasets/sampling/budgeted-pairwise';
import { weightedSample } from '../src/lib/trace-datasets/sampling/answer-weighted';

const row = (key: string, terms: string[], cost = 12, inputKey = key): Candidate => ({ key, inputKey, task: 'unknown', lexical: { terms, tokenCount: cost }, signature: new Uint32Array(128), paths: [{ key: `path:${key}`, cells: [], knownDimensions: 0 }] });
const choose = (r: Candidate): Selection => ({ key: r.key, path: r.paths[0], reason: 'text_main' });
const drain = <T>(steps: Generator<void, T>) => { let n = steps.next(); while (!n.done) n = steps.next(); return n.value; };
const features = (pool: Candidate[]): AgreementFeatures => {
  const groups = new Map<string, Candidate[]>(); for (const r of pool) { const list = groups.get(r.inputKey) || []; list.push(r); groups.set(r.inputKey, list); }
  return { groups, scores: new Map(pool.map(r => [r.key, 0])), groupScores: new Map([...groups.keys()].map(k => [k, 0])), comparisons: 0 };
};
const settings = (pool: Candidate[], tokenBudget = 24) => ({ tokenBudget, distributionEnabled: true, coverageUpperBound: new Set(pool.flatMap(r => r.lexical!.terms)).size });

test('two-for-two crosses a barrier where every single exchange loses coverage', () => {
  const pool = [row('a', ['a', 'b', 'c', 'd']), row('b', ['e', 'f', 'g', 'h']), row('c', ['a', 'b', 'e', 'f', 'x']), row('d', ['c', 'd', 'g', 'h', 'y'])];
  for (const out of [0, 1]) for (const inc of [2, 3]) assert.ok(new Set([...pool[1 - out].lexical!.terms, ...pool[inc].lexical!.terms]).size < 8);
  const result = drain(pairwiseImproveSteps(pool, pool.slice(0, 2).map(choose), features(pool), settings(pool)));
  assert.equal(result.vocabulary, 10); assert.equal(result.tokens, 24); assert.equal(result.pairwise.accepted, 1);
  assert.deepEqual(new Set(result.selected.map(s => s.key)), new Set(['c', 'd']));
});

test('pairwise equal-coverage replacement must save cost and preserve true joint paths', () => {
  const pool = [row('a', ['a', 'b'], 12), row('b', ['c', 'd'], 12), row('c', ['a', 'c'], 8), row('d', ['b', 'd'], 8)];
  pool[0].paths[0].cells = ['left']; pool[1].paths[0].cells = ['right'];
  const original = pool.slice(0, 2).map(choose);
  const blocked = drain(pairwiseImproveSteps(pool, original, features(pool), settings(pool)));
  assert.deepEqual(blocked.selected, original);
  pool[2].paths.push({ key: 'real-left', cells: ['left'], knownDimensions: 1 }); pool[3].paths[0].cells = ['right'];
  const allowed = drain(pairwiseImproveSteps(pool, original, features(pool), settings(pool)));
  assert.equal(allowed.vocabulary, 4); assert.equal(allowed.tokens, 16); assert.equal(allowed.pairwise.accepted, 1);
  assert.deepEqual(new Set(allowed.selected.flatMap(s => s.path.cells)), new Set(['left', 'right']));
  assert.ok(allowed.selected.every(s => pool.find(r => r.key === s.key)!.paths.some(p => p.key === s.path.key)));
});

test('bounded pair results agree with independent set counts and tiny exhaustive bounds', () => {
  for (let seed = 1; seed <= 12; seed++) {
    let state = seed; const rand = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
    const pool = Array.from({ length: 6 }, (_, i) => row(String(i), [...new Set(Array.from({ length: 6 }, () => `t${rand() % 11}`))]));
    let optimum = 0; for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) optimum = Math.max(optimum, new Set([...pool[i].lexical!.terms, ...pool[j].lexical!.terms]).size);
    const result = drain(pairwiseImproveSteps(pool, pool.slice(0, 2).map(choose), features(pool), settings(pool)));
    const terms = new Set(result.selected.flatMap(s => pool.find(r => r.key === s.key)!.lexical!.terms));
    assert.equal(result.vocabulary, terms.size); assert.ok(result.vocabulary <= optimum);
    assert.ok(result.vocabulary >= new Set(pool.slice(0, 2).flatMap(r => r.lexical!.terms)).size);
    assert.equal(result.tokens, 24); assert.equal(result.selected.length, 2);
    assert.deepEqual(result, drain(pairwiseImproveSteps([...pool].reverse(), pool.slice(0, 2).map(choose), features([...pool].reverse()), settings(pool))));
  }
});

test('pairwise full pipeline preserves hard constraints, explicit fallback, cancellation and v4 default', () => {
  const pool: Candidate[] = [], answers = new Map<string, string>();
  for (let i = 0; i < 28; i++) for (let v = 0; v < 1 + i % 2; v++) {
    const c = row(`${i}:${v}`, [`own${i}`, `shared${i % 3}`], [12, 50, 200, 600][i % 4], String(i));
    c.task = i % 2 ? 'coding' : 'writing'; c.paths[0].cells = [`path${i % 3}`]; pool.push(c); answers.set(c.key, v ? 'alpha beta gamma' : 'alpha');
  }
  const byKey = new Map(pool.map(c => [c.key, c]));
  for (const k of [1, 12, 35, 100]) {
    const before = weightedSample(pool, answers, k), next = pairwiseSample(pool, answers, k);
    if (!before.optimization.feasible) { assert.deepEqual(next.selected, before.selected); assert.equal(next.optimization.effectivePolicy, 'trace-coverage-v4'); continue; }
    const selected = next.selected.map(s => byKey.get(s.key)!);
    assert.equal(next.selected.length, before.selected.length); assert.equal(new Set(next.selected.map(s => s.key)).size, next.selected.length);
    assert.equal(new Set(selected.flatMap(r => r.lexical!.terms)).size, next.optimization.vocabulary);
    assert.equal(selected.reduce((sum, r) => sum + r.lexical!.tokenCount, 0), next.optimization.tokens);
    assert.ok(next.optimization.vocabulary >= before.optimization.vocabulary); assert.ok(next.optimization.tokens <= next.optimization.tokenBudget);
    const cells = new Set(next.selected.flatMap(s => s.path.cells)); for (const c of before.selected.flatMap(s => s.path.cells)) assert.ok(cells.has(c));
    const unique = [...new Map(selected.map(c => [c.inputKey, c])).values()], source = [...new Map(pool.map(c => [c.inputKey, c])).values()];
    const variation = (fn: (c: Candidate) => string | number) => [...new Set(source.map(fn))].reduce<number>((sum, x) => sum + Math.abs(unique.filter(c => fn(c) === x).length / unique.length - source.filter(c => fn(c) === x).length / source.length), 0) / 2;
    assert.ok(Math.abs(variation(c => lengthBucket(c.lexical!.tokenCount)) - next.optimization.lengthTV) < 1e-10);
    assert.ok(Math.abs(variation(c => c.task) - next.optimization.taskTV) < 1e-10);
    assert.ok(next.optimization.lengthTV <= next.optimization.lengthLimit + 1e-9); assert.ok(next.optimization.taskTV <= next.optimization.taskLimit + 1e-9);
    assert.deepEqual(next, pairwiseSample([...pool].reverse(), answers, k));
  }
  const snapshot = structuredClone(pool), steps = pairwiseSampleSteps(pool, answers, 12); assert.equal(steps.next().done, false); steps.return(undefined as never);
  assert.deepEqual(pool, snapshot); assert.equal(POLICY.version, 'trace-coverage-v4');
});
