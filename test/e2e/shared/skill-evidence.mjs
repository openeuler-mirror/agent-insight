import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function assertSnapshot(expected, actual) {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), 'Snapshot file list differs');
  for (const file of Object.keys(expected)) assert.equal(actual[file], expected[file], `Snapshot content differs: ${file}`);
  return Object.fromEntries(Object.entries(actual).map(([file, content]) => [file, createHash('sha256').update(content).digest('hex')]));
}

export function assertSkillAnswer(reply, summary = false) {
  const explanation = reply.split('E2E-SUMMARY')[0];
  assert.match(explanation, /(?<!\d)351(?!\d)/, 'Root failure count missing');
  assert.ok(explanation.includes('150.183.249.110'), 'Top source missing');
  assert.match(explanation, /(?<!\d)80(?!\d)/, 'Top source failure count missing');
  assert.match(explanation, /authentication failure;/, 'Actual log evidence missing');
  if (summary) {
    const objects = [...reply.matchAll(/E2E-SUMMARY\s*[:：]?\s*(\{[^\n]*?\})/g)];
    assert.equal(objects.length, 1, 'Exactly one E2E-SUMMARY JSON object is required');
    const result = JSON.parse(objects[0][1]);
    assert.deepEqual(result, { root_ssh_failures: 351, top_source: '150.183.249.110', top_source_failures: 80 });
    return result;
  }
  assert.ok(!reply.includes('E2E-SUMMARY'), 'Baseline unexpectedly includes candidate feature');
  return { root_ssh_failures: 351, top_source: '150.183.249.110', top_source_failures: 80 };
}
