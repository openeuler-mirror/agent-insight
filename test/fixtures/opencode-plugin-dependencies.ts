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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';

export function writeOpenCodePluginDependencies(directory: string) {
  for (const name of ['@opencode-ai/plugin', '@opencode-ai/sdk', 'zod']) {
    const target = path.join(directory, 'node_modules', name);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js',
      ...(name === '@opencode-ai/plugin' ? { dependencies: { '@opencode-ai/sdk': '1.0.0', zod: '1.0.0' } } : {}),
    }));
    fs.writeFileSync(path.join(target, 'index.js'), `module.exports = ${JSON.stringify(name)};`);
  }
}

export function withOpenCodePluginDependencies(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-deps-test-'));
  const keys = ['HOME', 'USERPROFILE', 'AGENT_INSIGHT_USER_HOME', 'XDG_CONFIG_HOME', 'OPENCODE_CONFIG_DIR'] as const;
  const previous = keys.map(key => [key, process.env[key]] as const);
  Object.assign(process.env, { HOME: root, USERPROFILE: root, AGENT_INSIGHT_USER_HOME: root, XDG_CONFIG_HOME: path.join(root, '.config') });
  delete process.env.OPENCODE_CONFIG_DIR;
  const directory = path.join(root, '.config', 'opencode');
  writeOpenCodePluginDependencies(directory);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, directory };
}
