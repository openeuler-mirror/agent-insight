import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('Benchmark Trace generation follows public Manifest columns and search paths', () => {
  const wizard = fs.readFileSync(
    path.join(process.cwd(), 'src/components/eval/ExperimentWizard.tsx'),
    'utf8',
  );

  assert.match(wizard, />任务输入</);
  assert.match(wizard, /benchmarkPresentation\?\.caseTable\.columns/);
  assert.match(wizard, /benchmarkCaseColumns\.map/);
  assert.match(wizard, /benchmarkPresentation\?\.caseTable\.searchPaths/);
  assert.match(wizard, /benchmarkPresentationValue\(item, path\)/);
  assert.match(wizard, /aria-label=\{benchmarkPresentation\?\.caseTable\.searchPlaceholder/);
  assert.match(wizard, /replace\(\/\[\^a-z0-9\]\+\/g, ''\)/);
  assert.match(wizard, /filteredGenerationCases\.map/);
});
