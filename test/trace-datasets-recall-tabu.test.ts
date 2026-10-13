import test from 'node:test';
import assert from 'node:assert/strict';
import { POLICY, type Candidate, type Selection } from '../src/lib/trace-datasets/sampling';
import { acceleratedSample } from '../src/lib/trace-datasets/sampling/budgeted-accelerated';
import { recallFeaturesSteps, recallSample } from '../src/lib/trace-datasets/sampling/answer-recall';
import { tabuImproveSteps, tabuSample, tabuSampleSteps } from '../src/lib/trace-datasets/sampling/budgeted-tabu';
const run = <T>(g: Generator<void, T>) => { let r = g.next(); while (!r.done) r = g.next(); return r.value; };
const row = (key: string, terms: string[], inputKey = key, cost = 12): Candidate => ({ key, inputKey, lexical: { terms, tokenCount: cost }, task: 'unknown', signature: new Uint32Array(128), paths: [{ key: `path-${key}`, cells: [], knownDimensions: 0 }] });
const choose = (c: Candidate): Selection => ({ key: c.key, path: c.paths[0], reason: 'text_main' });

test('F2 consensus distinguishes unequal paired recall, preserves singleton and duplicate boundaries', () => {
  const pool = [row('a', ['query'], 'q'), row('b', ['query'], 'q')];
  const f = run(recallFeaturesSteps(pool, new Map([['a', 'alpha'], ['b', 'alpha beta gamma']])));
  assert.equal(f.scores.get('a'), 5 / 13); assert.equal(f.scores.get('b'), 5 / 7);
  const duplicate = run(recallFeaturesSteps(pool, new Map([['a', 'alpha\r\nbeta'], ['b', 'alpha\nbeta']])));
  assert.equal(duplicate.scores.get('a'), 0); assert.equal(duplicate.scores.get('b'), 0);
  assert.throws(() => run(recallFeaturesSteps(pool, new Map([['a', 'answer']]))), /SOURCE_CORRUPT/);
});

test('recall stage preserves ordered inputs, costs, vocabulary and required real paths', () => {
  const pool: Candidate[] = [], answers = new Map<string, string>();
  for (let i = 0; i < 24; i++) for (let v = 0; v < 3; v++) {
    const c = row(`${i}-${v}`, [`t${i % 8}`, `own${i}`], `${i}`, [12, 48, 180, 600][i % 4]);
    c.paths[0].cells = [v === 0 ? `private:${i}` : 'shared']; c.task = i % 2 ? 'coding' : 'writing'; pool.push(c);
    answers.set(c.key, ['alpha', 'alpha beta gamma', 'gamma beta alpha delta'][v]);
  }
  for (const k of [1, 12, 48, 100]) {
    const base = acceleratedSample(pool, answers, k), result = recallSample(pool, answers, k);
    const input = (s: Selection) => pool.find(c => c.key === s.key)!.inputKey;
    assert.deepEqual(result.selected.map(input), base.selected.map(input));
    assert.equal(result.optimization.tokens, base.optimization.tokens); assert.equal(result.optimization.vocabulary, base.optimization.vocabulary);
    const cells = new Set(result.selected.flatMap(s => s.path.cells)); for (const c of base.selected.flatMap(s => s.path.cells)) assert.ok(cells.has(c));
    assert.equal(new Set(result.selected.map(s => s.key)).size, result.selected.length);
    assert.deepEqual(result, recallSample([...pool].reverse(), answers, k));
  }
});

test('tabu exploration crosses a negative-coverage barrier and publishes only the improved feasible set', () => {
  const pool = [row('a', ['a', 'b', 'c', 'd']), row('b', ['e', 'f', 'g', 'h']), row('c', ['a', 'b', 'e', 'f', 'x']), row('d', ['c', 'd', 'g', 'h', 'y'])];
  const features = run(recallFeaturesSteps(pool, new Map(pool.map(c => [c.key, 'answer']))));
  const result = run(tabuImproveSteps(pool, pool.slice(0, 2).map(choose), features, { seed: 42, tokenBudget: 24, distributionEnabled: true }));
  assert.ok(result.tabu.negativeMoves > 0); assert.ok(result.tabu.bestUpdates > 0);
  assert.equal(result.vocabulary, 10); assert.equal(result.tokens, 24); assert.deepEqual(result.selected.map(s => s.key).sort(), ['c', 'd']);
  assert.ok(result.tabu.steps <= 2 * result.tabu.stepLimit);
});

test('unsuccessful tabu trajectories restore the exact original IDs, reasons and paths', () => {
  const pool = [row('a', ['a', 'b', 'c']), row('b', ['d', 'e', 'f']), row('c', ['a', 'd']), row('d', ['b', 'e'])];
  const features = run(recallFeaturesSteps(pool, new Map(pool.map(c => [c.key, 'answer'])))), initial = pool.slice(0, 2).map(choose);
  const result = run(tabuImproveSteps(pool, initial, features, { seed: 42, tokenBudget: 24, distributionEnabled: true }));
  assert.ok(result.tabu.negativeMoves > 0); assert.equal(result.tabu.bestUpdates, 0);
  assert.deepEqual(result.selected, initial); assert.equal(result.vocabulary, 6);
  assert.throws(() => run(tabuImproveSteps(pool, initial, features, { seed: 42, tokenBudget: 1, distributionEnabled: true })), /INFEASIBLE_START/);
});

test('tabu skips search only when both achievable coverage and global cost lower bounds are saturated', () => {
  const pool = Array.from({ length: 24 }, (_, i) => row(`${i}`, ['shared'], `${i}`, 1)), answers = new Map(pool.map(c => [c.key, 'answer']));
  const base = recallSample(pool, answers, 8), result = tabuSample(pool, answers, 8);
  assert.equal(result.optimization.vocabulary, result.optimization.coverageUpperBound);
  assert.equal(result.optimization.tokens, 8); assert.equal(result.tabu.steps, 0);
  assert.deepEqual(result.selected, base.selected);
});

test('tabu outputs independently preserve coverage, tasks, paths, counts and original constraints on mixed pools', () => {
  for (let seed = 42; seed < 46; seed++) {
    const pool: Candidate[] = [], answers = new Map<string, string>();
    for (let i = 0; i < 48; i++) for (let v = 0; v < 2; v++) {
      const c = row(`${i}-${v}`, [`t${i % 9}`, `u${i % 17}`, `own${i}`], `${i}`, [12, 48, 180, 600][i % 4]);
      c.task = ['coding', 'writing', 'unknown'][i % 3]; c.paths[0].cells = [`tool:${i % 4}`]; pool.push(c); answers.set(c.key, v ? 'alpha beta gamma' : 'alpha');
    }
    for (const k of [12, 70]) {
      const base = recallSample(pool, answers, k, { ...POLICY, version: 'trace-coverage-v6.9', seed }), result = tabuSample(pool, answers, k, { ...POLICY, version: 'trace-coverage-v6.10', seed });
      const selected = result.selected.map(s => pool.find(c => c.key === s.key)!);
      assert.equal(result.selected.length, k); assert.equal(new Set(selected.map(c => c.key)).size, k);
      assert.equal(result.optimization.tokens, selected.reduce((n, c) => n + c.lexical!.tokenCount, 0));
      assert.equal(result.optimization.vocabulary, new Set(selected.flatMap(c => c.lexical!.terms)).size);
      if (base.optimization.feasible) {
        assert.ok(result.optimization.vocabulary >= base.optimization.vocabulary); assert.ok(result.optimization.tokens <= result.optimization.tokenBudget);
        assert.ok(result.optimization.lengthTV <= result.optimization.lengthLimit + 1e-9); assert.ok(result.optimization.taskTV <= result.optimization.taskLimit + 1e-9);
        const tasks = new Set(selected.map(c => c.task)), cells = new Set(result.selected.flatMap(s => s.path.cells));
        for (const s of base.selected) { assert.ok(tasks.has(pool.find(c => c.key === s.key)!.task)); for (const cell of s.path.cells) assert.ok(cells.has(cell)); }
      }
      assert.deepEqual(result, tabuSample([...pool].reverse(), answers, k, { ...POLICY, version: 'trace-coverage-v6.10', seed }));
    }
  }
});

test('recall and tabu retain exact explicit fallback, while tabu remains cancellable and v4 stays default', () => {
  const rare = row('rare', ['rare'], 'rare', 10000); rare.task = 'rare-task';
  const pool = [rare, ...Array.from({ length: 300 }, (_, i) => row(`${i}`, [`w${i}`]))], answers = new Map(pool.map(c => [c.key, 'answer']));
  const base = acceleratedSample(pool, answers, 2); assert.equal(base.optimization.feasible, false);
  for (const result of [recallSample(pool, answers, 2), tabuSample(pool, answers, 2)]) { assert.deepEqual(result.selected, base.selected); assert.equal(result.optimization.effectivePolicy, POLICY.version); }
  const before = JSON.stringify(pool), steps = tabuSampleSteps(pool, answers, 20); assert.equal(steps.next().done, false); steps.return(undefined as never); assert.equal(JSON.stringify(pool), before);
  assert.equal(POLICY.version, 'trace-coverage-v4');
});
