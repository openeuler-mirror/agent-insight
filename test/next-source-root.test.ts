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
import path from 'node:path';
import test from 'node:test';

function sourceBuildConfig(cwd: string, sourceDir = ''): { root?: string; excludes: string[] } {
  const configPath = path.resolve('next.config.ts');
  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', `
    process.cwd = () => ${JSON.stringify(cwd)};
    const config = require(${JSON.stringify(configPath)}).default;
    console.log('ROOT=' + JSON.stringify({ root: config.turbopack?.root, excludes: config.outputFileTracingExcludes?.['*'] || [] }));
  `], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_INSIGHT_SOURCE_DIR: sourceDir },
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = result.stdout.split('\n').find((line) => line.startsWith('ROOT='));
  assert.ok(output, result.stdout);
  return JSON.parse(output.slice(5));
}

const posixOnly = { skip: process.platform === 'win32' };

test('Docker source build can resolve both source files and image dependencies', posixOnly, () => {
  const { root } = sourceBuildConfig('/app/source', '/src');
  assert.ok(root, 'Docker source builds must include the image dependency directory');
  for (const file of ['/app/source/app/page.tsx', '/app/node_modules/next/package.json']) {
    const relative = path.relative(root, file);
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), `${file} escapes ${root}`);
  }
});

test('Docker source root is independent of the source mount name', posixOnly, () => {
  assert.equal(sourceBuildConfig('/app/source', '/releases/current').root, '/app');
});

test('Docker source builds exclude the absolute dependency alias from standalone copying', posixOnly, () => {
  const { excludes } = sourceBuildConfig('/app/source', '/src');
  assert.ok(excludes.includes('node_modules'));
  assert.ok(excludes.includes('node_modules/**'));
  assert.ok(excludes.includes('data/**'), 'existing exclusions must remain in effect');
});

test('package mode and ordinary local builds retain automatic root detection', () => {
  for (const [cwd, sourceDir] of [['/app/source', ''], ['/app/node_modules/agent-insight', ''], ['/tmp/agent-insight-local', '/src']]) {
    const config = sourceBuildConfig(cwd, sourceDir);
    assert.equal(config.root, undefined);
    assert.ok(!config.excludes.includes('node_modules'));
    assert.ok(!config.excludes.includes('node_modules/**'));
  }
});

test('Claude worktrees retain their shared dependency root', () => {
  const main = path.resolve('/tmp/agent-insight');
  assert.equal(sourceBuildConfig(path.join(main, '.claude/worktrees/probe')).root, main);
});
