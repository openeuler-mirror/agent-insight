import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAgentCallTree, walkTree, type AgentNode } from '@/lib/engine/observability/agent-trace';
import {
    openclawExpectedSkills,
    openclawSkillMessages,
} from './fixtures/framework-skill-fixtures';
import {
    allowsSnapshotShrinkForFramework,
    computeOwnSkills,
    extractExplicitSkillsFromNode,
    extractInvokedSkillsFromSessionInteractions,
    projectAgentNodeExecution,
    resolveExecutionSubagentFilter,
} from '@/lib/storage/data-service';

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

test('trace scope: root-only remains strict when combined with a skill filter', () => {
    assert.equal(resolveExecutionSubagentFilter({ skill: 'child-skill' }), false);
    assert.equal(resolveExecutionSubagentFilter({ includeSubagents: false }), false);
    assert.equal(resolveExecutionSubagentFilter({ onlySubagents: true }), true);
    assert.equal(resolveExecutionSubagentFilter({ includeSubagents: true }), undefined);
    assert.equal(resolveExecutionSubagentFilter({ taskId: 'subagent-session' }), undefined);
    assert.equal(resolveExecutionSubagentFilter({ parentExecutionId: 'root-id' }), undefined);
});

test('binding: root 只绑自己显式调用的 skill,不含子 agent 的 skill', () => {
    const own = computeOwnSkills('opencode', nestedFixture());
    const names = own.map(s => s.name).sort();
    // root 自己调了 skill-a / skill-c;kuafu 的 skill-b 不应冒泡到 root。
    assert.deepEqual(names, ['skill-a', 'skill-c']);
    assert.ok(!names.includes('skill-b'), 'parent must NOT be bound to the sub-agent skill');
});

test('binding: LlamaIndex root ownSkills 不包含子 Agent skill', () => {
    const names = computeOwnSkills('llamaindex', nestedFixture()).map(s => s.name).sort();
    assert.deepEqual(names, ['skill-a', 'skill-c']);
    assert.ok(!names.includes('skill-b'), 'LlamaIndex parent must NOT inherit the sub-agent skill');
});

test('binding: OpenClaw ownSkills keeps its content-block extractor', () => {
    assert.deepEqual(
        computeOwnSkills('openclaw', openclawSkillMessages as any[]),
        openclawExpectedSkills,
    );
});

test('binding: Qoder scopes root skills to the root Agent and excludes Subagent skills', () => {
    const own = computeOwnSkills('qoder', nestedFixture());
    const names = own.map(skill => skill.name).sort();
    assert.deepEqual(names, ['skill-a', 'skill-c']);
    assert.ok(!names.includes('skill-b'));
});

test('snapshot shrink: only trusted server-side framework capabilities can enable Qoder replacement', () => {
    const previousJiuwen = process.env.AGENT_INSIGHT_JIUWEN_ALLOW_SHRINK;
    delete process.env.AGENT_INSIGHT_JIUWEN_ALLOW_SHRINK;
    try {
        assert.equal(allowsSnapshotShrinkForFramework('qoder'), true);
        assert.equal(allowsSnapshotShrinkForFramework('opencode'), false);
        assert.equal(allowsSnapshotShrinkForFramework('unknown-framework'), false);
        assert.equal(allowsSnapshotShrinkForFramework('jiuwen'), false);

        process.env.AGENT_INSIGHT_JIUWEN_ALLOW_SHRINK = 'true';
        assert.equal(allowsSnapshotShrinkForFramework('jiuwen'), true);
        assert.equal(allowsSnapshotShrinkForFramework('opencode'), false);
    } finally {
        if (previousJiuwen === undefined) delete process.env.AGENT_INSIGHT_JIUWEN_ALLOW_SHRINK;
        else process.env.AGENT_INSIGHT_JIUWEN_ALLOW_SHRINK = previousJiuwen;
    }
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

test('binding: Hermes skill_view follows the same per-agent ownership rule', () => {
    const interactions = [
        { role: 'user', content: 'root question', timestamp: 1 },
        {
            role: 'assistant', content: 'root loads a skill', timestamp: 2,
            tool_calls: [{
                id: 'root-skill', type: 'function', state: 'success',
                function: { name: 'skill_view', arguments: JSON.stringify({ skill: 'root-skill', version: 3 }) },
            }],
        },
        {
            role: 'assistant', content: 'spawn researcher', timestamp: 3,
            tool_calls: [{
                id: 'task', type: 'function', state: 'success',
                function: { name: 'task', arguments: JSON.stringify({ subagent_type: 'researcher' }) },
                output: '<task_metadata>\nsession_id: hermes-child\n</task_metadata>',
            }],
        },
        {
            role: 'subagent', subagent_session_id: 'hermes-child', subagent_name: 'researcher',
            content: 'child loads another skill', timestamp: 4,
            tool_calls: [{
                id: 'child-skill', type: 'function', state: 'success',
                function: { name: 'skill_view', arguments: JSON.stringify({ name: 'child-skill' }) },
            }],
        },
    ];

    assert.deepEqual(computeOwnSkills('hermes', interactions).map(s => s.name), ['root-skill']);

    const tree = buildAgentCallTree(interactions as any);
    assert.ok(tree);
    const child = subagentNode(tree!, 'hermes-child');
    assert.ok(child);
    assert.deepEqual(extractExplicitSkillsFromNode(child!).map(s => s.name), ['child-skill']);
});

test('binding: Langfuse LangGraph dispatcher extracts normalized skill tool calls', () => {
    const interactions = [
        { role: 'user', content: 'diagnose disk', timestamp: 1 },
        {
            role: 'assistant',
            content: 'load skill',
            timestamp: 2,
            tool_calls: [{
                id: 'skill',
                type: 'function',
                state: 'success',
                function: {
                    name: 'skill',
                    arguments: JSON.stringify({ name: 'server-troubleshooter', source_tool: 'follow_skill' }),
                },
            }],
        },
    ];

    assert.deepEqual(
        extractInvokedSkillsFromSessionInteractions('langfuse-langgraph', interactions),
        [{ name: 'server-troubleshooter', version: null }],
    );
});

test('subagent projection: Hermes child stores its own result, usage, model, and calls', () => {
    const interactions = [
        { role: 'user', content: 'root question', timestamp: 1 },
        {
            role: 'assistant', content: 'spawn researcher', timestamp: 2,
            tool_calls: [{
                id: 'task', type: 'function', state: 'success',
                function: { name: 'task', arguments: JSON.stringify({ subagent_type: 'researcher' }) },
                output: '<task_metadata>\nsession_id: hermes-child\n</task_metadata>',
            }],
        },
        {
            role: 'subagent', subagent_session_id: 'hermes-child', subagent_name: 'researcher',
            content: 'inspect the service', timestamp: 3,
            model: 'GLM-5.1', usage: { input: 0, output: 0, total: 0 },
        },
        {
            role: 'subagent', subagent_session_id: 'hermes-child', subagent_name: 'researcher',
            content: 'checking logs', timestamp: 4,
            model: 'GLM-5.1', usage: { input: 20, output: 8, total: 28 },
            tool_calls: [{
                id: 'terminal', type: 'function', state: 'success',
                function: { name: 'terminal', arguments: JSON.stringify({ command: 'ps aux' }) },
                output: 'service is healthy',
            }],
        },
        {
            role: 'subagent', subagent_session_id: 'hermes-child', subagent_name: 'researcher',
            content: 'child final answer', timestamp: 5,
            model: 'GLM-5.1', usage: { input: 30, output: 12, total: 42 },
        },
    ];

    const tree = buildAgentCallTree(interactions as any);
    assert.ok(tree);
    const child = subagentNode(tree!, 'hermes-child');
    assert.ok(child);

    const projection = projectAgentNodeExecution(child!, interactions);
    assert.equal(projection.query, 'inspect the service');
    assert.equal(projection.finalResult, 'child final answer');
    assert.equal(projection.model, 'GLM-5.1');
    assert.equal(projection.inputTokens, 50);
    assert.equal(projection.outputTokens, 20);
    assert.equal(projection.tokens, 70);
    assert.equal(projection.llmCallCount, 2);
    assert.equal(projection.toolCallCount, 1);
    assert.equal(projection.toolCallErrorCount, 0);
});

test('subagent projection: ignores Langfuse JSON tool-call wrappers as text', () => {
    const interactions = [
        { role: 'user', content: 'root question', timestamp: 1 },
        {
            role: 'assistant', content: 'spawn report generator', timestamp: 2,
            tool_calls: [{
                id: 'task', type: 'function', state: 'success',
                function: {
                    name: 'task',
                    arguments: JSON.stringify({
                        subagent_type: 'report-generator',
                        subagent_session_id: 'langfuse-child',
                        description: 'write the diagnostic report',
                    }),
                },
            }],
        },
        {
            role: 'subagent',
            subagent_session_id: 'langfuse-child',
            subagent_name: 'report-generator',
            content: JSON.stringify({
                role: 'assistant',
                content: '',
                tool_calls: [{ name: 'write_report', args: { content: 'report' } }],
            }),
            timestamp: 3,
            tool_calls: [{
                id: 'write', type: 'function', state: 'success',
                function: { name: 'write_report', arguments: JSON.stringify({ content: 'report' }) },
                output: 'ok',
            }],
        },
        {
            role: 'subagent',
            subagent_session_id: 'langfuse-child',
            subagent_name: 'report-generator',
            content: 'report saved',
            timestamp: 4,
        },
    ];

    const tree = buildAgentCallTree(interactions as any);
    assert.ok(tree);
    const child = subagentNode(tree!, 'langfuse-child');
    assert.ok(child);

    const projection = projectAgentNodeExecution(child!, interactions);
    assert.equal(projection.query, 'report saved');
    assert.equal(projection.finalResult, null);
    assert.equal(projection.toolCallCount, 1);
});
