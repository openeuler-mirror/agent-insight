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
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const entrypoint = fs.readFileSync('scripts/docker-entrypoint.sh', 'utf8');
const check = entrypoint.match(/  node -e '([\s\S]*?)' "\$SOURCE_WORKDIR\/package.json"/)![1];

for (const scenario of ['matching', 'stale-next', 'missing', 'nested-stale-next', 'hidden-manifest'] as const) {
  test(`Docker source dependency check: ${scenario}`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-image-deps-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const modules = path.join(root, 'node_modules');
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    const writePackage = (folder: string, data: object) => {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify(data));
    };
    writePackage(source, { version: 'test', dependencies: { next: '16.4.3' } });
    writePackage(path.join(modules, 'agent-insight'), { version: 'image' });
    if (scenario !== 'missing') {
      writePackage(path.join(modules, 'next'), {
        version: scenario === 'stale-next' ? '16.1.4' : '16.4.3',
        ...(scenario === 'hidden-manifest' ? { exports: {} } : {}),
      });
    }
    if (scenario === 'nested-stale-next') {
      writePackage(path.join(source, 'node_modules', 'next'), { version: '16.1.4' });
    }
    const result = spawnSync(process.execPath, ['-e', check.replaceAll('/app/node_modules', modules), path.join(source, 'package.json')], { encoding: 'utf8' });
    const passes = scenario === 'matching' || scenario === 'hidden-manifest';
    assert.equal(result.status, passes ? 0 : 1, result.stderr);
    if (!passes) assert.match(result.stderr, /rebuild the image/);
    if (scenario.includes('stale')) assert.match(result.stderr, /next: expected 16\.4\.3, installed 16\.1\.4/);
  });
}
