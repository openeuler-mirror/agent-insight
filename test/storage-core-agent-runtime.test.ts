import assert from 'node:assert/strict';
import test from 'node:test';
import { startIsolatedControlCore } from './helpers/isolated-control-core';
import { GET, PUT } from '@/app/api/agent-runtime/route';
import { getAgentRuntimePreference, saveAgentRuntimePreference } from '@/lib/storage/server-config';

test('runtime preferences use Core identity and cannot read or overwrite another owner', async () => {
  const core = await startIsolatedControlCore(['alice', 'bob']);
  const request = (user: string, method = 'GET', body?: unknown) => new Request('http://localhost/api/agent-runtime?user=' + user, {
    method, headers: { authorization: 'Bearer ' + core.tokens.alice, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    await core.run('alice', () => saveAgentRuntimePreference('alice', 'opencode'));
    await core.run('bob', () => saveAgentRuntimePreference('bob', 'opencode'));
    assert.equal((await GET(new Request('http://localhost/api/agent-runtime?user=alice'))).status, 401);
    assert.equal((await GET(request('bob'))).status, 403);
    const current = await GET(request('alice'));
    assert.equal(current.status, 200);
    assert.equal((await current.json()).preference.selectedId, 'opencode');
    assert.equal((await PUT(request('bob', 'PUT', { user: 'bob', runtimeId: null }))).status, 403);
    assert.equal((await PUT(request('alice', 'PUT', { user: 'alice', runtimeId: null }))).status, 200);
    assert.equal(await core.run('alice', () => getAgentRuntimePreference('alice')), null);
    assert.equal(await core.run('bob', () => getAgentRuntimePreference('bob')), 'opencode');
  } finally { await core.dispose(); }
});
