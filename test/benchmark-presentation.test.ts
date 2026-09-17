import assert from 'node:assert/strict';
import test from 'node:test';

import {
  benchmarkPresentationText,
  benchmarkPresentationValue,
  canPreviewBenchmarkArtifact,
  presentBenchmarkArtifacts,
  truncateBenchmarkText,
} from '@/lib/benchmark/presentation';

test('Benchmark Presentation resolves only the shared case projection paths', () => {
  const item = {
    input: 'task',
    externalCaseId: 'case-1',
    values: { repository: { name: 'demo' }, legacy_id: 'legacy' },
  };

  assert.equal(benchmarkPresentationValue(item, 'input'), 'task');
  assert.equal(benchmarkPresentationValue(item, 'externalCaseId'), 'case-1');
  assert.equal(benchmarkPresentationValue(item, 'values.repository.name'), 'demo');
  assert.equal(benchmarkPresentationValue(item, 'values.missing'), undefined);
});

test('Benchmark Presentation formats values without reading Evidence', () => {
  assert.equal(benchmarkPresentationText(true, { trueLabel: 'Passed', falseLabel: 'Failed' }), 'Passed');
  assert.equal(benchmarkPresentationText(2, { format: 'ratio', total: 3 }), '2 / 3');
  assert.equal(benchmarkPresentationText(1536, { format: 'bytes' }), '1.5 KiB');
  assert.equal(benchmarkPresentationText(42.5, { format: 'percentage' }), '42.5%');
  assert.equal(truncateBenchmarkText('abcdef', 4), 'abcd…');
});

test('Artifact presentation keeps every file and applies name before kind rules', () => {
  const artifact = (name: string, kind: string) => ({
    name,
    kind,
    mediaType: 'text/plain',
    sizeBytes: 10,
    contentUrl: `/artifacts/${name}`,
  });
  const presented = presentBenchmarkArtifacts({
    submissions: [artifact('answer.txt', 'submission')],
    evidence: [artifact('report.json', 'report'), artifact('extra.log', 'log')],
    rules: [
      { source: 'evidence', kind: 'report', label: 'Kind label', order: 30 },
      { source: 'evidence', name: 'report.json', label: 'Exact label', order: 10 },
      { source: 'submission', name: 'answer.txt', label: 'Answer', order: 20 },
    ],
  });

  assert.deepEqual(presented.map((item) => [item.label, item.artifact.name]), [
    ['Exact label', 'report.json'],
    ['Answer', 'answer.txt'],
    ['extra.log', 'extra.log'],
  ]);
  assert.equal(canPreviewBenchmarkArtifact({ ...artifact('image.bin', 'raw'), mediaType: 'image/png' }), true);
  assert.equal(canPreviewBenchmarkArtifact({ ...artifact('archive.zip', 'raw'), mediaType: 'application/zip' }), false);
});
