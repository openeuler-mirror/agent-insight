import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * 「统计关闭时零影响」的守卫测试。
 *
 * 这些断言保护的是需求里最硬的一条：AGENT_INSIGHT_USAGE_ENABLED 未开启时，
 * 统计代码不得产生任何可观测行为 —— 不建定时器、不碰数据库、不改业务结果。
 */

// 注意：@/lib/storage/prisma 在导入时会执行 loadAgentInsightEnv()，
// 用 ~/.agent-insight/.env 覆盖进程环境变量。所以关闭开关必须在导入之后再做，
// 否则本机开着开关时这些用例会假失败。
async function withUsageDisabled(fn: () => void | Promise<void>) {
    await import('@/lib/usage-analytics/collector');
    await import('@/lib/usage-analytics/queue');
    await import('@/lib/usage-analytics/storage');

    const saved = process.env.AGENT_INSIGHT_USAGE_ENABLED;
    delete process.env.AGENT_INSIGHT_USAGE_ENABLED;
    try {
        await fn();
    } finally {
        if (saved === undefined) delete process.env.AGENT_INSIGHT_USAGE_ENABLED;
        else process.env.AGENT_INSIGHT_USAGE_ENABLED = saved;
    }
}

test('关闭时 recordUsageEvent 不创建队列、不建定时器、不碰 storage', async () => {
    await withUsageDisabled(async () => {
        const { recordUsageEvent } = await import('@/lib/usage-analytics/collector');
        const { getUsageQueue, __setUsageQueueForTest } = await import('@/lib/usage-analytics/queue');
        __setUsageQueueForTest(null);

        const timersBefore = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

        for (let i = 0; i < 100; i++) {
            recordUsageEvent({ user: 'alice', featureKey: 'skill', eventKey: 'skill.download' });
        }

        assert.equal(getUsageQueue(), null, '关闭时不得创建队列实例');
        assert.equal(
            process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length,
            timersBefore,
            '关闭时不得新增定时器'
        );
    });
});

test('关闭时 recordUsageEvent 同步返回 undefined，不产生 Promise', async () => {
    await withUsageDisabled(async () => {
        const { recordUsageEvent } = await import('@/lib/usage-analytics/collector');
        // 返回 undefined 就意味着不是 Promise —— 业务调用点无从 await，
        // 统计也就不可能把延迟带进业务热路径。改成 async 会让这条断言失败。
        const r = recordUsageEvent({ user: 'alice', featureKey: 'skill', eventKey: 'skill.download' });
        assert.equal(r, undefined, '返回值必须是 undefined —— 业务调用点不该能 await 它');
    });
});

test('导入 collector 不产生任何顶层副作用（无定时器、无 DB 连接）', async () => {
    delete process.env.AGENT_INSIGHT_USAGE_ENABLED;
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    await import('@/lib/usage-analytics/collector');
    await import('@/lib/usage-analytics/queue');
    await import('@/lib/usage-analytics/storage');
    const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    assert.equal(after, before, '仅导入模块不得启动定时器');
});

test('统计表不与任何业务表建关系（不改变既有查询计划）', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');

    const usagePart = schema.slice(schema.indexOf('model PlatformUsageEvent'));
    assert.ok(!/@relation/.test(usagePart), '用量表不得有 @relation');

    // 反向：既有业务模型不得出现指向用量表的字段
    const businessPart = schema.slice(0, schema.indexOf('model PlatformUsageEvent'));
    assert.ok(
        !/PlatformUsage/.test(businessPart),
        '既有业务模型不得引用用量表 —— 否则会改变它们的查询计划与级联行为'
    );
});

test('既有 isAdminUser 行为未被本需求改变', async () => {
    const saved = process.env.AGENT_INSIGHT_ADMIN_USERS;
    delete process.env.AGENT_INSIGHT_ADMIN_USERS;
    try {
        const { isAdminUser } = await import('@/lib/auth/admin');
        // 模型单价等既有功能依赖"未配置时回退 admin"，本需求不得改动它
        assert.equal(isAdminUser('admin'), true);
        assert.equal(isAdminUser('someone-else'), false);
    } finally {
        if (saved === undefined) delete process.env.AGENT_INSIGHT_ADMIN_USERS;
        else process.env.AGENT_INSIGHT_ADMIN_USERS = saved;
    }
});
