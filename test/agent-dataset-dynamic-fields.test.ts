import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeCase,
  normalizeFields,
  validateCasesForKind,
} from '@/server/agent_datasets_storage';

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
