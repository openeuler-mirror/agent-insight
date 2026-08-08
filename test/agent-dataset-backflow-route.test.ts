import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mapBackflowCanonicalValues,
  normalizeBackflowValues,
  parseBackflowFieldMappings,
  POST,
  parseBackflowFields,
} from '@/app/api/agent-datasets/backflow/route';

test('keeps trace backflow as a native JSON array', () => {
  const trace = [
    { role: 'user', content: 'inspect the logs' },
    { role: 'assistant', tool_calls: [{ name: 'read', output: 'done' }] },
  ];
  const values = normalizeBackflowValues(
    { trace },
    [{ id: 'trace', key: 'trace', label: 'Trace', type: 'json' }],
  );

  assert.deepEqual(values.trace, trace);
  assert.ok(Array.isArray(values.trace));
});

test('parses edited JSON field text before backflow persistence', () => {
  const values = normalizeBackflowValues(
    { trace: '[{"role":"user","content":"edited"}]' },
    [{ id: 'trace', key: 'trace', label: 'Trace', type: 'json' }],
  );

  assert.deepEqual(values.trace, [{ role: 'user', content: 'edited' }]);
  assert.throws(
    () => normalizeBackflowValues(
      { trace: '[invalid]' },
      [{ id: 'trace', key: 'trace', label: 'Trace', type: 'json' }],
    ),
    /field trace must be valid JSON/,
  );
});

test('maps trace artifacts into canonical dataset case fields', () => {
  const fields = parseBackflowFields([
    { key: 'input', label: '输入', type: 'text' },
    { key: 'reference_output', label: '预期输出', type: 'text' },
    { key: 'trajectory', label: '轨迹', type: 'json' },
  ]);
  const mappings = parseBackflowFieldMappings([
    { key: 'input', source: 'input' },
    { key: 'reference_output', source: 'output' },
    { key: 'trajectory', source: 'trace' },
  ], fields);
  const trace = [{ role: 'assistant', content: 'done' }];

  assert.deepEqual(mapBackflowCanonicalValues({
    input: 'question',
    reference_output: 'good answer',
    trajectory: trace,
  }, mappings), {
    input: 'question',
    expectedOutput: 'good answer',
    trajectory: trace,
  });
});

test('infers legacy output and trace field mappings for older clients', () => {
  const fields = parseBackflowFields([
    { key: 'input', label: '任务输入', type: 'text' },
    { key: 'output', label: '任务输出', type: 'text' },
    { key: 'trace', label: 'Trace', type: 'json' },
  ]);
  const mappings = parseBackflowFieldMappings(undefined, fields);

  assert.deepEqual(mapBackflowCanonicalValues({
    input: 'question',
    output: 'approved answer',
    trace: [{ role: 'assistant' }],
  }, mappings), {
    input: 'question',
    expectedOutput: 'approved answer',
    trajectory: [{ role: 'assistant' }],
  });
});

test('accepts an explicit backflow schema without an input field', () => {
  const fields = parseBackflowFields([
    { key: 'answer', label: '任务输出', type: 'text' },
    { key: 'execution_trace', label: 'Trace', type: 'json' },
  ]);

  assert.deepEqual(fields.map(field => field.key), ['answer', 'execution_trace']);
});

test('rejects new fields that collide with an existing dataset field', () => {
  assert.throws(
    () => parseBackflowFields(
      [{ key: 'scenario', label: '场景', type: 'text' }],
      { existingKeys: ['scenario'] },
    ),
    /field key scenario already exists/,
  );
});

test('rejects duplicate field names even when internal keys differ', () => {
  assert.throws(
    () => parseBackflowFields([
      { key: 'score_a', label: '评分', type: 'number' },
      { key: 'score_b', label: '评分', type: 'text' },
    ]),
    /field name 评分 already exists/,
  );
});

test('rejects an invalid new dataset schema before writing cases', async () => {
  const response = await POST(new Request('http://localhost/api/agent-datasets/backflow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user: 'test-user',
      mode: 'new',
      datasetName: 'new dataset',
      fields: [
        { key: 'output', label: '输出', type: 'text' },
        { key: 'output', label: '重复输出', type: 'text' },
      ],
      cases: [{ values: { output: 'processed result' } }],
    }),
  }));

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'field key output already exists' });
});

test('requires users to choose a target mode', async () => {
  const response = await POST(new Request('http://localhost/api/agent-datasets/backflow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user: 'test-user',
      cases: [{ values: { output: 'processed result' } }],
    }),
  }));

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'user, target mode and cases are required' });
});
