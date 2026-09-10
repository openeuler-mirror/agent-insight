import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCaseComparisonPairs } from '../../src/lib/evaluation-harness/case-comparison';

const snapshot = (dimension = 'skill', sameDataset = true) => ({
  kind: 'evaluation-harness-v1', comparison: { dimension },
  groups: ['A', 'B'].map(key => ({ id: key, key, dataset: { assetKey: sameDataset ? 'dataset' : `dataset-${key}` } })),
});
const row = (id: string, groupId: string | null, caseId: string, input = '申请', expectedOutput = '完成') => ({
  id, groupId, caseValuesJson: JSON.stringify({ id: caseId, name: '贷款申请', turns: [{ input, expectedOutput }] }),
});

test('same dataset uses Case identity and marks changed input or rules without losing either side', () => {
  const pairs = buildCaseComparisonPairs([
    row('a-one', 'A', 'one'), row('a-two', 'A', 'two'), row('a-removed', 'A', 'removed'),
    row('b-one', 'B', 'one'), row('b-two', 'B', 'two', '新申请'), row('b-added', 'B', 'added'),
  ], snapshot('dataset'))!;
  assert.deepEqual(pairs.map(pair => pair.status), ['matched', 'changed', 'a-only', 'b-only']);
  assert.deepEqual(pairs.map(pair => pair.caseIds), [['a-one', 'b-one'], ['a-two', 'b-two'], ['a-removed'], ['b-added']]);
});

test('different datasets reserve complete definition matches before matching changed rules by all turn inputs', () => {
  const pairs = buildCaseComparisonPairs([
    row('a-one', 'A', 'one', '申请', '规则一'), row('a-two', 'A', 'two', '申请', '规则二'),
    row('b-two', 'B', 'different-id', '申请', '规则二'),
  ], snapshot('dataset', false))!;
  assert.deepEqual(pairs.map(pair => pair.caseIds), [['a-one'], ['a-two', 'b-two']]);
  assert.deepEqual(pairs.map(pair => pair.status), ['a-only', 'matched']);
});

test('evaluator comparison preserves every shared Trace record even when several Traces use one Case', () => {
  const pairs = buildCaseComparisonPairs([
    row('trace-one', null, 'same-case'), row('trace-two', null, 'same-case'),
  ], snapshot('evaluator'))!;
  assert.deepEqual(pairs.map(pair => pair.status), ['shared', 'shared']);
  assert.equal(new Set(pairs.map(pair => pair.key)).size, 2);
  assert.deepEqual(pairs.map(pair => pair.caseIds), [['trace-one'], ['trace-two']]);
});

test('missing, malformed, or ambiguous repeated Case identity never silently merges execution rows', () => {
  const rows = [
    row('a-one', 'A', 'one'), row('a-again', 'A', 'one'), row('b-one', 'B', 'one'),
    { id: 'a-missing', groupId: 'A', caseValuesJson: '{}' },
    { id: 'b-invalid', groupId: 'B', caseValuesJson: '{' },
  ];
  const pairs = buildCaseComparisonPairs(rows, snapshot())!;
  assert.equal(pairs.length, rows.length);
  assert(pairs.every(pair => pair.caseIds.length === 1));
  assert.deepEqual(new Set(pairs.flatMap(pair => pair.caseIds)), new Set(rows.map(item => item.id)));
});

test('ordinary single and legacy comparison experiments keep their existing pagination path', () => {
  assert.equal(buildCaseComparisonPairs([row('one', null, 'one')], { kind: 'evaluation-harness-v1' }), null);
  assert.equal(buildCaseComparisonPairs([row('one', 'A', 'one')], { comparison: { dimension: 'skill' } }), null);
});
