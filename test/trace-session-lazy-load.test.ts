import assert from 'node:assert/strict';
import test from 'node:test';

import { toTraceStructureInteractions, withTracePayloadVersions } from '@/app/api/observe/session/route';
import { buildAgentCallTree, type RawInteraction } from '@/lib/engine/observability/agent-trace';
import { composeCollaborationTrace } from '@/lib/ingest/collaboration/trace-projection';
import {
    extractSkillsWithVersionsFromHermesSession,
    normalizeInteractions,
} from '@/lib/shared/interaction-utils';

test('payload versions survive structure projection and change when same-index content or worker identity changes', () => {
    const first = withTracePayloadVersions([{ role: 'assistant', content: 'running', subagent_session_id: 'worker-1' }]);
    assert.equal(toTraceStructureInteractions(first)[0]._payloadVersion, first[0]._payloadVersion);
    assert.equal(withTracePayloadVersions([{ role: 'assistant', content: 'running', subagent_session_id: 'worker-1' }])[0]._payloadVersion, first[0]._payloadVersion);
    for (const next of [
        { role: 'assistant', content: 'finished', subagent_session_id: 'worker-1' },
        { role: 'assistant', content: 'running', subagent_session_id: 'worker-2' },
    ]) assert.notEqual(withTracePayloadVersions([next])[0]._payloadVersion, first[0]._payloadVersion);
});

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
    const extractSkills = (source: RawInteraction[]) => extractSkillsWithVersionsFromHermesSession(
        normalizeInteractions(source),
    );

    assert.deepEqual(extractSkills(structure), [{ name: 'hermes-agent', version: null }]);
    assert.deepEqual(extractSkills(afterSingleLoad), [{ name: 'hermes-agent', version: null }]);
});

test('lazy trace structure preserves a Goal Plus projected worker subtree and provenance', () => {
    const projection = composeCollaborationTrace(
        [{ role: 'user', agent: 'Goal Plus 主 Agent', content: '开始优化', timestamp: 1000 }],
        [{
            eventId: 'evt-worker',
            taskId: 'goal-plus:source:worker',
            executionId: 'worker-execution',
            agentName: 'Candidate Worker',
            interactions: [
                { role: 'user', content: '搜索候选', timestamp: 1100 },
                { role: 'assistant', agent: 'Candidate Worker', content: '完成', timestamp: 1200 },
            ],
            description: 'Goal Plus 编排 candidate-worker',
            sourceType: 'goal-plus-semantic',
            relationKind: 'orchestrated',
            anchorState: 'not_provided',
            role: 'candidate-worker',
        }],
    );

    const tree = buildAgentCallTree(toTraceStructureInteractions(projection.interactions));
    assert.equal(tree?.children.length, 1);
    assert.equal(tree?.children[0].sessionId, 'goal-plus:source:worker');
    assert.equal(tree?.children[0].relation?.sourceType, 'goal-plus-semantic');
    assert.equal(tree?.events.find(event => event.kind === 'task')?.relation?.anchorState, 'not_provided');
});

test('reported collaboration structure uses the same payload version as the original source interaction', () => {
    const source = { role: 'assistant', content: 'child tool result', agent: 'reviewer' };
    const projected = { ...source, _collaboration: { taskId: 'child', index: 0, version: 'source-v1', parent: 'root' } };
    const original = withTracePayloadVersions([source])[0];
    const structure = toTraceStructureInteractions(withTracePayloadVersions([projected]))[0];
    assert.equal(structure._payloadVersion, original._payloadVersion);
    assert.equal(structure._collaboration.taskId, 'child');
    assert.notEqual(withTracePayloadVersions([{ ...source, content: 'updated result' }])[0]._payloadVersion, structure._payloadVersion);
});
