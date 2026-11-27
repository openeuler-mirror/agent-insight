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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { buildTraceLatencyRepair } = require('../scripts/prepare-npm-package.js');

test('packaged latency repair runs with plain Node without source files or tsx', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-latency-package-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const outfile = path.join(dir, 'repair.cjs');
    buildTraceLatencyRepair(process.cwd(), outfile);
    const env: NodeJS.ProcessEnv = { ...process.env, AGENT_INSIGHT_HOME: dir, DB_HOST: 'unsupported-test-db', NODE_PATH: path.resolve('node_modules') };
    delete env.AGENT_INSIGHT_DATA_DIR;
    const result = spawnSync(process.execPath, [outfile], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /supports SQLite deployments only/);
    assert.doesNotMatch(result.stderr, /Cannot find|MODULE_NOT_FOUND|Unknown file extension/);
});
