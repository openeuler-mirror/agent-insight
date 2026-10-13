import test from 'node:test';
import assert from 'node:assert/strict';
import { hash, lexicalFeatures, signature, POLICY, sample, COVERAGE_POLICY, type Candidate, type Selection } from '../src/lib/trace-datasets/sampling';
import { sharedAnswerFeaturesSteps } from '../src/lib/trace-datasets/sampling/answer-shared';
import { weightedFeaturesSteps } from '../src/lib/trace-datasets/sampling/answer-weighted';
import { directAnswerFeaturesSteps } from '../src/lib/trace-datasets/sampling/answer-direct';
import { pricedSample, pricedSampleSteps } from '../src/lib/trace-datasets/sampling/budgeted-priced';
import { crossingImproveSteps, crossingSample, crossingSampleSteps } from '../src/lib/trace-datasets/sampling/budgeted-crossing';
import { highRecallSample, highRecallSampleSteps } from '../src/lib/trace-datasets/sampling/answer-high-recall';

function drain<T>(steps: Generator<void, T>): T { let n = steps.next(); while (!n.done) n = steps.next(); return n.value; }
function fixture() {
  const rows: Candidate[] = [], answers = new Map<string, string>();
  for (let i = 0; i < 32; i++) {
    const input = `question ${i} ` + Array.from({ length: 8 + 5 * i }, (_, j) => `word${(i * 13 + j) % 190}`).join(' ');
    for (let v = 0; v < 1 + i % 3; v++) {
      const answer = v ? `answer ${i} with explanation detail extra ${v}` : `answer ${i}`, key = hash([input, answer]); answers.set(key, answer);
      rows.push({ key, inputKey: hash([input]), lexical: lexicalFeatures(input), signature: signature(input), task: ['coding', 'writing', 'unknown'][i % 3], paths: [{ key: `${key}:a`, cells: [`tool:${i % 4}`], knownDimensions: 1 }, { key: `${key}:b`, cells: ['common'], knownDimensions: 1 }] });
    }
  }
  return { rows, answers };
}
function actual(rows: Candidate[], selected: Selection[]) {
  const byKey = new Map(rows.map(r => [r.key, r]));
  return { vocabulary: new Set(selected.flatMap(s => byKey.get(s.key)!.lexical!.terms)).size, tokens: selected.reduce((n, s) => n + byKey.get(s.key)!.lexical!.tokenCount, 0) };
}

test('direct F2 exactly preserves weighted support with duplicates and the 32-answer cap; F4 has analytic scores', () => {
  const { rows, answers } = fixture();
  for (let i = 0; i < 40; i++) { rows.push({ ...rows[0], key: `extra${i}` }); answers.set(`extra${i}`, i ? `common extra ${i}` : answers.get(rows[0].key)!); }
  assert.deepEqual(drain(directAnswerFeaturesSteps(rows, answers)), drain(weightedFeaturesSteps(drain(sharedAnswerFeaturesSteps(rows, answers)))));
  const pool = ['a', 'b', 'copy', 'x', 'y'].map(key => ({ ...rows[0], key, inputKey: ['x', 'y'].includes(key) ? key : 'q' }));
  const f = drain(directAnswerFeaturesSteps(pool, new Map([['a', 'common'], ['b', 'common rare'], ['copy', 'common rare'], ['x', 'common'], ['y', 'common']]), 4));
  const rare = 1 + Math.log(2);
  assert.equal(f.scores.get('a'), 17 / (17 + 16 * rare)); assert.equal(f.scores.get('b'), 17 / (17 + rare));
  assert.equal(f.scores.get('copy'), f.scores.get('b')); assert.equal(f.scores.get('x'), 0); assert.equal(f.comparisons, 2);
  assert.throws(() => drain(directAnswerFeaturesSteps(rows, new Map())), /SOURCE_CORRUPT/);
});

test('priced construction retains hard bounds and real v5 floors across counts, budgets and reversed input', () => {
  const { rows, answers } = fixture();
  for (const k of [1, 12, 40, 500]) for (const budgetRatio of [1, 1.1, 1.2]) {
    const r = pricedSample(rows, answers, k, undefined, { budgetRatio }), metrics = actual(rows, r.selected);
    assert.equal(r.selected.length, Math.min(k, rows.length)); assert.equal(new Set(r.selected.map(s => s.key)).size, r.selected.length);
    assert.equal(metrics.tokens, r.optimization.tokens); assert.equal(metrics.vocabulary, r.optimization.vocabulary);
    if (r.optimization.feasible) {
      assert.ok(metrics.tokens <= r.optimization.tokenBudget); assert.ok(r.optimization.lengthTV <= r.optimization.lengthLimit + 1e-9); assert.ok(r.optimization.taskTV <= r.optimization.taskLimit + 1e-9);
      const floor = sample(rows, k, COVERAGE_POLICY).selected.filter(s => ['task_floor', 'behavior'].includes(s.reason));
      const cells = new Set(r.selected.flatMap(s => s.path.cells)); for (const c of floor.flatMap(s => s.path.cells)) assert.ok(cells.has(c));
    } else assert.deepEqual(r.selected, sample(rows, k).selected);
    for (const p of r.selected) assert.ok(rows.find(row => row.key === p.key)!.paths.some(path => path.key === p.path.key && JSON.stringify(path.cells) === JSON.stringify(p.path.cells)));
    assert.deepEqual(pricedSample([...rows].reverse(), answers, k, undefined, { budgetRatio }), r);
  }
  assert.throws(() => pricedSample(rows, answers, 0), /INVALID_CONFIG/);
  assert.throws(() => pricedSample(rows, answers, 3, undefined, { budgetRatio: 1.25 }), /INVALID_CONFIG/);
  assert.throws(() => pricedSample([rows[0], rows[0]], answers, 2), /SOURCE_CORRUPT/);
});

test('crossing can explore over-budget states but returns the original feasible optimum when no better set fits', () => {
  const base = fixture().rows[0];
  const rows = [
    { ...base, key: 'a', inputKey: 'a', lexical: { terms: ['a','b','c','d'], tokenCount: 8 } },
    { ...base, key: 'b', inputKey: 'b', lexical: { terms: ['e','f','g','h'], tokenCount: 8 } },
    { ...base, key: 'c', inputKey: 'c', lexical: { terms: ['i','j','k','l','m','n','o','p','q','r'], tokenCount: 10 } },
  ].map(r => ({ ...r, paths: [{ key: r.key, cells: ['required'], knownDimensions: 1 }] }));
  const selected = rows.slice(0,2).map(r => ({ key: r.key, path: r.paths[0], reason: 'initial' }));
  const f = drain(directAnswerFeaturesSteps(rows, new Map(rows.map(r => [r.key, 'answer']))));
  const r = drain(crossingImproveSteps(rows, selected, f, { seed: 42, tokenBudget: 16, distributionEnabled: true }));
  assert.ok(r.crossing.overBudgetSteps > 0); assert.equal(r.tokens, 16); assert.equal(r.vocabulary, 8); assert.deepEqual(r.selected, selected);
  assert.throws(() => drain(crossingImproveSteps(rows, selected, f, { seed: 42, tokenBudget: 15, distributionEnabled: true })), /INFEASIBLE_START/);
});

test('crossing exact accounting agrees with a tiny exhaustive bound and cannot publish infeasible improvements', () => {
  const base = fixture().rows[0];
  for (let seed = 1; seed <= 10; seed++) {
    let state = seed; const next = () => { state = (state * 1664525 + 1013904223) >>> 0; return state; };
    const rows = Array.from({ length: 7 }, (_, i) => {
      const terms = [...new Set(Array.from({ length: 3 + next() % 6 }, () => `t${next() % 16}`))], cost = terms.length + next() % 5;
      return { ...base, key: `${i}`, inputKey: `${i}`, lexical: { terms, tokenCount: cost }, paths: [{ key: `${i}`, cells: ['required'], knownDimensions: 1 }] };
    });
    const initial = rows.slice(0,3).map(r => ({ key: r.key, path: r.paths[0], reason: 'initial' })), budget = actual(rows, initial).tokens;
    const features = drain(directAnswerFeaturesSteps(rows, new Map(rows.map(r => [r.key, 'answer']))));
    const result = drain(crossingImproveSteps(rows, initial, features, { seed, tokenBudget: budget, distributionEnabled: true }));
    let bound = 0;
    for (let i=0;i<5;i++) for(let j=i+1;j<6;j++) for(let k=j+1;k<7;k++) { const m=actual(rows,[i,j,k].map(n=>({key:rows[n].key,path:rows[n].paths[0],reason:'enum'}))); if(m.tokens<=budget) bound=Math.max(bound,m.vocabulary); }
    assert.deepEqual(actual(rows,result.selected), {vocabulary:result.vocabulary,tokens:result.tokens}); assert.ok(result.tokens<=budget); assert.ok(result.vocabulary>=actual(rows,initial).vocabulary && result.vocabulary<=bound);
    assert.deepEqual(drain(crossingImproveSteps([...rows].reverse(),initial,features,{seed,tokenBudget:budget,distributionEnabled:true})),result);
  }
});

test('F4 changes only compatible answers while crossing retains the feasible coverage floor', () => {
  const { rows, answers } = fixture(), input = (key:string) => rows.find(r => r.key === key)!.inputKey;
  for (const k of [1,12,40,500]) {
    const a=pricedSample(rows,answers,k), b=crossingSample(rows,answers,k), c=highRecallSample(rows,answers,k);
    if(a.optimization.feasible) { assert.ok(b.optimization.feasible); assert.ok(b.optimization.vocabulary>=a.optimization.vocabulary); if(b.optimization.vocabulary===a.optimization.vocabulary) assert.ok(b.optimization.tokens<=a.optimization.tokens); }
    assert.deepEqual(c.selected.map(s=>input(s.key)),b.selected.map(s=>input(s.key))); assert.deepEqual(actual(rows,c.selected),actual(rows,b.selected));
    const cells=new Set(c.selected.flatMap(s=>s.path.cells)); for(const cell of b.selected.flatMap(s=>s.path.cells)) assert.ok(cells.has(cell));
    assert.equal(new Set(c.selected.map(s=>s.key)).size,c.selected.length); assert.deepEqual(c,highRecallSample([...rows].reverse(),answers,k));
  }
});

test('all priced candidates yield for cancellation without mutation and leave production default v4', () => {
  const {rows,answers}=fixture(), snapshot=structuredClone(rows);
  for(const sampleSteps of [pricedSampleSteps,crossingSampleSteps,highRecallSampleSteps]) { const steps=sampleSteps(rows,answers,12); assert.equal(steps.next().done,false); steps.return(undefined as never); }
  assert.deepEqual(rows,snapshot); assert.equal(POLICY.version,'trace-coverage-v4');
});
