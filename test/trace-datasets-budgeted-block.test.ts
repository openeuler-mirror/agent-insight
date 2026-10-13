import test from 'node:test';
import assert from 'node:assert/strict';
import { fastSample as completeSample, FAST_POLICY as COMPLETE_POLICY } from '../src/lib/trace-datasets/sampling/budgeted-fast';
import { blockSample as fastSample, blockSampleSteps as fastSampleSteps, BLOCK_POLICY as FAST_POLICY } from '../src/lib/trace-datasets/sampling/budgeted-block';
import { agreementSample } from '../src/lib/trace-datasets/sampling/budgeted-agreement';
import { acceleratedSample } from '../src/lib/trace-datasets/sampling/budgeted-accelerated';
import { POLICY, type Candidate } from '../src/lib/trace-datasets/sampling';

test('block scans preserve ordered IDs, paths, reasons, counts and diagnostics across constrained variants', () => {
  let random = 913;
  const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random / 2 ** 32; };
  for (let trial = 0; trial < 16; trial++) {
    const rows: Candidate[] = Array.from({ length: 40 }, (_, i) => {
      const cost = [12, 48, 180, 600][i % 4];
      const terms = [...new Set(Array.from({ length: 6 + Math.floor(next() * 6) }, () => `t${Math.floor(next() * 60)}`))];
      return { key: `p${i}`, inputKey: `p${i}`, task: ['coding', 'lookup', 'unknown'][i % 3], signature: new Uint32Array(128), lexical: { terms, tokenCount: cost }, paths: [{ key: `a${i}`, cells: trial % 2 ? [`tool:${i % 3}`, `tool:${i % 3}`] : [], knownDimensions: 1 }, { key: `b${i}`, cells: [`retry:${i % 2}`], knownDimensions: 1 }] };
    });
    for (let i = 0; i < 5; i++) rows.push({ ...rows[i], key: `variant${i}`, paths: [{ key: `v${i}`, cells: [`variant:${i}`], knownDimensions: 1 }] });
    for (const k of [1, 12, 42]) {
      const seed = 42 + trial, experiment = { budgetRatio: [1, 1.1, 1.2][trial % 3] };
      const old = completeSample(rows, k, { ...COMPLETE_POLICY, seed }, experiment);
      const result = fastSample(rows, k, { ...FAST_POLICY, seed }, experiment);
      assert.deepEqual(result.selected, old.selected);
      assert.deepEqual(result.counts, old.counts);
      assert.deepEqual({ ...result.optimization, requestedPolicy: old.optimization.requestedPolicy, effectivePolicy: old.optimization.effectivePolicy }, old.optimization);
      assert.deepEqual(result, fastSample([...rows].reverse(), k, { ...FAST_POLICY, seed }, experiment));
    }
  }
});

test('block search remains cancellable and leaves the caller and v4 default unchanged', () => {
  const rows: Candidate[] = Array.from({ length: 300 }, (_, i) => ({ key: `${i}`, inputKey: `${i}`, task: 'unknown', signature: new Uint32Array(128), lexical: { terms: [`word${i}`], tokenCount: 1 }, paths: [{ key: `${i}`, cells: [], knownDimensions: 0 }] }));
  const before = JSON.stringify(rows), iterator = fastSampleSteps(rows, 20);
  assert.equal(iterator.next().done, false); iterator.return(undefined as never);
  assert.equal(JSON.stringify(rows), before); assert.equal(POLICY.version, 'trace-coverage-v4');
});


test('accelerated v6.8 preserves the complete v6.7 answer and input agreement result', () => {
  const rows: Candidate[] = [], answers = new Map<string, string>();
  for (let i = 0; i < 48; i++) for (let v = 0; v < 3; v++) {
    const key = `q${i}-${v}`;
    rows.push({ key, inputKey: `q${i}`, task: ['coding', 'writing', 'unknown'][i % 3], signature: new Uint32Array(128), lexical: { terms: [`own${i}`, `shared${i % 11}`], tokenCount: [12, 48, 180, 600][i % 4] }, paths: [{ key: `path${key}`, cells: [`tool:${i % 4}`], knownDimensions: 1 }] });
    answers.set(key, v === 2 ? 'outlier' : v ? 'beta alpha' : 'alpha beta gamma');
  }
  for (const k of [1, 12, 100]) {
    const old = agreementSample(rows, answers, k), result = acceleratedSample(rows, answers, k);
    assert.deepEqual(result.selected, old.selected); assert.deepEqual(result.counts, old.counts); assert.deepEqual(result.agreement, old.agreement);
    assert.deepEqual({ ...result.optimization, requestedPolicy: old.optimization.requestedPolicy, effectivePolicy: old.optimization.effectivePolicy }, old.optimization);
    assert.deepEqual(result, acceleratedSample([...rows].reverse(), answers, k));
  }
});
