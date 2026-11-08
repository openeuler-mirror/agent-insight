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
import { activateIsolatedHome } from './helpers/isolated-home';
import { aggregateJiuwenOtlpFromSpans } from '@/lib/ingest/otel/jiuwen/aggregate';
import { buildAgentCallTree } from '@/lib/engine/observability/agent-trace';

test('Jiuwen native child Agents use shared standalone Trace persistence and bidirectional navigation', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuwen-child-traces-'));
    const restore = activateIsolatedHome(directory);
    const oldHost = process.env.DB_HOST;
    delete process.env.DB_HOST;
    let disconnect = async () => {};
    t.after(async () => {
        await disconnect(); restore();
        if (oldHost !== undefined) process.env.DB_HOST = oldHost;
        fs.rmSync(directory, { recursive: true, force: true });
    });
    fs.writeFileSync(path.join(directory, 'test.db'), '');
    execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { stdio: 'pipe' });
    const { prismaRaw } = await import('@/lib/storage/prisma');
    const { saveExecutionRecord } = await import('@/lib/storage/data-service');
    const { GET: getSession } = await import('@/app/api/observe/session/route');
    const { GET: getData } = await import('@/app/api/observe/data/route');
    disconnect = () => prismaRaw.$disconnect();
    const user = 'jiuwen-child-owner';
    await prismaRaw.user.create({ data: { username: user, apiKey: 'jiuwen-child-test-key' } });
    const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/jiuwen-013y-spans.json', import.meta.url), 'utf8'));
    const record = aggregateJiuwenOtlpFromSpans(fixture.delegation, { user })!;
    const expectedTree = buildAgentCallTree(record.interactions, record.task_id)!;
    assert.equal(expectedTree.children.length, 1);
    const expectedChild = expectedTree.children[0];
    assert.equal((await saveExecutionRecord(record)).success, true);
    const root = await prismaRaw.execution.findFirstOrThrow({ where: { taskId: record.task_id, user, isSubagent: false } });
    const children = await prismaRaw.execution.findMany({ where: { parentExecutionId: root.id, user } });
    assert.equal(children.length, 1, 'native child must be persisted as an independent Execution');
    const child = children[0];
    assert.equal(child.taskId, expectedChild.sessionId);
    assert.equal(child.rootExecutionId, root.id);
    assert.equal(child.isSubagent, true);
    assert.equal(child.tokens, expectedChild.stats.totalTokens);
    assert.equal(child.llmCallCount, expectedChild.stats.llmCalls);
    const spawn = record.interactions.flatMap((item: any) => item.tool_calls ?? []).find((call: any) => call.function?.name === 'task');
    const taskArgs = JSON.parse(spawn.function.arguments);
    assert.equal(child.query, (taskArgs.task_description ?? taskArgs.description).slice(0, 500));
    assert.equal(child.finalResult, expectedChild.events.find(event => event.kind === 'llm')!.interaction.content);
    const session = await prismaRaw.session.findUniqueOrThrow({ where: { taskId: child.taskId! } });
    const childTree = buildAgentCallTree(JSON.parse(session.interactions!), child.taskId!)!;
    assert.equal(childTree.children.length, 0, 'standalone child must not contain itself as a child');
    assert.equal(childTree.stats.totalTokens, expectedChild.stats.totalTokens);
    assert.ok(session.startTime.getTime() <= session.endTime!.getTime());
    assert.equal(session.startTime.getTime(), expectedChild.startedAt);
    const headers = { 'x-witty-api-key': 'jiuwen-child-test-key' };
    const sessionRequest = (taskId: string) => getSession(new Request(`http://localhost/api/observe/session?taskId=${encodeURIComponent(taskId)}`, { headers }));
    const childResponse = await sessionRequest(child.taskId!);
    assert.equal(childResponse.status, 200);
    const childBody = await childResponse.json();
    assert.equal(childBody.parentAgent.taskId, record.task_id);
    assert.equal(childBody.parentAgent.executionId, root.id);
    const rootBody = await (await sessionRequest(record.task_id!)).json();
    assert.equal(rootBody.traceRelations[record.task_id!].children[0].taskId, child.taskId);
    const targetResponse = await getData(new Request(`http://localhost/api/observe/data?user=${user}&taskId=${encodeURIComponent(child.taskId!)}&includeEvaluations=0&skipAutoEvalReady=1`, { headers }));
    assert.equal(targetResponse.status, 200);
    assert.equal((await targetResponse.json())[0].task_id, child.taskId);
    assert.equal((await saveExecutionRecord(record)).success, true);
    assert.equal(await prismaRaw.execution.count({ where: { parentExecutionId: root.id, user } }), 1, 'replay must not duplicate child Traces');

    const legacyChildren: string[] = [];
    for (const [owner, result] of [[user, 'first private result'], ['another-owner', 'second private result']]) {
        const rootId = `legacy-${owner}`;
        const legacy = aggregateJiuwenOtlpFromSpans([
            { name: 'team.demo', spanId: 'team', attrs: { 'agentteam.team.name': 'demo', 'agentteam.session.id': rootId }, startNs: 1e9, endNs: 9e9 },
            { name: 'agent.leader.task_iteration.1', spanId: 'leader', parentSpanId: 'team', attrs: {}, startNs: 2e9, endNs: 8e9 },
            { name: 'agent.worker.task_iteration.1', spanId: 'worker', parentSpanId: 'team', attrs: {}, startNs: 3e9, endNs: 7e9 },
            { name: 'llm.call', spanId: 'reply', parentSpanId: 'worker', attrs: { 'gen_ai.completion.0.content': result }, startNs: 4e9, endNs: 5e9 },
        ].map(span => ({ ...span, traceId: rootId })), { user: owner })!;
        assert.equal((await saveExecutionRecord(legacy)).success, true);
        const legacyRoot = await prismaRaw.execution.findFirstOrThrow({ where: { taskId: rootId, user: owner } });
        const legacyChild = await prismaRaw.execution.findFirstOrThrow({ where: { parentExecutionId: legacyRoot.id } });
        legacyChildren.push(legacyChild.taskId!);
        const childSession = await prismaRaw.session.findUniqueOrThrow({ where: { taskId: legacyChild.taskId! } });
        assert.equal(childSession.user, owner);
        assert.match(childSession.interactions!, new RegExp(result));
    }
    assert.notEqual(legacyChildren[0], legacyChildren[1]);
    assert.equal((await sessionRequest(legacyChildren[0])).status, 200, 'later runs must not replace the first owner');
    assert.equal((await sessionRequest(legacyChildren[1])).status, 403, 'other owners child Traces remain private');
});
