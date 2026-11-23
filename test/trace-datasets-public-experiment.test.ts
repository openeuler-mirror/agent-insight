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

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
const execute = promisify(execFile);

test('public comparison preserves QA variants, hides quality labels and verifies source hashes', { timeout: 90000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trace-public-comparison-'));
  const data = path.join(root, 'data');
  await mkdir(path.join(data, 'Fixture'), { recursive: true });
  const rows = Array.from({ length: 160 }, (_, i) => ({ input: `Explain item ${i % 120}`, reference_output: `Answer ${i}`, group: `group-${i % 120}`, rowId: String(i), quality: { quality: i % 5 } }));
  rows.push({ ...rows[0], rowId: 'duplicate', quality: { quality: 4 } });
  const save = async () => {
    const content = JSON.stringify(rows);
    await writeFile(path.join(data, 'fixture.json'), content);
    await writeFile(path.join(data, 'Fixture', 'manifest.json'), JSON.stringify({ name: 'Fixture', file: 'fixture.json', sha256: createHash('sha256').update(content).digest('hex') }));
  };
  const run = async (output: string) => {
    await execute(process.execPath, ['--import', 'tsx', 'test/helpers/trace-datasets/compare-eight-datasets.ts', data, path.join(root, output), 'Fixture'], { maxBuffer: 1024 * 1024 });
    return JSON.parse(await readFile(path.join(root, output, 'Fixture.json'), 'utf8'));
  };
  await save();
  const first = await run('first');
  const experiment = first.experiments[0];
  assert.equal(experiment.availablePairs, 160);
  assert.equal(experiment.actualInputs, 120);
  assert.equal(experiment.duplicateRows, 1);
  assert.equal(experiment.poolMetrics.quality.quality.labeled, 160);
  assert.equal(experiment.poolMetrics.quality.quality.mean, (160 * 2 + 2) / 160);
  assert.equal(experiment.trials.length, 5);
  for (const trial of experiment.trials) {
    assert.deepEqual(trial.methods.B3.selected, trial.methods.B4.selected);
    for (const method of Object.values(trial.methods) as any[]) {
      assert.equal(method.metrics.count, 100);
      assert.equal(new Set(method.selected.map((r: any) => r.key)).size, 100);
    }
  }
  rows.forEach(row => { row.quality.quality = 99; });
  await save();
  const second = await run('second');
  for (let i = 0; i < 5; i++) for (const method of ['B0', 'B1', 'B2', 'B3', 'B4']) {
    assert.deepEqual(second.experiments[0].trials[i].methods[method].selected, experiment.trials[i].methods[method].selected);
    assert.equal(second.experiments[0].trials[i].methods[method].metrics.quality.quality.mean, 99);
  }
  await writeFile(path.join(data, 'fixture.json'), '[]');
  await assert.rejects(run('mismatched'), /data SHA mismatch/);
});

test('public summary ratings accept numeric strings without turning missing values into zero', async () => {
  await execute('python3', ['-c', `
import ast, pathlib, math
source = ast.parse(pathlib.Path('test/helpers/trace-datasets/fetch-eight-datasets.py').read_text())
function = next(n for n in source.body if isinstance(n, ast.FunctionDef) and n.name == 'numeric_rating')
scope = {'math': math}
exec(compile(ast.Module(body=[function], type_ignores=[]), '<numeric_rating>', 'exec'), scope)
for value, expected in [('4', 4), (' 3 ', 3), (7, 7), (None, None), ('NaN', None), ('bad', None), (True, None)]:
    assert scope['numeric_rating'](value) == expected
`]);
});
