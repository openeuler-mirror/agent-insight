import assert from 'node:assert/strict';
import test from 'node:test';

import { JiuwenBatchCoalescer, batchHasEndedTeamRoot } from '@/lib/ingest/otel/jiuwen/coalesce';

function makeCoalescer(intervalMs: number, now: () => number) {
    const flushes: Array<{ key: string; user?: string }> = [];
    const c = new JiuwenBatchCoalescer(async (key, user) => {
        flushes.push({ key, user });
    }, { intervalMs, now });
    return { c, flushes };
}

test('first batch of a group flushes immediately', async () => {
    let t = 0;
    const { c, flushes } = makeCoalescer(15_000, () => t);
    assert.equal(await c.offer('g1', { user: 'u1' }), 'flushed');
    assert.deepEqual(flushes, [{ key: 'g1', user: 'u1' }]);
    t += 1;
});

test('batches inside the interval coalesce into one trailing flush', async () => {
    let t = 0;
    const { c, flushes } = makeCoalescer(15_000, () => t);
    await c.offer('g1'); // 首批立即
    t = 1_000;
    assert.equal(await c.offer('g1'), 'scheduled');
    t = 2_000;
    assert.equal(await c.offer('g1'), 'coalesced');
    assert.equal(flushes.length, 1);
    assert.equal(c.pendingCount(), 1);
    // trailing 定时器触发（真实 setTimeout，等它到点——测试用短间隔重跑验证行为即可）
});

test('trailing timer fires and flushes the coalesced batches', async () => {
    let t = 0;
    const { c, flushes } = makeCoalescer(30, () => t);
    await c.offer('g1');
    t = 10; // 距上次 10ms < 30ms → 挂 trailing
    assert.equal(await c.offer('g1', { user: 'u2' }), 'scheduled');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(flushes.length, 2);
    assert.equal(flushes[1].user, 'u2');
    assert.equal(c.pendingCount(), 0);
});

test('urgent (completion-signal) batch bypasses throttling and clears the timer', async () => {
    let t = 0;
    const { c, flushes } = makeCoalescer(15_000, () => t);
    await c.offer('g1');
    t = 1_000;
    await c.offer('g1'); // scheduled
    assert.equal(c.pendingCount(), 1);
    t = 2_000;
    assert.equal(await c.offer('g1', { urgent: true }), 'flushed');
    assert.equal(flushes.length, 2);
    assert.equal(c.pendingCount(), 0); // 定时器被清掉，不会再补一发
});

test('past-interval batch flushes immediately without a timer', async () => {
    let t = 0;
    const { c, flushes } = makeCoalescer(15_000, () => t);
    await c.offer('g1');
    t = 20_000;
    assert.equal(await c.offer('g1'), 'flushed');
    assert.equal(flushes.length, 2);
});

test('intervalMs=0 disables coalescing (legacy per-batch behavior)', async () => {
    const t = 0;
    const { c, flushes } = makeCoalescer(0, () => t);
    await c.offer('g1');
    await c.offer('g1');
    await c.offer('g1');
    assert.equal(flushes.length, 3);
});

test('groups throttle independently', async () => {
    let t = 0;
    const { c, flushes } = makeCoalescer(15_000, () => t);
    await c.offer('g1');
    t = 1_000;
    await c.offer('g2'); // 另一组的首批 → 立即
    assert.equal(flushes.length, 2);
    await c.offer('g1'); // g1 在窗口内 → 挂起
    assert.equal(c.pendingCount(), 1);
});

test('flush error still advances lastFlush (no hot loop) and next offer schedules again', async () => {
    let t = 5; // 非 0 起始，避免与 lastFlushMs=0 的「从未冲洗」哨兵相撞
    let fail = true;
    const flushes: string[] = [];
    const c = new JiuwenBatchCoalescer(async (key) => {
        flushes.push(key);
        if (fail) throw new Error('boom');
    }, { intervalMs: 15_000, now: () => t });
    await assert.rejects(() => c.offer('g1'));
    fail = false;
    t = 1_000;
    assert.equal(await c.offer('g1'), 'scheduled'); // 没有因失败进入每批重试
});

test('deferred flush uses the bucket repKey, not the session group key', async () => {
    let t = 0;
    const { c, flushes } = makeCoalescer(30, () => t);
    await c.offer('sess_1', { repKey: 'traceA' });
    t = 10;
    await c.offer('sess_1', { repKey: 'traceB' });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(flushes.length, 2);
    // 两次冲洗传的都是真实桶键（组解析入口），绝不是 sess_1
    for (const f of flushes) assert.notEqual(f.key, 'sess_1');
});

test('batchHasEndedTeamRoot matches only ended team.* spans of the bucket', () => {
    const spans = [
        { traceId: 'tA', name: 'team.demo', endNs: 0 },       // 未收尾
        { traceId: 'tA', name: 'tool.task', endNs: 5 },        // 非 team root
        { traceId: 'tB', name: 'team.demo', endNs: 9 },        // 别的桶
    ];
    assert.equal(batchHasEndedTeamRoot(spans, 'tA'), false);
    assert.equal(batchHasEndedTeamRoot(spans, 'tB'), true);
    spans[0].endNs = 7;
    assert.equal(batchHasEndedTeamRoot(spans, 'tA'), true);
});
