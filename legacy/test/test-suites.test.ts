import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
test('module inventory includes every default UT once and supports listing without executing', () => {
  const result = spawnSync(process.execPath, ['scripts/test-suites.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const listing = spawnSync(process.execPath, ['scripts/test-suites.mjs', '--module', 'platform', '--list'], { cwd: root, encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  const inventory = JSON.parse(fs.readFileSync(path.join(root, 'test/suites.json'), 'utf8'));
  assert.deepEqual(listing.stdout.split(/\r?\n/).filter(Boolean), inventory.platform);
});

test('module inventory rejects missing, duplicate and stale paths', async () => {
  const { validateSuites } = await import('../scripts/test-suites.mjs');
  const files = ['test/a.test.ts', 'test/b.test.ts'];
  const valid = { observability: ['test/a.test.ts'], evaluation: ['test/b.test.ts'], skills: [], reliability: [], platform: [] };
  assert.doesNotThrow(() => validateSuites(valid, files));
  assert.throws(() => validateSuites({ ...valid, platform: ['test/a.test.ts'] }, files), /duplicate/i);
  assert.throws(() => validateSuites({ ...valid, evaluation: [] }, files), /unclassified/i);
  assert.throws(() => validateSuites({ ...valid, platform: ['test/old.test.ts'] }, files), /stale/i);
  assert.throws(() => validateSuites({ ...valid, surprise: [] }, files), /module/i);
});

test('module runner rejects unknown selections before running any tests', () => {
  const result = spawnSync(process.execPath, ['scripts/test-suites.mjs', '--module', 'typo'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown module/);
});
