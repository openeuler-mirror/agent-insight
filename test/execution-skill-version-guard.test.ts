import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveImmutableSkillVersion } from '@/lib/storage/data-service';

// Execution.skillVersion 是"这条 trace 当时实际加载的版本号" —— 历史事实。
// 这套用例锁死哪些写入路径被允许、哪些被拦截，回归这里挂掉就意味着上游又能静默改历史了。

test('skill-version-guard: 新插入直接放行（isUpdate=false）', () => {
    const r = resolveImmutableSkillVersion({
        isUpdate: false,
        existingSkillVersion: null,
        incomingSkillVersion: 3,
        explicitRewrite: false,
    });
    assert.deepEqual(r, { resolved: 3, blocked: false });
});

test('skill-version-guard: existing NULL → 任意值放行（首次绑定 / 懒回填）', () => {
    const r = resolveImmutableSkillVersion({
        isUpdate: true,
        existingSkillVersion: null,
        incomingSkillVersion: 4,
        explicitRewrite: false,
    });
    assert.deepEqual(r, { resolved: 4, blocked: false });
});

test('skill-version-guard: existing 3 → incoming 3 同值幂等放行', () => {
    const r = resolveImmutableSkillVersion({
        isUpdate: true,
        existingSkillVersion: 3,
        incomingSkillVersion: 3,
        explicitRewrite: false,
    });
    assert.deepEqual(r, { resolved: 3, blocked: false });
});

test('skill-version-guard: existing 3 → incoming 4 拦截（典型重传 activeVersion 漂移场景）', () => {
    const r = resolveImmutableSkillVersion({
        isUpdate: true,
        existingSkillVersion: 3,
        incomingSkillVersion: 4,
        explicitRewrite: false,
    });
    assert.deepEqual(r, { resolved: 3, blocked: true });
});

test('skill-version-guard: existing 3 → incoming null 拦截（把已绑定版本号抹空也算篡改）', () => {
    const r = resolveImmutableSkillVersion({
        isUpdate: true,
        existingSkillVersion: 3,
        incomingSkillVersion: null,
        explicitRewrite: false,
    });
    assert.deepEqual(r, { resolved: 3, blocked: true });
});

test('skill-version-guard: existing 3 → incoming 4 + explicitRewrite=true 放行（label-binding 显式重绑）', () => {
    const r = resolveImmutableSkillVersion({
        isUpdate: true,
        existingSkillVersion: 3,
        incomingSkillVersion: 4,
        explicitRewrite: true,
    });
    assert.deepEqual(r, { resolved: 4, blocked: false });
});

test('skill-version-guard: existing 3 → incoming 0 拦截（v0 是合法版本号但仍是篡改）', () => {
    const r = resolveImmutableSkillVersion({
        isUpdate: true,
        existingSkillVersion: 3,
        incomingSkillVersion: 0,
        explicitRewrite: false,
    });
    assert.deepEqual(r, { resolved: 3, blocked: true });
});
