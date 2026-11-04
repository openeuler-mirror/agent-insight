import assert from 'node:assert/strict';
import test from 'node:test';
import * as payload from '../src/lib/trace/session-payload';

import * as cache from '../src/lib/trace/session-body-cache';

test('single detail versions only its own payload and reuses it in later projections', () => {
    assert.equal(typeof payload.createTracePayloadSnapshot, 'function');
    const reads = [0, 0, 0];
    const rows = reads.map((_, index) => ({ role: 'assistant', get content() { reads[index]++; return 'reply-' + index; } }));
    const snapshot = payload.createTracePayloadSnapshot(rows);
    const selected = snapshot.interaction(2)!;
    assert.deepEqual(reads.slice(0, 2), [0, 0]);
    const used = reads[2];
    assert.equal(snapshot.interaction(2), selected);
    assert.equal(reads[2], used);
    assert.equal(snapshot.interactions()[2], selected);
    assert.equal(snapshot.interactions(), snapshot.interactions());
    assert.equal(snapshot.structure(), snapshot.structure());
    assert.equal(snapshot.structure()[2]._payloadVersion, selected._payloadVersion);
    assert.deepEqual(snapshot.structure().map(r => r._interactionIndex), [0, 1, 2]);
    assert.equal(snapshot.interaction(-1), undefined);
    assert.equal(snapshot.interaction(3), undefined);
    assert.equal(snapshot.interaction(0.5), undefined);
});

test('cached payload snapshot preserves the hash protocol, provenance and original inputs', () => {
    const rows = [{ role: 'assistant', content: 'long '.repeat(200), _collaboration: { taskId: 'child', index: 2, version: 'v1' } }];
    const original = JSON.stringify(rows);
    const snapshot = payload.createTracePayloadSnapshot(rows);
    assert.deepEqual(snapshot.interactions(), payload.withTracePayloadVersions(rows));
    assert.deepEqual(snapshot.structure(), payload.toTraceStructureInteractions(payload.withTracePayloadVersions(rows)));
    assert.equal(JSON.stringify(rows), original);
});

test('body cache reuses exact source text independently of changing session metadata', () => {
    assert.equal(typeof cache.createSessionBodyCache, 'function');
    let builds = 0;
    const bodies = cache.createSessionBodyCache((raw: string, nodes: string, framework: string) => ({ rows: JSON.parse(raw), nodes, framework, build: ++builds }));
    const first = bodies.get('one', '[{"content":"a"}]', '[]', 'opencode');
    assert.equal(bodies.get('one', '[{"content":"a"}]', '[]', 'opencode'), first);
    assert.equal(builds, 1);
    assert.notEqual(bodies.get('one', '[{"content":"b"}]', '[]', 'opencode'), first);
    assert.equal(builds, 2); // Same length and no timestamps to rely on.
    bodies.get('one', '[{"content":"b"}]', '[1]', 'opencode');
    bodies.get('one', '[{"content":"b"}]', '[1]', 'claudecode');
    bodies.get('one', '[{"content":"b"},{}]', '[1]', 'claudecode');
    assert.equal(builds, 5);
});

test('body cache bounds retention by estimated bytes, entry count and idle age', () => {
    let builds = 0; let now = 0;
    const bodies = cache.createSessionBodyCache(() => ++builds, { maxBytes: 24, maxEntries: 2, idleMs: 10, now: () => now });
    const a = bodies.get('a', 'aa', '', ''); // 8 estimated bytes
    const b = bodies.get('b', 'aa', '', '');
    assert.equal(bodies.get('a', 'aa', '', ''), a); // Touch a; b is oldest.
    bodies.get('c', 'aa', '', '');
    assert.equal(bodies.get('a', 'aa', '', ''), a);
    assert.notEqual(bodies.get('b', 'aa', '', ''), b);
    const large = bodies.get('large', 'aaaaaa', '', ''); // Evicts all other entries.
    assert.equal(bodies.get('large', 'aaaaaa', '', ''), large);
    const oversized = bodies.get('huge', 'aaaaaaa', '', '');
    assert.notEqual(bodies.get('huge', 'aaaaaaa', '', ''), oversized);
    now = 11;
    assert.notEqual(bodies.get('large', 'aaaaaa', '', ''), large);
});

test('invalid changed body propagates parsing failure and never returns a stale snapshot', () => {
    const bodies = cache.createSessionBodyCache((raw: string) => JSON.parse(raw));
    const original = bodies.get('a', '[1]', '', '');
    assert.throws(() => bodies.get('a', 'bad', '', ''), SyntaxError);
    assert.equal(bodies.get('a', '[1]', '', ''), original);
});

test('one response shares root and child reads while separate requests read fresh metadata', async () => {
    let calls = 0; let owner = 'alice';
    const load = async (id: string) => { calls++; return { id, owner }; };
    const first = cache.memoizeSessionReads(load);
    const a = first('root'); const b = first('root');
    assert.equal(a, b);
    assert.equal(calls, 1);
    assert.equal((await a).owner, 'alice');
    owner = 'bob';
    const second = cache.memoizeSessionReads(load);
    assert.equal((await second('root')).owner, 'bob');
    assert.equal(calls, 2);
    let failed = false;
    const retry = cache.memoizeSessionReads(async () => { if (!failed) { failed = true; throw Error('read failed'); } return 42; });
    await assert.rejects(retry('root'), /read failed/);
    assert.equal(await retry('root'), 42);
});
