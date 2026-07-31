import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultTraceBackflowSourceForField,
  nextDatasetFieldKey,
  parseDatasetNumberValue,
  sortTraceBackflowDatasetsByRecency,
} from '@/lib/agent-dataset-model';
import { extractTaskArtifacts } from '@/lib/engine/evaluation/task-artifacts';
import { POST as saveDataset } from '@/app/api/agent-datasets/route';

import {
  duplicateDatasetFieldName,
  normalizeCase,
  normalizeFields,
  validateDatasetFieldKeysForWrite,
  validateCasesForKind,
} from '@/server/agent_datasets_storage';

test('trace backflow keeps the original user input and final output', async () => {
  const artifacts = await extractTaskArtifacts({
    rawInput: '  原始用户输入  ',
    fallbackOutput: '  Agent 最终输出  ',
    interactions: [{ role: 'user', content: '原始用户输入' }],
  });

  assert.equal(artifacts.input, '  原始用户输入  ');
  assert.equal(artifacts.output, '  Agent 最终输出  ');
});

test('generates stable internal keys without exposing them as field input', () => {
  assert.equal(nextDatasetFieldKey([]), 'custom_field_1');
  assert.equal(
    nextDatasetFieldKey(['input', 'custom_field_1', 'custom_field_3']),
    'custom_field_2',
  );
});

test('maps standard dataset fields to trace backflow artifacts by default', () => {
  assert.equal(defaultTraceBackflowSourceForField('input'), 'input');
  assert.equal(defaultTraceBackflowSourceForField('reference_output'), 'output');
  assert.equal(defaultTraceBackflowSourceForField('expected_output'), 'output');
  assert.equal(defaultTraceBackflowSourceForField('trajectory'), 'trace');
  assert.equal(defaultTraceBackflowSourceForField('custom_field_1'), 'none');
});

test('selects the most recently updated dataset first for trace backflow', () => {
  const datasets = sortTraceBackflowDatasetsByRecency([
    { id: 'older', updatedAt: '2026-07-01T00:00:00.000Z' },
    { id: 'latest', updatedAt: '2026-07-30T00:00:00.000Z' },
    { id: 'unknown' },
  ]);

  assert.deepEqual(datasets.map(dataset => dataset.id), ['latest', 'older', 'unknown']);
});

test('detects duplicate dataset field names case-insensitively', () => {
  assert.equal(duplicateDatasetFieldName([
    { id: 'a', key: 'a', label: 'Score', type: 'number' },
    { id: 'b', key: 'b', label: 'score', type: 'text' },
  ]), 'score');
  assert.equal(duplicateDatasetFieldName([
    { id: 'a', key: 'a', label: '输入', type: 'text' },
    { id: 'b', key: 'b', label: '输出', type: 'text' },
  ]), null);
});

test('rejects duplicate field names through the dataset API', async () => {
  const response = await saveDataset(new Request('http://localhost/api/agent-datasets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user: 'test-user',
      name: 'duplicate field names',
      fields: [
        { key: 'score_a', label: '评分', type: 'number' },
        { key: 'score_b', label: '评分', type: 'text' },
      ],
      cases: [],
    }),
  }));

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'field name 评分 already exists' });
});

test('strict write validation rejects duplicate or invalid field keys', () => {
  assert.equal(validateDatasetFieldKeysForWrite([
    { key: 'input', label: '输入 1' },
    { key: 'input', label: '输入 2' },
  ]), 'field key input already exists');
  assert.equal(validateDatasetFieldKeysForWrite([
    { key: 'bad-key', label: '无效字段' },
  ]), 'field 1 key is invalid');
  assert.equal(validateDatasetFieldKeysForWrite([
    null,
  ]), 'field 1 is invalid');
  assert.equal(validateDatasetFieldKeysForWrite([]), null);
  assert.equal(validateDatasetFieldKeysForWrite(undefined), null);
});

test('dataset API rejects duplicate keys instead of silently dropping fields', async () => {
  const response = await saveDataset(new Request('http://localhost/api/agent-datasets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user: 'test-user',
      name: 'duplicate field keys',
      fields: [
        { key: 'input', label: '输入 1', type: 'text' },
        { key: 'input', label: '输入 2', type: 'text' },
      ],
      cases: [],
    }),
  }));

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'field key input already exists' });
});

test('dataset API rejects invalid keys instead of falling back to default fields', async () => {
  const response = await saveDataset(new Request('http://localhost/api/agent-datasets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user: 'test-user',
      name: 'invalid field keys',
      fields: [
        { key: 'bad-key', label: '无效字段', type: 'text' },
      ],
      cases: [],
    }),
  }));

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'field 1 key is invalid' });
});

test('parses dataset number fields without silently converting invalid input to null', () => {
  assert.equal(parseDatasetNumberValue('12.34'), 12.34);
  assert.equal(parseDatasetNumberValue('-2'), -2);
  assert.equal(parseDatasetNumberValue(''), '');
  assert.equal(parseDatasetNumberValue('   '), '');
  assert.throws(() => parseDatasetNumberValue('123abc'), /invalid number/);
  assert.throws(() => parseDatasetNumberValue('12.34.56'), /invalid number/);
  assert.throws(() => parseDatasetNumberValue('-'), /invalid number/);
  assert.throws(() => parseDatasetNumberValue(Number.NaN), /invalid number/);
});

test('normalizes legacy dataset cases into editable values', () => {
  const row = normalizeCase({
    id: 'legacy-case',
    input: 'question',
    expectedOutput: 'answer',
    trajectory: '{"steps":[]}',
  });

  assert.equal(row.values?.input, 'question');
  assert.equal(row.values?.reference_output, 'answer');
  assert.equal(row.values?.trajectory, '{"steps":[]}');
});

test('normalizes trace backflow values without requiring reference output', () => {
  const trace = [{ role: 'user', content: 'processed task' }];
  const row = normalizeCase({
    id: 'trace-case',
    values: {
      input: 'processed task',
      output: 'processed result',
      trace,
      scenario: 'failure',
    },
    source: 'trace-backflow',
  });

  assert.equal(row.input, 'processed task');
  assert.equal(row.expectedOutput, '');
  assert.equal(row.trajectory, JSON.stringify(trace));
  assert.deepEqual(row.values?.trace, trace);
  assert.equal(row.values?.scenario, 'failure');
  assert.deepEqual(validateCasesForKind([row], 'ideal_output'), []);
});

test('keeps legacy field edits authoritative when values are also present', () => {
  const row = normalizeCase({
    input: 'new question',
    expectedOutput: 'new answer',
    trajectory: 'new trace',
    values: {
      input: 'old question',
      reference_output: 'old answer',
      trajectory: 'old trace',
    },
  });

  assert.equal(row.input, 'new question');
  assert.equal(row.expectedOutput, 'new answer');
  assert.equal(row.trajectory, 'new trace');
  assert.equal(row.values?.input, 'new question');
  assert.equal(row.values?.reference_output, 'new answer');
});

test('accepts valid custom fields and removes duplicate keys', () => {
  const fields = normalizeFields([
    { key: 'input', label: 'Input', type: 'text', system: true },
    { key: 'scenario', label: 'Scenario', type: 'text' },
    { key: 'scenario', label: 'Duplicate', type: 'json' },
    { key: 'bad-key', label: 'Invalid', type: 'text' },
  ], 'ideal_output');

  assert.deepEqual(fields.map(field => field.key), ['input', 'scenario']);
});

test('allows datasets and cases without an input field', () => {
  const row = normalizeCase({
    values: {
      output: 'processed result',
      trace: '{"steps":[]}',
    },
    source: 'trace-backflow',
  });

  assert.equal(Object.hasOwn(row.values || {}, 'input'), false);
  assert.equal(row.input, '');
  assert.deepEqual(validateCasesForKind([row], 'trajectory'), []);
});
