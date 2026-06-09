import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseObservedAgents, LIGHT_EXECUTION_SELECT } from '@/lib/storage/data-service';

// 轻量返回模式(fields=light)根治 /api/observe/data 非分页路径的 next-server 堆 OOM。
// 这里锁死两块"novel/risky"逻辑:
//   1) LIGHT_EXECUTION_SELECT —— 列投影必须排除大字段 finalResult(轻量模式的核心),且含 observedAgents。
//   2) parseObservedAgents —— light 下 agents 从写入时 denormalize 的 observedAgents 列还原(不解析 interactions),
//      与 heavy 的 extractObservedAgentNames 同源,保证不丢任何 agent 名(含 opencode 'build' 等)。
// 集成层的"零 findSessions / final_result undefined / light==heavy 的 agents"行为由 tsc +
// scripts/dryrun_lightweight_verify.ts 对真实数据的端到端验证覆盖
// (本仓 node:test+tsx 下 mock.module 不可用,无法对 db 单例打桩)。

test('LIGHT_EXECUTION_SELECT 排除 finalResult、含 observedAgents、不含 evaluations 关系', () => {
    assert.equal('finalResult' in LIGHT_EXECUTION_SELECT, false, 'light 必须不读 finalResult');
    assert.equal(LIGHT_EXECUTION_SELECT.observedAgents, true, 'light 必须 select observedAgents 以还原 agents');
    assert.equal('evaluations' in LIGHT_EXECUTION_SELECT, false, 'light 不应 select 关系字段');
});

test('LIGHT_EXECUTION_SELECT 仍含前端列表/筛选需要的轻量列', () => {
    for (const col of [
        'id', 'taskId', 'query', 'framework', 'timestamp', 'agentName',
        'skill', 'skills', 'invokedSkills', 'failures', 'skillIssues',
        'tokens', 'cost', 'latency', 'rootExecutionId', 'isSubagent', 'subagentName',
    ]) {
        assert.equal(LIGHT_EXECUTION_SELECT[col], true, `select 应包含轻量列 ${col}`);
    }
});

test('parseObservedAgents: 解析 JSON 数组、过滤空白/非字符串项', () => {
    assert.deepEqual(parseObservedAgents('["skill-generator-agent","build"]'), ['skill-generator-agent', 'build']);
    // opencode 'build' 等只出现在 interactions 里的 agent 名,denormalize 后能被原样还原。
    assert.deepEqual(parseObservedAgents('["build"]'), ['build']);
    assert.deepEqual(parseObservedAgents('["a",""," ","b"]'), ['a', 'b']);
    assert.deepEqual(parseObservedAgents('[1,null,"c",true]'), ['c']);
});

test('parseObservedAgents: null/空/坏 JSON 都安全返回空数组', () => {
    assert.deepEqual(parseObservedAgents(null), []);
    assert.deepEqual(parseObservedAgents(undefined), []);
    assert.deepEqual(parseObservedAgents(''), []);
    assert.deepEqual(parseObservedAgents('not json'), []);
    assert.deepEqual(parseObservedAgents('{"not":"array"}'), []);
});
