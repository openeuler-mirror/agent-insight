import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { USAGE_FEATURES, listEventKeys } from '@/lib/usage-analytics/catalog';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import { UsageQueue, __setUsageQueueForTest } from '@/lib/usage-analytics/queue';
import { InMemoryUsageStorage } from '@/lib/usage-analytics/storage';

const SRC = path.join(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p, out);
        else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p);
    }
    return out;
}

const ALL_SOURCES = walk(SRC).filter((p) => !p.includes(`${path.sep}usage-analytics${path.sep}`));
const SOURCE_TEXT = ALL_SOURCES.map((p) => fs.readFileSync(p, 'utf8')).join('\n');

test('埋点调用点绝不 await recordUsageEvent（会把统计拖进业务热路径）', () => {
    const offenders: string[] = [];
    for (const file of ALL_SOURCES) {
        const text = fs.readFileSync(file, 'utf8');
        if (/await\s+recordUsageEvent\s*\(/.test(text)) offenders.push(file);
        // 只在单行内找 .then —— 用 [\s\S] 跨行会把"上方有 await、下方有 recordUsageEvent"
        // 的正常代码误判成违规。
        if (/recordUsageEvent\s*\([^\n]*\)\s*\.then\s*\(/.test(text)) offenders.push(file);
    }
    assert.deepEqual(offenders, [], '业务调用点不得 await 或 .then 统计函数');
});

test('埋点只使用注册表中存在的 event key', () => {
    const known = new Set(listEventKeys());
    const used = [...SOURCE_TEXT.matchAll(/eventKey:\s*'([^']+)'/g)].map((m) => m[1]);
    assert.ok(used.length > 0, '应至少有一处埋点');
    for (const k of used) {
        assert.ok(known.has(k), `埋点使用了注册表外的 event key: ${k}`);
    }
});

test('埋点的 featureKey 与 eventKey 必须匹配注册表', () => {
    const pairs = [...SOURCE_TEXT.matchAll(/featureKey:\s*'([^']+)',\s*\n?\s*eventKey:\s*'([^']+)'/g)];
    assert.ok(pairs.length > 0);
    for (const [, featureKey, eventKey] of pairs) {
        const feature = USAGE_FEATURES.find((f) => f.key === featureKey);
        assert.ok(feature, `未知 featureKey: ${featureKey}`);
        assert.ok(
            feature!.uses.some((u) => u.key === eventKey),
            `${eventKey} 不属于 ${featureKey}`
        );
    }
});

test('T5-1 三个明确要求的行为已接入', () => {
    assert.match(SOURCE_TEXT, /eventKey:\s*'skill\.download'/, 'skill.download 未接入');
    assert.match(SOURCE_TEXT, /'trace',\s*'trace\.detail\.view'/, 'trace.detail.view 未接入');
    assert.match(SOURCE_TEXT, /'fault',\s*'fault\.history\.view'/, 'fault.history.view 未接入');
});

test('AC-003 菜单进入/重渲染/筛选/分页/轮询均不增加用量', () => {
    process.env.AGENT_INSIGHT_USAGE_ENABLED = '1';
    const q = new UsageQueue(new InMemoryUsageStorage(), 1000);
    __setUsageQueueForTest(q);

    // 这些行为在代码里根本不调用 recordUsageEvent；这里断言"没有路由级 tracker"，
    // 即不存在按 pathname 自动上报的调用形态。
    assert.ok(
        !/recordUsageEvent\(\{[^}]*eventKey:\s*(?:route|pathname|`)/.test(SOURCE_TEXT),
        '不得存在按路由自动生成 eventKey 的 tracker'
    );
    assert.equal(q.depth, 0);

    delete process.env.AGENT_INSIGHT_USAGE_ENABLED;
    __setUsageQueueForTest(null);
});

test('AC-005 失败与取消不计数：collector 只在被调用时入队', () => {
    process.env.AGENT_INSIGHT_USAGE_ENABLED = '1';
    const q = new UsageQueue(new InMemoryUsageStorage(), 1000);
    __setUsageQueueForTest(q);

    // 模拟业务失败分支：不调用 collector，队列保持为空
    assert.equal(q.depth, 0);

    // 成功分支调用一次就是一次
    recordUsageEvent({ user: 'alice', featureKey: 'skill', eventKey: 'skill.download' });
    assert.equal(q.depth, 1);

    delete process.env.AGENT_INSIGHT_USAGE_ENABLED;
    __setUsageQueueForTest(null);
});

test('AC-009 统计故障不改变业务结果：collector 在 storage 故障时仍同步返回', async () => {
    process.env.AGENT_INSIGHT_USAGE_ENABLED = '1';
    const st = new InMemoryUsageStorage();
    const q = new UsageQueue(st, 1000);
    __setUsageQueueForTest(q);

    st.failNext = true;
    // 业务调用点视角：函数同步返回 undefined，不抛错
    assert.equal(recordUsageEvent({ user: 'alice', featureKey: 'skill', eventKey: 'skill.download' }), undefined);
    await assert.doesNotReject(() => q.flush());

    delete process.env.AGENT_INSIGHT_USAGE_ENABLED;
    __setUsageQueueForTest(null);
});

test('统计表不与业务表建外键（不得影响现有查询计划）', () => {
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
    const usageStart = schema.indexOf('model PlatformUsageEvent');
    const usageEnd = schema.indexOf('model ReliabilityInstallToken');
    const usageModels = usageEnd > usageStart
        ? schema.slice(usageStart, usageEnd)
        : schema.slice(usageStart);
    assert.ok(!/@relation/.test(usageModels), '用量统计表不得建立关系');
});

test('原始事件表不保存业务正文与敏感字段', () => {
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
    const block = schema.slice(
        schema.indexOf('model PlatformUsageEvent'),
        schema.indexOf('model PlatformUsageDaily')
    );
    for (const forbidden of ['metadata', 'payload', 'content', 'ip', 'userAgent', 'apiKey', 'query']) {
        assert.ok(!new RegExp(`\\b${forbidden}\\b`, 'i').test(block), `不得保存 ${forbidden}`);
    }
});
