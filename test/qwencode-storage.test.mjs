import assert from 'node:assert/strict';
import test from 'node:test';

import { accountScope } from '../scripts/qwencode-collector/storage.mjs';

test('QwenCode collector isolates account data using a stable non-secret key hash', () => {
  const first = accountScope('test-api-key-a');
  const repeated = accountScope('test-api-key-a');
  const second = accountScope('test-api-key-b');

  assert.equal(first, repeated);
  assert.notEqual(first, second);
  assert.match(first, /^key-[a-f0-9]{16}$/);
  assert.doesNotMatch(first, /test-api-key-a/);
});

test('QwenCode collector keeps missing credentials in an explicit anonymous scope', () => {
  assert.equal(accountScope(''), 'anonymous');
});
