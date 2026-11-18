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
import Module from 'node:module';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { createIsolatedDatabase } from './helpers/isolated-database';

test('Skills review skips missing prerequisites and preserves execution errors', async (t) => {
  const isolated = createIsolatedDatabase();
  const { db, prismaRaw } = await import('@/lib/storage/prisma');
  t.after(async () => {
    await prismaRaw.$disconnect();
    isolated.dispose();
  });
  const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
  const originalLoad = loader._load;
  const mockSdk = t.mock.method(loader, '_load', function (id: string, ...args: unknown[]) {
    if (id === '@opencode-ai/sdk') return { createOpencodeClient: () => assert.fail('No model is needed for these cases') };
    return originalLoad.call(loader, id, ...args);
  });
  const { GET, POST } = await import('@/app/api/observe/executions/[executionId]/agent-debug/skills-analysis/route');
  mockSdk.mock.restore();
  const { upsertAgentDebugSkillsAnalysis } = await import('@/lib/engine/agent-debug/report-store');
  const user = 'skills-review-user';
  const url = 'http://localhost/api/observe/skills-analysis';

  for (const scenario of [
    { executionId: 'unlinked', skill: null, skipReason: 'no-skill-targets', oldError: '当前 trace 未关联可分析的 Skill' },
    { executionId: 'unregistered', skill: 'unregistered-skill', skipReason: 'missing-skill', oldError: 'Skills Hub 中未管理该 Skill：unregistered-skill，无法读取关键动作定义。' },
    { executionId: 'lookup-error', skill: 'lookup-error', skipReason: null, oldError: null },
  ]) {
    const { executionId, skill, skipReason, oldError } = scenario;
    const params = { params: Promise.resolve({ executionId }) };
    const read = async () => (await GET(new NextRequest(url), params)).json();
    await prismaRaw.execution.create({ data: { id: executionId, taskId: executionId, user, skill, framework: 'opencode' } });
    if (!skipReason) {
      t.mock.method(db, 'findSkill', async () => { throw new Error('Skill lookup unavailable'); });
    }
    const started = await POST(new NextRequest(url, { method: 'POST', body: '{}' }), params);
    assert.equal(started.status, 202);

    let result = await read();
    for (let attempt = 0; result.row.status === 'running' && attempt < 100; attempt++) {
      await setTimeout(25);
      result = await read();
    }
    assert.equal(result.row.status, skipReason ? 'skipped' : 'failed');
    assert.equal(result.skillsAnalysis.status, result.row.status);
    assert.equal(result.skillsAnalysis.progress.events.at(-1).state, result.row.status);
    if (!skipReason) {
      assert.equal(result.skillsAnalysis.errorMessage, 'Skill lookup unavailable');
      continue;
    }
    assert.equal(result.skillsAnalysis.skipReason, skipReason);
    assert.equal(result.row.errorMessage, null);

    await upsertAgentDebugSkillsAnalysis({
      executionId,
      user,
      interactionsHash: result.row.interactionsHash,
      skillsAnalysis: { ...result.skillsAnalysis, status: 'failed', skipReason: undefined, errorMessage: oldError },
    });
    const restored = await read();
    assert.equal(restored.row.status, 'skipped');
    assert.equal(restored.row.errorMessage, null);
    assert.equal(restored.skillsAnalysis.skipReason, skipReason);
    assert.equal(restored.skillsAnalysis.progress, null);
  }
});
