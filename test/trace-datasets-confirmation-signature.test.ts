import test from 'node:test';
import assert from 'node:assert/strict';
import { signature } from '../src/lib/trace-datasets/sampling';
import { baseHashes, signatureFromBase } from '../scripts/trace-datasets/confirmation-signature';

test('confirmation signature caching exactly matches production across Unicode, short inputs and seeds', () => {
  const texts = ['', 'a', 'abcd', 'abcde', 'a'.repeat(100), 'x\r\ny\rz', '你好👨‍👩‍👧‍👦，cafe\u0301。', '𠮷😃\u0000\u2028\u2029', 'Term 1. '.repeat(600)];
  for (const seed of [0, 42, 200, 219, 0xffffffff]) for (const text of texts) assert.deepEqual(signatureFromBase(baseHashes(text), seed), signature(text, seed));
});
