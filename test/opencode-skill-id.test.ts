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
import { buildAgentCallTree } from '@/lib/engine/observability/agent-trace';
import { getRootSkillFromInteractions } from '@/lib/engine/observability/skill-scope';
import { getPrimaryExecutionSkillTargets } from '@/lib/engine/evaluation/key-action-trace-analysis';
import { computeOwnSkills } from '@/lib/storage/data-service';
import { toTraceStructureInteractions } from '@/lib/trace/session-payload';
import {
    extractSkillsWithVersionsFromOpencodeSession,
    extractSkillsWithVersionsFromToolInteractions,
    normalizeInteractions,
} from '@/lib/shared/interaction-utils';

function skillTrace(input: Record<string, unknown>, tool = 'skill') {
    return [
        { role: 'user', content: 'Review this code', timestamp: 1 },
        {
            role: 'assistant', content: '', timestamp: 2,
            parts: [{ type: 'tool', tool, callID: 'call-1', state: { status: 'completed', input } }],
            tool_calls: [{
                id: 'call-1', type: 'function', state: 'completed',
                function: { name: tool, arguments: JSON.stringify(input) },
                output: 'Loaded skill content',
            }],
        },
        { role: 'assistant', content: 'Review completed', timestamp: 3 },
    ];
}

for (const [label, input, expected] of [
    ['v1 name', { name: 'security-review', version: 0 }, { name: 'security-review', version: 0 }],
    ['v2 id', { id: 'security-review' }, { name: 'security-review', version: null }],
    ['v2 whitespace', { id: ' security-review ' }, { name: 'security-review', version: null }],
    ['explicit name wins over id', { name: 'security-review', id: 'other-id', version: 2 }, { name: 'security-review', version: 2 }],
] as const) {
    test(`OpenCode ${label}: ingestion, Trace initial/lazy views and fault analysis agree`, () => {
        const full = skillTrace(input);
        const structure = toTraceStructureInteractions(full);
        const lazy = structure.map((item, index) => index === 2 ? full[index] : item);
        for (const interactions of [full, structure, lazy]) {
            const normalized = normalizeInteractions(interactions);
            assert.deepEqual(extractSkillsWithVersionsFromOpencodeSession(normalized), [expected]);
            assert.deepEqual(extractSkillsWithVersionsFromToolInteractions(normalized), [expected]);
            assert.deepEqual(computeOwnSkills('opencode', interactions), [expected]);
            assert.deepEqual(getRootSkillFromInteractions(interactions), expected);
            assert.deepEqual(getPrimaryExecutionSkillTargets({ skill: null, invokedSkills: null }, interactions), [
                { skill: expected.name, version: expected.version },
            ]);
            const tree = buildAgentCallTree(interactions)!;
            assert.equal(tree.events.find(event => event.kind === 'skill')?.name, expected.name);
        }
        assert.equal(structure[1].tool_calls[0].output, undefined);
    });
}

test('OpenCode v2: root ownership excludes a child Skill and task preload', () => {
    const child = skillTrace({ id: 'child-skill' })[1];
    const interactions = [
        ...skillTrace({ id: 'root-skill' }).slice(0, 2),
        {
            role: 'assistant', timestamp: 3,
            tool_calls: [{ id: 'task-call', function: { name: 'task', arguments: JSON.stringify({
                subagent_type: 'reviewer', load_skills: ['preloaded-skill'],
            }) }, output: '<task_metadata>session_id: child-session</task_metadata>' }],
        },
        { ...child, role: 'subagent', timestamp: 4, subagent_session_id: 'child-session', subagent_name: 'reviewer' },
        { role: 'assistant', content: 'Done', timestamp: 5 },
    ];
    assert.deepEqual(computeOwnSkills('opencode', interactions), [{ name: 'root-skill', version: null }]);
    assert.deepEqual(getRootSkillFromInteractions(interactions), { name: 'root-skill', version: null });
    const childOnly = interactions.slice(2);
    assert.deepEqual(computeOwnSkills('opencode', childOnly), []);
    assert.equal(getRootSkillFromInteractions(childOnly), null);
    assert.deepEqual(getPrimaryExecutionSkillTargets({ skill: null }, childOnly), []);
});

test('OpenCode Skill identity never comes from a generic tool id, call id or tool output', () => {
    for (const interactions of [skillTrace({ id: 'security-review' }, 'read'), skillTrace({})]) {
        interactions[1].tool_calls![0].output = '<skill_content name="security-review">Skill</skill_content>';
        const normalized = normalizeInteractions(interactions);
        assert.deepEqual(extractSkillsWithVersionsFromOpencodeSession(normalized), []);
        assert.deepEqual(extractSkillsWithVersionsFromToolInteractions(normalized), []);
        assert.deepEqual(computeOwnSkills('opencode', interactions), []);
        assert.equal(getRootSkillFromInteractions(interactions), null);
    }
});

test('OpenCode id fallback preserves load_skill compatibility and rejects malformed arguments', () => {
    assert.deepEqual(computeOwnSkills('opencode', skillTrace({ id: 'security-review', version: 0 }, 'load_skill')), [
        { name: 'security-review', version: 0 },
    ]);
    const malformed = skillTrace({});
    malformed[1].tool_calls![0].function.arguments = '{invalid';
    assert.deepEqual(extractSkillsWithVersionsFromOpencodeSession(normalizeInteractions(malformed)), []);
    assert.deepEqual(computeOwnSkills('opencode', malformed), []);
    assert.equal(getRootSkillFromInteractions(malformed), null);
});
