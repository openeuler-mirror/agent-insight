import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('SWE-bench Trace generation lists public case metadata and filters by Instance ID', () => {
  const wizard = fs.readFileSync(
    path.join(process.cwd(), 'src/components/eval/ExperimentWizard.tsx'),
    'utf8',
  );

  assert.match(wizard, />任务输入</);
  assert.match(wizard, />Instance ID</);
  assert.match(wizard, />仓库</);
  assert.match(wizard, /item\.values\?\.instance_id/);
  assert.match(wizard, /item\.values\?\.repo/);
  assert.match(wizard, /aria-label="搜索 Instance ID"/);
  assert.match(wizard, /replace\(\/\[\^a-z0-9\]\+\/g, ''\)/);
  assert.match(wizard, /filteredGenerationCases\.map/);
});
