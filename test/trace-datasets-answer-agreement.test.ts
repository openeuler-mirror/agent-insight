import test from 'node:test';
import assert from 'node:assert/strict';
import { POLICY, type Candidate, type Selection } from '../src/lib/trace-datasets/sampling';
import { fastSample } from '../src/lib/trace-datasets/sampling/budgeted-fast';
import { agreementFeaturesSteps, consensusReplaceSteps, consensusSample, consensusSampleSteps } from '../src/lib/trace-datasets/sampling/answer-consensus';
import { agreementSample, agreementSampleSteps } from '../src/lib/trace-datasets/sampling/budgeted-agreement';

const run = <T>(steps: Generator<void, T>) => { let next = steps.next(); while (!next.done) next = steps.next(); return next.value; };
const row = (key: string, inputKey = 'input', cells: string[] = []): Candidate => ({ key, inputKey, task: 'unknown', signature: new Uint32Array(128), lexical: { terms: ['shared', inputKey], tokenCount: 12 }, paths: [{ key: `path-${key}`, cells, knownDimensions: cells.length }] });
const choose = (c: Candidate): Selection => ({ key: c.key, path: c.paths[0], reason: 'text_main' });

test('answer medoid improves agreement without changing the input or inventing a path', () => {
  const pool = [row('outlier'), row('a'), row('b'), row('c')];
  const answers = new Map([['outlier', 'wrong unrelated'], ['a', 'the answer is four'], ['b', 'the answer is four exactly'], ['c', 'four is the answer']]);
  const features = run(agreementFeaturesSteps(pool, answers)), result = run(consensusReplaceSteps(pool, [choose(pool[0])], features));
  assert.equal(result.replacements, 1); assert.equal(features.scores.get(result.selected[0].key), Math.max(...features.scores.values()));
  assert.ok(pool.some(c => c.key === result.selected[0].key && c.paths[0] === result.selected[0].path));
  assert.deepEqual(result, run(consensusReplaceSteps([...pool].reverse(), [choose(pool[0])], run(agreementFeaturesSteps([...pool].reverse(), answers)))));
});

test('singleton, paired ties, duplicate normalized answers, and required paths do not create false consensus', () => {
  const pool = [row('a'), row('b')], answers = new Map([['a', 'alpha beta'], ['b', 'alpha gamma']]);
  const f = run(agreementFeaturesSteps(pool, answers)); assert.equal(f.scores.get('a'), f.scores.get('b'));
  assert.deepEqual(run(consensusReplaceSteps(pool, [choose(pool[0])], f)).selected, [choose(pool[0])]);
  const dup = run(agreementFeaturesSteps(pool, new Map([['a', 'a\r\nb'], ['b', 'a\nb']]))); assert.equal(dup.groupScores.get('input'), 0);
  assert.equal(run(agreementFeaturesSteps([pool[0]], new Map([['a', 'answer']]))).scores.get('a'), 0);
  const protectedRows = [row('a', 'input', ['must-keep']), row('b'), row('c')];
  const protectedFeatures = run(agreementFeaturesSteps(protectedRows, new Map([['a', 'outlier'], ['b', 'alpha beta'], ['c', 'beta alpha']])));
  assert.equal(run(consensusReplaceSteps(protectedRows, [choose(protectedRows[0])], protectedFeatures)).replacements, 0);
  const selected = run(consensusReplaceSteps(protectedRows, protectedRows.map(choose), protectedFeatures)).selected;
  assert.equal(new Set(selected.map(s => s.key)).size, 3);
});

const mixture = () => {
  const rows: Candidate[] = [], answers = new Map<string, string>();
  for (let i = 0; i < 40; i++) for (let v = 0; v < 2; v++) {
    const c = row(`p${i}-${v}`, `input${i}`, ['common']); c.lexical = { terms: ['one', 'two'], tokenCount: 12 }; rows.push(c);
    answers.set(c.key, i < 20 ? (v ? 'omega' : 'alpha') : (v ? 'beta alpha' : 'alpha beta'));
  }
  return { rows, answers };
};

test('input agreement can change choices while retaining raw coverage, count, budget and real cells', () => {
  const { rows, answers } = mixture(), baseline = fastSample(rows, 10), result = agreementSample(rows, answers, 10);
  assert.ok(result.agreement.inputSwaps > 0); assert.equal(result.optimization.vocabulary, baseline.optimization.vocabulary);
  assert.equal(result.selected.length, 10); assert.equal(new Set(result.selected.map(s => s.key)).size, 10);
  assert.ok(result.optimization.tokens <= result.optimization.tokenBudget);
  assert.ok(result.optimization.lengthTV <= result.optimization.lengthLimit + 1e-9);
  assert.ok(result.optimization.taskTV <= result.optimization.taskLimit + 1e-9);
  assert.ok(result.selected.every(s => s.path.cells.includes('common')));
  assert.deepEqual(result, agreementSample([...rows].reverse(), answers, 10));
});

test('variant-only round preserves input sequence and cost, including K above input count', () => {
  const { rows, answers } = mixture();
  for (const k of [1, 20, 70, 100]) {
    const base = fastSample(rows, k), result = consensusSample(rows, answers, k), final = agreementSample(rows, answers, k);
    const input = (s: Selection) => rows.find(c => c.key === s.key)!.inputKey;
    assert.deepEqual(result.selected.map(input), base.selected.map(input));
    assert.equal(result.optimization.tokens, base.optimization.tokens); assert.equal(result.optimization.vocabulary, base.optimization.vocabulary);
    assert.equal(new Set(result.selected.map(s => s.key)).size, result.selected.length);
    assert.equal(final.selected.length, Math.min(k, rows.length));
    assert.equal(new Set(final.selected.map(s => s.key)).size, final.selected.length);
  }
});

test('no feasible construction remains the exact v4 fallback in both rounds', () => {
  const rare = row('rare', 'rare'); rare.task = 'rare-task'; rare.lexical!.tokenCount = 10000;
  const pool = [rare, ...Array.from({ length: 30 }, (_, i) => row(`p${i}`, `p${i}`))], answers = new Map(pool.map(c => [c.key, 'answer']));
  const base = fastSample(pool, 2);
  assert.equal(base.optimization.feasible, false);
  for (const result of [consensusSample(pool, answers, 2), agreementSample(pool, answers, 2)]) { assert.deepEqual(result.selected, base.selected); assert.equal(result.optimization.effectivePolicy, POLICY.version); }
});

test('answer feature preparation rejects missing answers, bounds peer comparisons and yields for cancellation', () => {
  const rows = Array.from({ length: 80 }, (_, i) => row(`p${i}`)), answers = new Map(rows.map(c => [c.key, `answer ${c.key}`]));
  assert.throws(() => run(agreementFeaturesSteps(rows, new Map())), /SOURCE_CORRUPT/);
  assert.equal(run(agreementFeaturesSteps(rows, answers)).comparisons, rows.length * 32);
  const before = JSON.stringify(rows);
  for (const iterator of [consensusSampleSteps(rows, answers, 20), agreementSampleSteps(rows, answers, 20)]) { assert.equal(iterator.next().done, false); iterator.return(undefined as never); }
  assert.equal(JSON.stringify(rows), before); assert.equal(POLICY.version, 'trace-coverage-v4');
});

test('input exchanges independently preserve coverage, token, distribution and task/path constraints on mixed pools', () => {
  for (let seed = 42; seed < 48; seed++) {
    const rows: Candidate[] = [], answers = new Map<string, string>();
    for (let i = 0; i < 48; i++) for (let v = 0; v < 3; v++) {
      const c = row(`${i}-${v}`, `${i}`, [`tool:${i % 3}`]);
      c.task = ['coding', 'writing', 'unknown'][i % 3];
      c.lexical = { tokenCount: [12, 48, 180, 600][i % 4], terms: [`term${i % 9}`, `term${i % 17}`, `own${i}`] };
      c.lexical.terms = [...new Set(c.lexical.terms)]; rows.push(c);
      answers.set(c.key, i % 2 ? ['alpha beta', 'beta alpha', 'alpha beta gamma'][v] : `distinct${v}`);
    }
    const base = fastSample(rows, 16, { ...POLICY, version: 'trace-coverage-v6.5', seed });
    const result = agreementSample(rows, answers, 16, { ...POLICY, version: 'trace-coverage-v6.7', seed });
    const selected = result.selected.map(s => rows.find(c => c.key === s.key)!);
    assert.equal(new Set(selected.map(c => c.key)).size, 16);
    assert.equal(result.optimization.tokens, selected.reduce((sum, c) => sum + c.lexical!.tokenCount, 0));
    assert.equal(result.optimization.vocabulary, new Set(selected.flatMap(c => c.lexical!.terms)).size);
    if (base.optimization.feasible) {
      assert.ok(result.optimization.vocabulary >= base.optimization.vocabulary);
      assert.ok(result.optimization.tokens <= result.optimization.tokenBudget);
      const actualTasks = new Set(selected.map(c => c.task)), cells = new Set(result.selected.flatMap(s => s.path.cells));
      for (const s of base.selected) { assert.ok(actualTasks.has(rows.find(c => c.key === s.key)!.task)); for (const cell of s.path.cells) assert.ok(cells.has(cell)); }
      assert.ok(result.optimization.lengthTV <= result.optimization.lengthLimit + 1e-9);
      assert.ok(result.optimization.taskTV <= result.optimization.taskLimit + 1e-9);
    }
  }
});
