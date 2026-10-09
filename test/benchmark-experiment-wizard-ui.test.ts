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
  assert.match(wizard, /已选 Case（\{selectedGeneratedCases\.length\}）/);
  assert.match(wizard, /maxHeight: 140, overflow: 'auto'/);
  assert.match(wizard, /aria-label=\{`取消选择/);
  assert.match(wizard, /checked\s+onChange=\{\(\) => \{/);
  assert.match(wizard, /next\.delete\(item\.executionId\)/);
  assert.doesNotMatch(wizard, />操作<\/th>/);
  assert.match(wizard, /selectedDataset\.benchmark\.evaluatorKey/);
  assert.match(wizard, /benchmarkEvaluatorCard\(\{/);
  assert.doesNotMatch(wizard, /values\?\.instance_id/);
  assert.doesNotMatch(wizard, /benchmark:\$\{selectedDataset\.benchmark\.adapterKey\}/);
});

test('Benchmark result UI keeps generic submissions, points, and trend contracts', () => {
  const root = process.cwd();
  const detail = fs.readFileSync(path.join(root, 'src/components/eval/ExperimentDetail.tsx'), 'utf8');
  const caseDetail = fs.readFileSync(path.join(root, 'src/components/eval/ExperimentCaseDetail.tsx'), 'utf8');
  const artifacts = fs.readFileSync(path.join(root, 'src/components/eval/BenchmarkArtifactActions.tsx'), 'utf8');
  const trend = fs.readFileSync(path.join(root, 'src/lib/engine/experiment/baseline-trend.ts'), 'utf8');

  assert.match(detail, /benchmarkCaseColumns\.map/);
  assert.match(detail, /benchmarkMetricPresentation\?\.trueLabel/);
  assert.match(caseDetail, /benchmarkPresentationText\(point\.value/);
  assert.doesNotMatch(caseDetail, /evidence\.passed|evidence\.total/);
  assert.match(artifacts, /presentBenchmarkArtifacts/);
  assert.doesNotMatch(artifacts, /report\.json|test_output\.txt|run_instance\.log/);
  assert.match(trend, /aggregateLabel/);
  assert.doesNotMatch(trend, /adapterKey === 'swe-bench'/);
});
