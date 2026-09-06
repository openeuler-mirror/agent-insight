import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('experiment wizard refreshes executable agents while design step is visible', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/app/(main)/experiments/new/page.tsx'),
    'utf8',
  );
  assert.match(source, /const refreshAgents = useCallback/);
  assert.match(source, /step !== 1/);
  assert.match(source, /window\.setInterval\([\s\S]*?10_000/);
  assert.match(source, /window\.addEventListener\('focus', handleFocus\)/);
  assert.match(source, /window\.removeEventListener\('focus', handleFocus\)/);
  assert.match(source, /当前 Agent 已不在最新候选中，请重新选择/);
});
