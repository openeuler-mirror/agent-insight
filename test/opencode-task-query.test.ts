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

import { isolateTestDatabase } from './helpers/isolated-test-db';
isolateTestDatabase('opencode-task-query');
import { saveExecutionRecord, shouldRefreshStoredQueryFromInteractions } from '@/lib/storage/data-service';
import { prismaRaw } from '@/lib/storage/prisma';

test('OpenCode replaces a saved placeholder when the main user prompt arrives', async () => {
    const taskId = 'ses_late_user_prompt';
    const placeholder = `OpenCode Session ${taskId}`;
    const assistant = { role: 'assistant', content: 'Task completed' };
    const user = { role: 'user', content: 'Implement the task' };

    const saveSnapshot = async (query: string, interactions: Array<typeof user>) => {
        const result = await saveExecutionRecord({
            task_id: taskId,
            framework: 'opencode',
            user: 'opencode-task-query-test',
            query,
            interactions,
            skip_evaluation: true,
        });
        assert.equal(result.success, true);
        const execution = await prismaRaw.execution.findUnique({ where: { id: taskId }, select: { query: true } });
        const session = await prismaRaw.session.findUnique({ where: { taskId }, select: { query: true } });
        return [execution?.query, session?.query];
    };

    assert.deepEqual(await saveSnapshot(placeholder, [assistant]), [placeholder, placeholder]);
    assert.deepEqual(await saveSnapshot(user.content, [user, assistant]), [user.content, user.content]);
    assert.deepEqual(await saveSnapshot(placeholder, [assistant]), [user.content, user.content]);
});

test('OpenCode placeholder matching preserves custom titles and checks the session ID', () => {
    const taskId = 'ses_test';
    assert.equal(shouldRefreshStoredQueryFromInteractions(`OpenCode Session ${taskId}`, 'opencode', taskId), true);
    assert.equal(shouldRefreshStoredQueryFromInteractions('OpenCode Session ses_other', 'opencode', taskId), false);
    assert.equal(shouldRefreshStoredQueryFromInteractions(`OpenCode Session ${taskId} notes`, 'opencode', taskId), false);
    assert.equal(shouldRefreshStoredQueryFromInteractions(`OpenCode Session ${taskId}`, 'claudecode', taskId), false);
});
