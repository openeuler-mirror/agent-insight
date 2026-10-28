/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { listBenchmarkAdapters } from '@/lib/benchmark/adapter-registry';
import {
  benchmarkEvaluatorCard,
  benchmarkEvaluatorCardsFromManifests,
} from '@/lib/evaluators/benchmark-evaluator-cards';

import {
  benchmarkPresentationText,
  benchmarkPresentationValue,
  benchmarkArtifactTree,
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

test('evidence tree retains root files and groups nested files without merging equal basenames', () => {
  const names = ['evaluation.json', 'judge-evidence/vuln/result.json', 'judge-evidence/fix/result.json', 'public-feedback/generator.json', 'official-output.zip'];
  const items = presentBenchmarkArtifacts({ submissions: [], evidence: names.map(name => ({ name, kind: 'test-output', mediaType: 'application/json', sizeBytes: 0, contentUrl: '/artifact' })) });
  const tree = benchmarkArtifactTree(items);
  assert.deepEqual(tree.map(node => node.name), ['evaluation.json', 'judge-evidence', 'public-feedback', 'official-output.zip']);
  assert.deepEqual(tree[1].children?.map(node => node.name), ['vuln', 'fix']);
  assert.equal(tree[1].children?.[0].children?.[0].item?.artifact.name, names[1]);
  assert.equal(tree[1].children?.[1].children?.[0].item?.artifact.name, names[2]);
  const flat = benchmarkArtifactTree(items.slice(0, 1));
  assert.equal(flat[0].item?.artifact.name, 'evaluation.json');
});

test('Benchmark evaluator catalog projects public card data from installed packages', () => {
  const [manifest] = listBenchmarkAdapters();
  const [card] = benchmarkEvaluatorCardsFromManifests([manifest]);
  assert.equal(card.id, `benchmark:${manifest.evaluation.evaluatorKey}`);
  assert.equal(card.name, manifest.presentation?.evaluator?.displayName);
  assert.equal(card.outputDescription, manifest.presentation?.evaluator?.outputDescription);
  assert.deepEqual(card.targetTypes, ['Benchmark']);
  assert.deepEqual(card.scenarios, [manifest.displayName]);
  assert.equal('schemas' in card, false);
  assert.equal('evaluation' in card, false);
  assert.deepEqual(card, benchmarkEvaluatorCard({
    evaluatorKey: manifest.evaluation.evaluatorKey,
    benchmarkName: manifest.displayName,
    presentation: manifest.presentation,
  }));

  const another = {
    ...manifest,
    adapterKey: 'another-benchmark',
    displayName: 'Another Benchmark',
    evaluation: { ...manifest.evaluation, evaluatorKey: 'another-evaluator' },
  };
  assert.deepEqual(
    benchmarkEvaluatorCardsFromManifests([manifest, another]).map((item) => item.id),
    [card.id, 'benchmark:another-evaluator'],
  );
  assert.throws(() => benchmarkEvaluatorCardsFromManifests([manifest, manifest]), /evaluatorKey 重复/);
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
