import assert from 'node:assert/strict';
import test from 'node:test';

import {
    USAGE_FEATURES,
    NON_TRACKED_FEATURE_KEYS,
    isValidEvent,
    isClientSubmittable,
    listEventKeys,
    listFeatureKeys,
    getFeatureLabel,
    getEventLabel,
    isTrackedFeature,
} from '@/lib/usage-analytics/catalog';
import { toDateKey, dateKeyDaysAgo, enumerateDateKeys } from '@/lib/usage-analytics/date';

// 设计文档写的是 17 个，但质量监控在当前代码里是只读页（v0.7.1 移除了结果评测），
// 没有任何可计数的主动行为，因此与 Workspace 总览一样被排除 → 实际 16 个。
test('恰好 16 个可统计功能，且 featureKey 唯一', () => {
    assert.equal(USAGE_FEATURES.length, 16);
    const keys = listFeatureKeys();
    assert.equal(new Set(keys).size, keys.length, 'featureKey 不得重复');
});

test('质量监控与 Workspace 总览都被显式排除在排行外', () => {
    for (const k of ['dashboard', 'quality']) {
        assert.ok(NON_TRACKED_FEATURE_KEYS.includes(k as never), `${k} 应在非统计名单里`);
        assert.equal(isTrackedFeature(k), false);
    }
});

test('每个纳入排行的功能至少有一个有效使用定义', () => {
    for (const f of USAGE_FEATURES) {
        assert.ok(f.uses.length > 0, `${f.key} 必须至少定义一个有效使用`);
    }
});

test('event key 全局唯一', () => {
    const keys = listEventKeys();
    assert.equal(new Set(keys).size, keys.length, 'event key 不得重复');
});

test('Workspace 总览不在功能排行中', () => {
    assert.ok(NON_TRACKED_FEATURE_KEYS.includes('dashboard'));
    assert.equal(isTrackedFeature('dashboard'), false);
    assert.ok(!listFeatureKeys().includes('dashboard'));
});

test('skillsmgr 对外统计 key 固定为 skill', () => {
    const keys = listFeatureKeys();
    assert.ok(keys.includes('skill'));
    assert.ok(!keys.includes('skillsmgr'));
});

test('事件必须属于其声明的 feature', () => {
    assert.equal(isValidEvent('skill', 'skill.download'), true);
    assert.equal(isValidEvent('trace', 'skill.download'), false, '不得把事件挂到别的功能下');
    assert.equal(isValidEvent('skill', 'skill.nonexistent'), false);
});

test('客户端不能提交 source=server 的事件', () => {
    // skill.download 是服务端事件
    assert.equal(isClientSubmittable('skill', 'skill.download'), false);
    // trace.detail.view / access.command.copy 是客户端事件
    assert.equal(isClientSubmittable('trace', 'trace.detail.view'), true);
    assert.equal(isClientSubmittable('access-install', 'access.command.copy'), true);
});

test('标签回填：未知 key 回落自身，不抛错', () => {
    assert.equal(getFeatureLabel('trace'), '链路追踪');
    assert.equal(getFeatureLabel('unknown-feature'), 'unknown-feature');
    assert.equal(getEventLabel('skill.download'), '下载 Skill 版本');
    assert.equal(getEventLabel('unknown.event'), 'unknown.event');
});

test('dateKey 使用 Asia/Shanghai 自然日', () => {
    // UTC 16:00 已是上海次日 00:00
    assert.equal(toDateKey(new Date('2026-08-03T16:00:00Z')), '2026-08-04');
    assert.equal(toDateKey(new Date('2026-08-03T15:59:59Z')), '2026-08-03');
    assert.equal(toDateKey(new Date('2026-08-03T00:00:00Z')), '2026-08-03');
});

test('range=7 含今天在内共 7 天', () => {
    const now = new Date('2026-08-03T02:00:00Z'); // 上海 10:00
    assert.equal(dateKeyDaysAgo(7, now), '2026-07-28');
    assert.equal(enumerateDateKeys('2026-07-28', '2026-08-03').length, 7);
});
