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
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('subagent type facets count owned child executions while other facets retain root scope', async context => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-facet-'));
    const saved = { ...process.env };
    delete process.env.DB_HOST;
    delete process.env.AGENT_INSIGHT_DATA_DIR;
    process.env.AGENT_INSIGHT_HOME = dir;
    process.env.DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
    fs.writeFileSync(path.join(dir, 'test.db'), '');
    execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { stdio: 'pipe' });
    const { prismaRaw } = await import('../src/lib/storage/prisma');
    const { listObservedFieldValues } = await import('../src/lib/storage/data-service');
    context.after(async () => {
        await prismaRaw.$disconnect();
        for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
        Object.assign(process.env, saved); fs.rmSync(dir, { recursive: true, force: true });
    });
    for (const data of [
        { id: 'root', user: 'owner', isSubagent: false, agentName: 'main', subagentType: 'root-invalid' },
        { id: 'child1', user: 'owner', isSubagent: true, agentName: 'worker', subagentType: 'general' },
        { id: 'child2', user: 'owner', isSubagent: true, agentName: 'worker', subagentType: 'general' },
        { id: 'child3', user: 'owner', isSubagent: true, subagentType: 'explore' },
        { id: 'unknown', user: 'owner', isSubagent: true, subagentType: null },
        { id: 'private', user: 'other', isSubagent: true, subagentType: 'private' },
    ]) await prismaRaw.execution.create({ data });
    assert.deepEqual(await listObservedFieldValues('subagentType', 'owner'), [{ value: 'general', count: 2 }, { value: 'explore', count: 1 }]);
    assert.deepEqual(await listObservedFieldValues('subagentType', 'empty'), []);
    assert.deepEqual(await listObservedFieldValues('agentName', 'owner'), [{ value: 'main', count: 1 }]);
    assert.deepEqual(await listObservedFieldValues('notAColumn', 'owner'), []);
});
