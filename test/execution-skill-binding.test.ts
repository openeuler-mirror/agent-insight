import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAgentCallTree, walkTree, type AgentNode } from '@/lib/engine/observability/agent-trace';
import { computeOwnSkills, extractExplicitSkillsFromNode } from '@/lib/storage/data-service';

// 看护 ExecutionSkill 的 agent 作用域绑定口径(需求 1/2 的核心):
//   - 每一层 agent 只绑定**自己显式调用**(skill/load_skill)的 skill;
//   - 子 agent 用到的 skill 绑到子 agent 自己,不向上冒泡到父/root;
//   - 一层 agent 可绑多个 skill,版本随调用带出。
// 这层口径之前藏在"读时整段解析 + 向上聚合"里,改成写时按 node 落库后用本 UT 锁死防退化。
// (DB 写入/筛选的端到端由 scripts/dryrun_* 对真实库覆盖——本仓 node:test 下无法对 db 单例打桩。)

// 一个最小的多 Agent opencode trace:root 调 skill-a / skill-c,spawn 子 agent kuafu,kuafu 调 skill-b。
function nestedFixture(): any[] {
    return [
        { role: 'user', content: 'root question', timestamp: 1 },
        {
            role: 'assistant', content: 'root loads skill-a', timestamp: 2,
            tool_calls: [{
                id: 's_a', type: 'function', state: 'success',
                function: { name: 'skill', arguments: JSON.stringify({ name: 'skill-a', version: 1 }) },
            }],
        },
        {
            role: 'assistant', content: 'root loads skill-c (no version)', timestamp: 3,
            tool_calls: [{
                id: 's_c', type: 'function', state: 'success',
                function: { name: 'skill', arguments: JSON.stringify({ name: 'skill-c' }) },
            }],
        },
        {
            role: 'assistant', content: 'spawn kuafu', timestamp: 4,
            tool_calls: [{
                id: 't1', type: 'function', state: 'success',
                function: { name: 'task', arguments: JSON.stringify({ subagent_type: 'kuafu' }) },
                output: '<task_metadata>\nsession_id: ses_kuafu\n</task_metadata>',
            }],
        },
        {
            role: 'subagent', subagent_session_id: 'ses_kuafu', subagent_name: 'kuafu',
            content: 'kuafu loads skill-b', timestamp: 5,
            tool_calls: [{
                id: 's_b', type: 'function', state: 'success',
                function: { name: 'skill', arguments: JSON.stringify({ name: 'skill-b', version: 2 }) },
            }],
        },
        { role: 'assistant', content: 'root done', timestamp: 6 },
    ];
}

function subagentNode(tree: AgentNode, sessionId: string): AgentNode | null {
    let found: AgentNode | null = null;
    walkTree(tree, n => { if (n.depth > 0 && n.sessionId === sessionId) found = n; });
    return found;
}

test('binding: root 只绑自己显式调用的 skill,不含子 agent 的 skill', () => {
    const own = computeOwnSkills('opencode', nestedFixture());
    const names = own.map(s => s.name).sort();
    // root 自己调了 skill-a / skill-c;kuafu 的 skill-b 不应冒泡到 root。
    assert.deepEqual(names, ['skill-a', 'skill-c']);
    assert.ok(!names.includes('skill-b'), 'parent must NOT be bound to the sub-agent skill');
});

test('binding: 一层 agent 可绑多个 skill,版本随调用带出(没带版本则 null)', () => {
    const own = computeOwnSkills('opencode', nestedFixture());
    const byName = new Map(own.map(s => [s.name, s.version]));
    assert.equal(byName.get('skill-a'), 1);
    assert.equal(byName.get('skill-c'), null); // 调用未带 version → null(写入时再快照 activeVersion)
});

test('binding: 子 agent 自己绑定它用到的 skill(skill-b@2)', () => {
    const tree = buildAgentCallTree(nestedFixture() as any);
    assert.ok(tree, 'tree built');
    const kuafu = subagentNode(tree!, 'ses_kuafu');
    assert.ok(kuafu, 'kuafu sub-agent node exists');
    const own = extractExplicitSkillsFromNode(kuafu!);
    assert.deepEqual(own.map(s => s.name), ['skill-b']);
    assert.equal(own[0].version, 2);
    // 反向:子 agent 不该背上 root 的 skill-a/skill-c。
    assert.ok(!own.some(s => s.name === 'skill-a' || s.name === 'skill-c'));
});

test('binding: task(load_skills=...) 预加载不算本层显式调用(仅认 skill/load_skill)', () => {
    const interactions = [
        { role: 'user', content: 'go', timestamp: 1 },
        {
            role: 'assistant', content: 'spawn with preloaded skills', timestamp: 2,
            tool_calls: [{
                id: 't1', type: 'function', state: 'success',
                function: { name: 'task', arguments: JSON.stringify({ subagent_type: 'kuafu', load_skills: ['preloaded-skill'] }) },
                output: '<task_metadata>\nsession_id: ses_kuafu\n</task_metadata>',
            }],
        },
        { role: 'subagent', subagent_session_id: 'ses_kuafu', subagent_name: 'kuafu', content: 'child', timestamp: 3 },
    ];
    const own = computeOwnSkills('opencode', interactions);
    assert.deepEqual(own, [], 'task.load_skills must not bind to the spawning agent');
});

test('binding: claude 单 agent — 显式抽取即本层口径', () => {
    const interactions = [
        { role: 'user', content: [{ type: 'text', text: 'go' }], timestamp: 1 },
        {
            role: 'assistant', timestamp: 2,
            content: [
                { type: 'tool_use', name: 'skill', input: { skill: 'claude-skill', version: 4 } },
            ],
        },
    ];
    const own = computeOwnSkills('claude', interactions);
    assert.deepEqual(own.map(s => s.name), ['claude-skill']);
    assert.equal(own[0].version, 4);
});
