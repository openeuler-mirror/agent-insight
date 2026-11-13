import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminTraceListOwner } from '@/lib/auth/admin';

test('admin full trace list requires the authenticated admin account', () => {
    const previous = process.env.AGENT_INSIGHT_ADMIN_USERS;
    process.env.AGENT_INSIGHT_ADMIN_USERS = 'admin,operator';
    try {
        assert.equal(adminTraceListOwner('admin', 'admin'), 'admin');
        assert.equal(adminTraceListOwner('operator', 'operator'), 'operator');
        assert.equal(adminTraceListOwner('admin', 'alice'), undefined);
        assert.equal(adminTraceListOwner('alice', 'alice'), undefined);
        assert.equal(adminTraceListOwner('admin', null), undefined);
        assert.equal(adminTraceListOwner(undefined, 'admin'), undefined);
    } finally {
        if (previous === undefined) delete process.env.AGENT_INSIGHT_ADMIN_USERS;
        else process.env.AGENT_INSIGHT_ADMIN_USERS = previous;
    }
});
