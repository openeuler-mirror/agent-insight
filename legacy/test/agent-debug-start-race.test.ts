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
import Module from 'node:module';
import { NextRequest } from 'next/server';
import { createIsolatedDatabase } from './helpers/isolated-database';

test('GET cannot mark a starting diagnosis orphaned while its running row is being persisted', async (t) => {
  const isolated = createIsolatedDatabase();
  const { prismaRaw } = await import('@/lib/storage/prisma');
  const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
  const originalLoad = loader._load;
  loader._load = function (id, ...args) {
    if (id === '@opencode-ai/sdk') return { createOpencodeClient: () => assert.fail('This race regression must not call a model') };
    return originalLoad.call(this, id, ...args);
  };
  let route: typeof import('@/app/api/observe/executions/[executionId]/agent-debug/route');
  try { route = await import('@/app/api/observe/executions/[executionId]/agent-debug/route'); }
  finally { loader._load = originalLoad; }
  const { GET, POST } = route;
  const { hasActiveAgentDebugBackgroundJob, clearActiveAgentDebugBackgroundJob } = await import('@/lib/engine/agent-debug/background-jobs');
  const executionId = 'diagnosis-start-race';
  t.after(async () => { clearActiveAgentDebugBackgroundJob('agent-debug', executionId);await prismaRaw.$disconnect();isolated.dispose(); });
  await prismaRaw.execution.create({ data: { id: executionId, taskId: executionId, user: 'race-user', framework: 'opencode', agentName: 'build' } });
  await prismaRaw.session.create({ data: { taskId: executionId, user: 'race-user', interactions: JSON.stringify([{ role: 'assistant', content: 'completed work' }]) } });
  let signalInserted!: () => void, release!: () => void;
  const inserted = new Promise<void>(resolve => { signalInserted = resolve; });
  const paused = new Promise<void>(resolve => { release = resolve; });
  const execute = prismaRaw.$executeRawUnsafe.bind(prismaRaw);
  t.mock.method(prismaRaw, '$executeRawUnsafe', async (sql: string, ...args: unknown[]) => {
    const result = await execute(sql, ...args);
    if (sql.includes('INSERT INTO "AgentDebugReport"')) {
      signalInserted();await paused;throw new Error('controlled persistence failure');
    }
    return result;
  });
  const params = { params: Promise.resolve({ executionId }) };
  const starting = POST(new NextRequest('http://localhost/api/diagnosis', { method: 'POST', body: JSON.stringify({ user: 'race-user' }), headers: { 'content-type': 'application/json' } }), params);
  const rejected = assert.rejects(starting, /controlled persistence failure/);
  try {
    await Promise.race([inserted, new Promise((_, reject) => setTimeout(() => reject(new Error('Persistence barrier not reached')), 5000).unref())]);
    const state = await (await GET(new NextRequest('http://localhost/api/diagnosis'), params)).json();
    assert.equal(state.row.status, 'running');
    assert.equal(state.row.errorMessage, null);
  } finally { release();await rejected; }
  assert.equal(hasActiveAgentDebugBackgroundJob('agent-debug', executionId), false, 'Failed startup must release its registration');
});
