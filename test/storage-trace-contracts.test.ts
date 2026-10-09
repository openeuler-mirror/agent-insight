import assert from 'node:assert/strict';
import test from 'node:test';
import { createIsolatedDatabase } from './helpers/isolated-database';

const database = createIsolatedDatabase();
const { readRecords, saveExecutionRecord } = require('@/lib/storage/data-service') as typeof import('@/lib/storage/data-service');
const { prismaRaw } = require('@/lib/storage/prisma') as typeof import('@/lib/storage/prisma');
test.after(async () => { await prismaRaw.$disconnect(); database.dispose(); });

test('Skill filtering preserves the selected Trace hierarchy in database queries', async () => {
    const user = 'scope-contract';
    for (const [id, isSubagent] of [['scope-root', false], ['scope-child', true]] as const) {
        await prismaRaw.execution.create({ data: {
            id, taskId: id, framework: 'opencode', user, isSubagent,
            parentExecutionId: isSubagent ? 'scope-root' : null,
            executionSkills: { create: { skillName: 'shared-skill', user } },
        } });
    }
    const ids = async (filters: Parameters<typeof readRecords>[1]) => (
        await readRecords(user, filters, { lightweight: true })
    ).map(record => record.task_id).sort();
    assert.deepEqual(await ids({ skill: 'shared-skill' }), ['scope-root']);
    assert.deepEqual(await ids({ skill: 'shared-skill', includeSubagents: true }), ['scope-child', 'scope-root']);
    assert.deepEqual(await ids({ skill: 'shared-skill', onlySubagents: true }), ['scope-child']);
    assert.deepEqual(await ids({ skill: 'shared-skill', parentExecutionId: 'scope-root' }), ['scope-child']);
    assert.deepEqual(await ids({ skill: 'shared-skill', taskIds: ['scope-child'] }), ['scope-child']);
});

for (const framework of ['opencode', 'qoder', 'codex', 'pi-agent', 'mcts-xgovernor']) {
    test(`${framework} snapshot replacement obeys server capabilities`, async () => {
        const taskId = `snapshot-contract-${framework}`;
        const interactions = [
            { role: 'user', content: 'question' },
            { role: 'assistant', content: 'earlier detail', usage: { total: 100 } },
            { role: 'assistant', content: 'final response', usage: { total: 200 } },
        ];
        const record = {
            upload_id: taskId, task_id: taskId, framework, user: 'snapshot-contract',
            session_merge_strategy: 'snapshot-replace', skip_evaluation: true,
        };
        await saveExecutionRecord({ ...record, interactions, tokens: 300 });
        const smaller = [interactions[0], interactions[2]];
        await saveExecutionRecord({ ...record, interactions: smaller, tokens: 200, complete_session_snapshot: framework === 'opencode' });
        const session = await prismaRaw.session.findUniqueOrThrow({ where: { taskId } });
        assert.deepEqual(JSON.parse(session.interactions || '[]'), framework === 'opencode' ? interactions : smaller);
        const execution = await prismaRaw.execution.findUniqueOrThrow({ where: { id: taskId } });
        assert.equal(Number(execution.tokens), framework === 'opencode' ? 300 : 200);
    });
}
