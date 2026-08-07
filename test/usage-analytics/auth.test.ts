import assert from 'node:assert/strict';
import test from 'node:test';

import { getUsageAdminUsers, isUsageAdmin, gateUsageAdmin } from '@/lib/usage-analytics/auth';
import { isAdminUser } from '@/lib/auth/admin';

function withEnv(env: Record<string, string | undefined>, fn: () => void | Promise<void>) {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) {
        saved[k] = process.env[k];
        if (env[k] === undefined) delete process.env[k];
        else process.env[k] = env[k];
    }
    const restore = () => {
        for (const k of Object.keys(saved)) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    };
    const r = fn();
    if (r instanceof Promise) return r.finally(restore);
    restore();
}

test('未配置 AGENT_INSIGHT_ADMIN_USERS 时任何人都不是 usage admin', () => {
    withEnv({ AGENT_INSIGHT_ADMIN_USERS: undefined }, () => {
        assert.equal(getUsageAdminUsers().length, 0);
        assert.equal(isUsageAdmin('admin'), false, 'fail-closed：不得回退 admin');
        assert.equal(isUsageAdmin('alice'), false);
    });
    withEnv({ AGENT_INSIGHT_ADMIN_USERS: '   ' }, () => {
        assert.equal(isUsageAdmin('admin'), false, '空白配置同样 fail-closed');
    });
});

test('逗号分隔、空格与重复用户名被规范化', () => {
    withEnv({ AGENT_INSIGHT_ADMIN_USERS: ' alice , bob ,alice, ' }, () => {
        assert.deepEqual(getUsageAdminUsers(), ['alice', 'bob']);
        assert.equal(isUsageAdmin('alice'), true);
        assert.equal(isUsageAdmin('bob'), true);
        assert.equal(isUsageAdmin('carol'), false);
        assert.equal(isUsageAdmin(null), false);
        assert.equal(isUsageAdmin(''), false);
    });
});

test('回归：现有 isAdminUser 未配置时仍回退 admin（不得被本需求改变）', () => {
    withEnv({ AGENT_INSIGHT_ADMIN_USERS: undefined }, () => {
        assert.equal(isAdminUser('admin'), true, '模型单价等既有功能依赖此行为');
        assert.equal(isAdminUser('alice'), false);
    });
});

test('功能关闭时权限闸直接 disabled', async () => {
    await withEnv(
        { AGENT_INSIGHT_USAGE_ENABLED: undefined, AGENT_INSIGHT_ADMIN_USERS: 'alice' },
        async () => {
            const gate = await gateUsageAdmin(new Request('http://x/api/admin/usage/summary'));
            assert.equal(gate.ok, false);
            assert.equal(gate.reason, 'disabled');
        }
    );
});

test('伪造 ?user=admin 不能通过权限闸', async () => {
    await withEnv(
        { AGENT_INSIGHT_USAGE_ENABLED: '1', AGENT_INSIGHT_ADMIN_USERS: 'admin' },
        async () => {
            // 没有 API Key，只有 query 中的 user —— resolveUser(request) 不读它
            const gate = await gateUsageAdmin(new Request('http://x/api/admin/usage/summary?user=admin'));
            assert.equal(gate.ok, false);
            assert.equal(gate.reason, 'unauthenticated', '绝不能因 query user 认成 admin');
        }
    );
});
