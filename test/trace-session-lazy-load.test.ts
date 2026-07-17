import assert from 'node:assert/strict';
import test from 'node:test';

import { toTraceStructureInteractions } from '@/app/api/observe/session/route';
import { buildAgentCallTree } from '@/lib/engine/observability/agent-trace';

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
