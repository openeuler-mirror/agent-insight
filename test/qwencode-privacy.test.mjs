import assert from 'node:assert/strict';
import test from 'node:test';

import { redactSensitive, truncateContent } from '../scripts/qwencode-collector/privacy.mjs';

test('QwenCode collector redacts sensitive tool inputs recursively', () => {
  const result = redactSensitive({
    apiKey: 'sk-this-must-not-be-exported',
    nested: { authorization: 'Bearer top-secret-token' },
    text: 'token sk-another-secret',
  });
  assert.deepEqual(result, {
    apiKey: '[REDACTED]',
    nested: { authorization: '[REDACTED]' },
    text: 'token [REDACTED]',
  });
});

test('QwenCode collector truncates prompt and result content at 2000 characters', () => {
  const result = truncateContent('a'.repeat(2_500));
  const expected = `${'a'.repeat(2_000)}…[truncated]`;
  assert.equal(result.length, expected.length);
  assert.equal(result, expected);
});
