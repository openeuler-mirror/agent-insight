import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTicks } from '@/components/usage/UsageTrendChart';

test('刻度总是从 0 起、递增、且覆盖最大值', () => {
    for (const max of [1, 3, 7, 42, 143, 150, 999, 1000, 12345]) {
        const ticks = buildTicks(max);
        assert.equal(ticks[0], 0, `max=${max} 应从 0 开始`);
        assert.ok(
            ticks[ticks.length - 1] >= max,
            `max=${max} 的上界 ${ticks[ticks.length - 1]} 必须 >= 最大值，否则折线会溢出画布`
        );
        for (let i = 1; i < ticks.length; i++) {
            assert.ok(ticks[i] > ticks[i - 1], `max=${max} 刻度必须严格递增：${ticks}`);
        }
    }
});

test('刻度全是整数（有效使用次数没有小数）', () => {
    for (const max of [1, 3, 7, 42, 143, 260, 999, 12345]) {
        for (const t of buildTicks(max)) {
            assert.ok(Number.isInteger(t), `max=${max} 出现非整数刻度 ${t}`);
        }
    }
});

test('上界抬到好看的整数，不是 max 本身', () => {
    // 143 → 上界 160（步长 40），而不是 143/4=35.75 这种刻度
    const t143 = buildTicks(143);
    assert.equal(t143[t143.length - 1], 160);
    assert.deepEqual(t143, [0, 40, 80, 120, 160]);

    // 恰好整除的情况保持紧凑
    assert.deepEqual(buildTicks(100), [0, 25, 50, 75, 100]);
    assert.deepEqual(buildTicks(200), [0, 50, 100, 150, 200]);
});

test('全 0 数据回落到 0..4，轴上仍有可读刻度', () => {
    assert.deepEqual(buildTicks(0), [0, 1, 2, 3, 4]);
    assert.deepEqual(buildTicks(-5), [0, 1, 2, 3, 4]);
    assert.deepEqual(buildTicks(NaN), [0, 1, 2, 3, 4]);
});

test('小数值不产生重复刻度', () => {
    for (const max of [1, 2, 3, 4]) {
        const ticks = buildTicks(max);
        assert.equal(new Set(ticks).size, ticks.length, `max=${max} 刻度重复：${ticks}`);
    }
});
