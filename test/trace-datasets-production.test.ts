import test from 'node:test';
import assert from 'node:assert/strict';
import { COVERAGE_POLICY, LEGACY_POLICY, hash, lexicalFeatures, sample, signature, type Candidate } from '../src/lib/trace-datasets/sampling';
import { PRODUCTION_POLICY, productionSampleSteps } from '../src/lib/trace-datasets/sampling/production';

function drain<T>(steps: Generator<void, T>): T {
  let result = steps.next();
  while (!result.done) result = steps.next();
  return result.value;
}

function fixture() {
  const candidates: Candidate[] = [], answers = new Map<string, string>();
  for (let i = 0; i < 24; i++) {
    const input = `Explain subject ${i} ` + Array.from({ length: i * 3 + 4 }, (_, j) => `word${(j + i * 7) % 120}`).join(' ');
    for (let v = 0; v < 1 + i % 3; v++) {
      const answer = v ? `Answer ${i} with supporting explanation details ${v}` : `Answer ${i} answer answer answer`;
      const key = hash([input, answer]);
      candidates.push({ key, inputKey: hash([input]), task: i % 2 ? 'coding' : 'unknown', signature: signature(input), lexical: lexicalFeatures(input), paths: [{ key: `${key}:path`, cells: [`tool:${i % 4}`], knownDimensions: 1 }] });
      answers.set(key, answer);
    }
  }
  return { candidates, answers };
}

test('production v6.35 preserves frozen selections, paths and diagnostics', () => {
  const { candidates, answers } = fixture();
  assert.equal(PRODUCTION_POLICY.version, 'trace-coverage-v6.35');
  const expected = {
    1: '56f118071b38763fa8584c3bf275ed6b45f3e4f918e1dc58b04784d1a904a055',
    20: '69ae47250e0505a8ad0174c1d2c1d14825c8ae5ad668ecb6ce2989f16c5107c9',
    500: 'd821d0e7133d7c0a0e17669f4befbe39b9d4ba271a0cf101d5074836267d3cfc',
  };
  for (const limit of [1, 20, 500] as const) {
    assert.equal(hash(drain(productionSampleSteps(candidates, answers, limit))), expected[limit]);
  }
});

test('persisted v4/v5 configurations keep original behavior without answer features', () => {
  const { candidates } = fixture();
  for (const policy of [LEGACY_POLICY, COVERAGE_POLICY]) {
    assert.deepEqual(drain(productionSampleSteps(candidates, new Map(), 20, policy)), sample(candidates, 20, policy));
  }
});

test('production rejects unknown policies and corrupt features, and remains interruptible', () => {
  const { candidates, answers } = fixture();
  assert.throws(() => drain(productionSampleSteps(candidates, answers, 20, { ...PRODUCTION_POLICY, version: 'trace-coverage-v6.36' })), /INVALID_CONFIG/);
  assert.throws(() => drain(productionSampleSteps(candidates, answers, 20, { ...PRODUCTION_POLICY, signatureProtocol: 'unknown' })), /INVALID_CONFIG/);
  assert.throws(() => drain(productionSampleSteps(candidates, new Map(), 20)), /SOURCE_CORRUPT/);
  assert.throws(() => drain(productionSampleSteps(candidates.map(c => ({ ...c, lexical: undefined })), answers, 20)), /SOURCE_CORRUPT/);
  assert.throws(() => drain(productionSampleSteps([], new Map(), 20)), /NO_VALID_SAMPLES/);
  const steps = productionSampleSteps(candidates, answers, 20);
  assert.equal(steps.next().done, false);
  assert.throws(() => steps.throw(new Error('CANCELLED')), /CANCELLED/);
});
