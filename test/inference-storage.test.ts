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
import crypto from 'node:crypto';

test('inference IDs survive authenticated upload, SQLite storage and deferred Trace/LLM detail projection', async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inference-storage-'));
    const before = { ...process.env };
    delete process.env.DB_HOST;
    delete process.env.AGENT_INSIGHT_DATA_DIR;
    Object.assign(process.env, { AGENT_INSIGHT_HOME: home, DATABASE_URL: `file:${path.join(home, 'test.db')}` });
    fs.writeFileSync(path.join(home, 'test.db'), '');
    execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { stdio: 'pipe' });
    const { prismaRaw } = await import('@/lib/storage/prisma');
    t.after(async () => {
        await prismaRaw.$disconnect();
        for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
        Object.assign(process.env, before);
        fs.rmSync(home, { recursive: true, force: true });
    });
    const { POST } = await import('@/app/api/ingest/upload/route');
    const { GET } = await import('@/app/api/observe/session/route');
    const { inferenceAnalysisTarget } = await import('@/lib/trace/inference-analysis');
    const { buildAgentCallTree } = await import('@/lib/engine/observability/agent-trace');
    const key = 'test-inference-storage';
    await prismaRaw.user.create({ data: { username: 'inference-storage', apiKey: key } });
    const root = 'inference-storage-root';
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const now = Date.now();
    const interactions = [
        { role: 'user', content: 'fixture', timeInfo: { created: now } },
        { role: 'assistant', trace_kind: 'llm', messageID: 'answer', content: 'root result', inference_session_id: root,
          inference_request_id: 'logical-root', inference_call_ids: ids.slice(0, 2), timeInfo: { created: now, completed: now + 100 },
          inference_attempts: ids.slice(0, 2).map((id, i) => ({ request_id: 'logical-root', attempt_id: String(i), call_id: id, status_code: i ? 200 : 503, started_at: new Date(now + i).toISOString() })) },
        { role: 'subagent', trace_kind: 'llm', messageID: 'child-answer', content: 'child result', subagent_session_id: 'child', subagent_parent_session_id: root, subagent_name: 'worker', inference_session_id: 'child', inference_call_ids: [ids[2]], timeInfo: { created: now, completed: now + 100 } },
        { role: 'system', content: '', inference_session_id: root, inference_unassigned_calls: [{ call_id: ids[3], state: 'transport_error' }] },
    ];
    const uploaded = await POST(new Request('http://localhost/api/ingest/upload', { method: 'POST', headers: { 'content-type': 'application/json', 'x-witty-api-key': key }, body: JSON.stringify({ task_id: root, framework: 'opencode', interactions, timestamp: new Date(now).toISOString(), query: 'inference storage fixture' }) }));
    assert.equal(uploaded.status, 200, await uploaded.text());
    const stored = await prismaRaw.session.findUniqueOrThrow({ where: { taskId: root } });
    const storedRows = JSON.parse(stored.interactions!);
    assert.deepEqual(storedRows.find((row: any) => row.messageID === 'answer').inference_call_ids, ids.slice(0, 2));
    const detailUrl = `http://localhost/api/observe/session?taskId=${root}&source=raw&view=structure`;
    assert.equal((await GET(new Request(detailUrl))).status, 401);
    await prismaRaw.user.create({ data: { username: 'inference-storage-outsider', apiKey: 'test-inference-outsider' } });
    assert.equal((await GET(new Request(detailUrl, { headers: { 'x-witty-api-key': 'test-inference-outsider' } }))).status, 403);
    const response = await GET(new Request(detailUrl, { headers: { 'x-witty-api-key': key } }));
    assert.equal(response.status, 200);
    const detail = await response.json();
    assert.ok(detail.interactions.some((row: any) => row._payloadDeferred));
    assert.deepEqual(inferenceAnalysisTarget({ scope: 'trace', framework: 'opencode', interactions: detail.interactions }).callIds?.sort(), [...ids].sort());
    const tree = buildAgentCallTree(detail.interactions)!;
    const llms = [tree, ...tree.children].flatMap(node => node.events.filter(event => event.kind === 'llm'));
    assert.equal(llms.length, 2);
    for (const llm of llms) {
        const target = inferenceAnalysisTarget({ scope: 'llm', framework: 'opencode', interaction: llm.interaction });
        assert.deepEqual(target.callIds, llm.interaction.messageID === 'answer' ? ids.slice(0, 2) : [ids[2]]);
        assert.ok(!target.callIds?.includes(ids[3]));
    }
});
