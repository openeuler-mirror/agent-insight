import assert from 'node:assert/strict';
import test from 'node:test';

import { UsageQueue, __setUsageQueueForTest } from '@/lib/usage-analytics/queue';
import { InMemoryUsageStorage } from '@/lib/usage-analytics/storage';
import { recordUsageEvent, normalizeRoute } from '@/lib/usage-analytics/collector';
import { toDateKey } from '@/lib/usage-analytics/date';
import type { UsageEvent } from '@/lib/usage-analytics/types';

function ev(i: number): UsageEvent {
    const occurredAt = new Date('2026-08-03T02:00:00Z');
    return {
        eventId: `q-${i}-${Math.random()}`,
        occurredAt,
        dateKey: toDateKey(occurredAt),
        user: 'alice',
        featureKey: 'trace',
        eventKey: 'trace.export',
        source: 'server',
        route: null,
    };
}

test('队列容量硬上限：满了丢弃而不是增长', () => {
    const q = new UsageQueue(new InMemoryUsageStorage(), 3);
    assert.equal(q.enqueue(ev(1)), true);
    assert.equal(q.enqueue(ev(2)), true);
    assert.equal(q.enqueue(ev(3)), true);
    assert.equal(q.enqueue(ev(4)), false, '超出容量应返回 false');
    assert.equal(q.depth, 3, '内存不得无界增长');
    assert.equal(q.stats().dropped, 1);
});

test('flush 后 depth 归零且计入 flushed', async () => {
    const st = new InMemoryUsageStorage();
    const q = new UsageQueue(st, 100);
    q.enqueue(ev(1));
    q.enqueue(ev(2));
    await q.flush();
    assert.equal(q.depth, 0);
    assert.equal(q.stats().flushed, 2);
    assert.equal(st.events.size, 2);
});

test('落库失败：事件重入队一次，第二次失败即丢弃', async () => {
    const st = new InMemoryUsageStorage();
    const q = new UsageQueue(st, 100);
    q.enqueue(ev(1));

    st.failNext = true;
    await q.flush();
    assert.equal(q.stats().failures, 1);
    assert.equal(q.depth, 1, '首次失败应重入队');

    st.failNext = true;
    await q.flush();
    assert.equal(q.depth, 0, '第二次失败应丢弃，不得无限重试');
    assert.equal(q.stats().dropped, 1);
});

test('flush 抛错不会向调用方冒泡', async () => {
    const st = new InMemoryUsageStorage();
    const q = new UsageQueue(st, 100);
    q.enqueue(ev(1));
    st.failNext = true;
    await assert.doesNotReject(() => q.flush());
});

test('recordUsageEvent 在开关关闭时无副作用', () => {
    delete process.env.AGENT_INSIGHT_USAGE_ENABLED;
    const st = new InMemoryUsageStorage();
    const q = new UsageQueue(st, 100);
    __setUsageQueueForTest(q);

    recordUsageEvent({ user: 'alice', featureKey: 'trace', eventKey: 'trace.export' });
    assert.equal(q.depth, 0, '关闭时不得入队');
    __setUsageQueueForTest(null);
});

test('recordUsageEvent 同步返回且吞掉所有异常', () => {
    process.env.AGENT_INSIGHT_USAGE_ENABLED = '1';
    const q = new UsageQueue(new InMemoryUsageStorage(), 100);
    __setUsageQueueForTest(q);

    // 返回值必须是 undefined —— 业务调用方不应能 await 它
    const r = recordUsageEvent({ user: 'alice', featureKey: 'trace', eventKey: 'trace.export' });
    assert.equal(r, undefined);
    assert.equal(q.depth, 1);

    // 各种脏输入都不得抛错
    assert.doesNotThrow(() => recordUsageEvent({ user: null, featureKey: 'trace', eventKey: 'trace.export' }));
    assert.doesNotThrow(() => recordUsageEvent({ user: 'a', featureKey: 'x', eventKey: 'y' }));
    assert.doesNotThrow(() =>
        recordUsageEvent({ user: 'a'.repeat(500), featureKey: 'trace', eventKey: 'trace.export' })
    );

    assert.equal(q.depth, 1, '非法输入不得入队');

    delete process.env.AGENT_INSIGHT_USAGE_ENABLED;
    __setUsageQueueForTest(null);
});

test('未知 event key 与错配 feature 被拒绝', () => {
    process.env.AGENT_INSIGHT_USAGE_ENABLED = '1';
    const q = new UsageQueue(new InMemoryUsageStorage(), 100);
    __setUsageQueueForTest(q);

    recordUsageEvent({ user: 'alice', featureKey: 'trace', eventKey: 'skill.download' });
    recordUsageEvent({ user: 'alice', featureKey: 'trace', eventKey: 'nope.nope' });
    assert.equal(q.depth, 0);

    delete process.env.AGENT_INSIGHT_USAGE_ENABLED;
    __setUsageQueueForTest(null);
});

test('route 只保留 pathname，去掉 query 与 hash', () => {
    assert.equal(normalizeRoute('/api/skills/abc?apiKey=secret'), '/api/skills/abc');
    assert.equal(normalizeRoute('/trace#frag'), '/trace');
    assert.equal(normalizeRoute(null), null);
    assert.equal(normalizeRoute('/x'.repeat(500))!.length <= 200, true);
});

test('在途 flush 时 settle 能等到结束，drain 不会空转', async () => {
    const st = new InMemoryUsageStorage();
    const q = new UsageQueue(st, 10_000);

    // 模拟慢 storage：flush 在途时 flush() 会因 flushing=true 直接 return，
    // 调用方若不 settle 就轮询 depth 会陷入忙等（曾导致基准脚本 100% CPU 空转）。
    const slow = st.persistBatch.bind(st);
    st.persistBatch = async (events) => {
        await new Promise((r) => setTimeout(r, 20));
        return slow(events);
    };

    for (let i = 0; i < 300; i++) q.enqueue(ev(i));
    const inFlight = q.flush();

    await q.settle();
    await inFlight;
    await q.drain();

    assert.equal(q.depth, 0);
    assert.equal(st.events.size, 300);
});

test('进程退出钩子已注册，未 flush 的尾部事件不会随重启消失', async () => {
    process.env.AGENT_INSIGHT_USAGE_ENABLED = '1';
    __setUsageQueueForTest(null);

    const before = process.listenerCount('beforeExit');
    const { getUsageQueue } = await import('@/lib/usage-analytics/queue');
    const q = getUsageQueue();

    assert.ok(q, '开启时应创建队列');
    assert.ok(
        process.listenerCount('beforeExit') > before ||
            process.listenerCount('beforeExit') > 0,
        '必须注册 beforeExit 钩子，否则未满一个 flush 周期的事件会丢'
    );

    delete process.env.AGENT_INSIGHT_USAGE_ENABLED;
    __setUsageQueueForTest(null);
});

test('drain 尽力清空队列', async () => {
    const st = new InMemoryUsageStorage();
    const q = new UsageQueue(st, 1000);
    for (let i = 0; i < 5; i++) q.enqueue(ev(i));
    await q.drain();
    assert.equal(q.depth, 0);
    assert.equal(st.events.size, 5);
});
