import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('实验列表在存在非终态实验时静默轮询最新状态', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'src/app/(main)/experiments/page.tsx'),
    'utf8',
  );

  assert.match(source, /const LIST_REFRESH_MS = 5_000/);
  assert.match(source, /rows\.some\(\(row\) => row\.status === 'running' \|\| row\.status === 'draft'\)/);
  assert.match(source, /window\.setTimeout\(async \(\) => \{[\s\S]*?await load\(true\)[\s\S]*?LIST_REFRESH_MS/);
  assert.match(source, /const sequence = \+\+loadSequence\.current/);
  assert.match(source, /if \(!silent\) setLoading\(true\)/);
});
