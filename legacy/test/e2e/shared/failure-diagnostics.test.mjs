import test from 'node:test';
import assert from 'node:assert/strict';
import * as diagnostics from './failure-diagnostics.mjs';

test('application diagnostics classify failures without publishing log contents or credentials', () => {
  const secret = 'private-prompt-and-credential';
  const log = `[Experiment Detail Error] PrismaClientKnownRequestError: ${secret}\n` +
    `Transaction API error: Transaction already closed, code: 'P2028'\n` +
    `TypeError: Cannot read properties of null (reading 'status')\n` +
    `    at handler (/work/.next/server/chunks/123.js:45:67)\n` +
    `DATABASE_URL=file:/private/${secret}.db`;
  const result = diagnostics.applicationFailureDiagnostics(log);
  assert.deepEqual(result.prismaCodes, ['P2028']);
  assert.ok(result.errorTypes.includes('TypeError'));
  assert.equal(result.transactionClosed, true);
  assert.equal(result.experimentDetailFailures, 1);
  assert.equal(result.nullProperty, 'status');
  assert.equal(result.stackLocations[0], '.next/server/chunks/123.js:45:67');
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.deepEqual(diagnostics.applicationFailureDiagnostics('unstructured ' + secret).prismaCodes, []);
});
