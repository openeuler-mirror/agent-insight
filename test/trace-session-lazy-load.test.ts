import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { toTraceStructureInteractions } from '@/app/api/observe/session/route';
import { buildAgentCallTree } from '@/lib/engine/observability/agent-trace';
import { scopeTraceThreadEventKey } from '@/lib/storage/data-service';
import {
    extractSkillsWithVersionsFromHermesSession,
    normalizeInteractions,
} from '@/lib/shared/interaction-utils';

test('trace structure removes long payloads while preserving the call tree', () => {
    const longMessage = 'message-'.repeat(2_000);
    const interactions = [
        {
            role: 'user',
            content: longMessage,
            timestamp: 1_700_000_000_000,
            agent: 'root-agent',
        },
        {
            role: 'assistant',
            content: longMessage,
            timestamp: 1_700_000_001_000,
            agent: 'root-agent',
            tool_calls: [{
                id: 'task-1',
                function: {
                    name: 'task',
                    arguments: JSON.stringify({
                        subagent_type: 'general',
                        session_id: 'sub-session-1',
                        prompt: longMessage,
                    }),
                },
                output: JSON.stringify({
                    session_id: 'sub-session-1',
                    content: longMessage,
                }),
            }],
        },
        {
            role: 'subagent',
            content: longMessage,
            timestamp: 1_700_000_002_000,
            agent: 'general',
            subagent_name: 'general',
            subagent_session_id: 'sub-session-1',
        },
    ];

    const structure = toTraceStructureInteractions(interactions);
    const fullJson = JSON.stringify(interactions);
    const structureJson = JSON.stringify(structure);

    assert.equal(structure.length, interactions.length);
    assert.ok(structureJson.length < fullJson.length / 4);
    assert.equal(structure[0]._payloadDeferred, true);
    assert.ok(!structureJson.includes(longMessage));

    const fullTree = buildAgentCallTree(interactions);
    const structureTree = buildAgentCallTree(structure);
    assert.ok(fullTree);
    assert.ok(structureTree);
    assert.equal(structureTree.stats.taskCalls, fullTree.stats.taskCalls);
    assert.equal(structureTree.children.length, 1);
    assert.equal(structureTree.children[0].sessionId, 'sub-session-1');
    assert.equal(structureTree.children[0].agentName, 'general');
});

test('single interaction lazy load preserves top-level skill calls', () => {
    const interactions = [
        {
            role: 'user',
            content: 'Show me the skill.',
        },
        {
            role: 'assistant',
            content: '',
            requestMessages: [
                { role: 'system', content: 'You are a Hermes agent.' },
                { role: 'user', content: 'Show me the skill.' },
            ],
            tool_calls: [{
                id: 'skill-1',
                function: {
                    name: 'skill_view',
                    arguments: JSON.stringify({ skill: 'hermes-agent' }),
                },
            }],
        },
        {
            role: 'assistant',
            content: 'Final answer.',
        },
    ];

    const structure = toTraceStructureInteractions(interactions);
    const afterSingleLoad = structure.map((interaction, index) => (
        index === 1 ? interactions[index] : interaction
    ));
    const extractSkills = (source: any[]) => extractSkillsWithVersionsFromHermesSession(
        normalizeInteractions(source),
    );

    assert.deepEqual(extractSkills(structure), [{ name: 'hermes-agent', version: null }]);
    assert.deepEqual(extractSkills(afterSingleLoad), [{ name: 'hermes-agent', version: null }]);
});

test('all session API callers include the authenticated user boundary', async () => {
    const root = process.cwd();
    const [drawer, fault, skillHistory] = await Promise.all([
        fs.readFile(path.join(root, 'src/components/observe/TraceDrawer.tsx'), 'utf8'),
        fs.readFile(path.join(root, 'src/app/(main)/fault/page.tsx'), 'utf8'),
        fs.readFile(path.join(root, 'src/app/(main)/skill-history/page.tsx'), 'utf8'),
    ]);

    assert.match(drawer, /\/api\/observe\/session\?taskId=\$\{encodeURIComponent\(taskId\)\}&user=\$\{encodeURIComponent\(user\)\}/);
    assert.match(fault, /\/api\/observe\/session\?taskId=\$\{encodeURIComponent\(taskId\)\}&user=\$\{encodeURIComponent\(user\)\}/);
    assert.match(skillHistory, /<TraceDrawer[\s\S]*user=\{user\}/);
});

test('trace thread event keys are stable within a source and isolated across owners', () => {
    const alice = scopeTraceThreadEventKey('alice', 'codex', 'thread-1', 'compaction:window-2');
    assert.equal(alice, scopeTraceThreadEventKey('alice', 'codex', 'thread-1', 'compaction:window-2'));
    assert.notEqual(alice, scopeTraceThreadEventKey('bob', 'codex', 'thread-1', 'compaction:window-2'));
    assert.notEqual(alice, scopeTraceThreadEventKey('alice', 'pi-agent', 'thread-1', 'compaction:window-2'));
    assert.notEqual(alice, scopeTraceThreadEventKey('alice', 'codex', 'thread-2', 'compaction:window-2'));
});
