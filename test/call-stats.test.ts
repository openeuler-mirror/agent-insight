// computeCallStats 单测：多框架字段兼容 / 护栏 / 幂等 / 直方图分位估算。
// 运行：npm test（node --test）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    computeCallStats, classifyToolError, histPercentile, mergeHist, parseCallStats,
    LLM_BUCKET_EDGES, TOOL_BUCKET_EDGES, MAX_ITEMS, MAX_MODELS, MAX_TOOLS, OTHER_KEY, UNKNOWN_KEY,
} from '../src/lib/fleet/call-stats';

const T0 = 1_783_560_000_000;

test('opencode 风格：timeInfo epoch ms + tool_calls 无耗时 → llm 进桶、tool 记 unkN', () => {
    const s = computeCallStats([
        { role: 'user', content: 'q' },
        {
            role: 'assistant', modelID: 'GLM-5.1',
            timeInfo: { created: T0, completed: T0 + 1500 },
            tool_calls: [{ function: { name: 'read' }, state: 'completed' }],
        },
    ]);
    assert.equal(s.steps, 2);
    assert.equal(s.llm['GLM-5.1'].n, 1);
    assert.equal(s.llm['GLM-5.1'].sumMs, 1500);
    assert.equal(s.llm['GLM-5.1'].unkN, 0);
    // 1500ms 落在 [800,1600) 桶 = index 4（边界 100,200,400,800,1600…）
    assert.equal(s.llm['GLM-5.1'].hist[4], 1);
    assert.equal(s.tool['read'].n, 1);
    assert.equal(s.tool['read'].unkN, 1);       // opencode 工具无耗时字段
    assert.equal(s.tool['read'].errN, 0);
});

test('langfuse 风格：ISO 时间戳 + timing 工具耗时', () => {
    const s = computeCallStats([{
        role: 'assistant', model: 'qwen3-max',
        timeInfo: { created: '2026-07-03T01:33:05.368Z', completed: '2026-07-03T01:33:06.612Z' },
        tool_calls: [{
            function: { name: 'search' }, state: 'success',
            timing: { started_at: '2026-07-03T01:33:06.621Z', completed_at: '2026-07-03T01:33:06.921Z' },
        }],
    }]);
    assert.equal(s.llm['qwen3-max'].sumMs, 1244);
    assert.equal(s.tool['search'].sumMs, 300);
    assert.equal(s.tool['search'].unkN, 0);
});

test('claude 风格：toolCalls 驼峰 + duration_ms + error 分类', () => {
    const s = computeCallStats([{
        role: 'assistant',
        toolCalls: [
            { name: 'Bash', duration_ms: 80, state: 'error', error_type: 'timeout', error: 'command timed out after 120s' },
            { name: 'Bash', duration_ms: 40, state: 'success' },
        ],
    }], { fallbackModel: 'claude-sonnet-5' });
    assert.equal(s.llm['claude-sonnet-5'].n, 1);      // 无 timeInfo/latency → unkN
    assert.equal(s.llm['claude-sonnet-5'].unkN, 1);
    assert.equal(s.tool['Bash'].n, 2);
    assert.equal(s.tool['Bash'].errN, 1);
    assert.equal(s.errTypes['超时'], 1);
});

test('failures judge 类目带 judge: 前缀单独计数', () => {
    const s = computeCallStats([], {
        failures: JSON.stringify([
            { failure_type: 'Tool Error', description: 'x' },
            { failure_type: 'Reasoning Error', description: 'y' },
            { failure_type: 'Reasoning Error', description: 'z' },
        ]),
    });
    assert.equal(s.errTypes['judge:Tool Error'], 1);
    assert.equal(s.errTypes['judge:Reasoning Error'], 2);
});

test('脏时间戳（负 diff / 超 24h）计 unkN 不进直方图', () => {
    const s = computeCallStats([
        { role: 'assistant', modelID: 'm', timeInfo: { created: T0, completed: T0 - 5 } },
        { role: 'assistant', modelID: 'm', timeInfo: { created: T0, completed: T0 + 25 * 3600 * 1000 } },
    ]);
    assert.equal(s.llm['m'].n, 2);
    assert.equal(s.llm['m'].unkN, 2);
    assert.equal(s.llm['m'].hist.reduce((a: number, b: number) => a + b, 0), 0);
});

test('条数护栏：超过 MAX_ITEMS 截断并置 truncated', () => {
    const items = Array.from({ length: MAX_ITEMS + 50 }, () => ({
        role: 'assistant', modelID: 'm', timeInfo: { created: T0, completed: T0 + 100 },
    }));
    const s = computeCallStats(items);
    assert.equal(s.truncated, true);
    assert.equal(s.steps, MAX_ITEMS + 50);          // steps 记真实总数
    assert.equal(s.llm['m'].n, MAX_ITEMS);          // 统计只到护栏
});

test('键基数护栏：超出上限并入 __other', () => {
    const items = Array.from({ length: MAX_MODELS + 10 }, (_, i) => ({
        role: 'assistant', modelID: `model-${i}`, timeInfo: { created: T0, completed: T0 + 100 },
    }));
    const s = computeCallStats(items);
    assert.equal(Object.keys(s.llm).length, MAX_MODELS + 1);   // 30 个真实键 + __other
    assert.equal(s.llm[OTHER_KEY].n, 10);
    const toolItems = [{
        role: 'user',
        tool_calls: Array.from({ length: MAX_TOOLS + 5 }, (_, i) => ({ function: { name: `t${i}` }, state: 'success' })),
    }];
    const s2 = computeCallStats(toolItems);
    assert.equal(s2.tool[OTHER_KEY].n, 5);
});

test('幂等：同输入两次计算结果深等', () => {
    const items = [{
        role: 'assistant', modelID: 'm', timeInfo: { created: T0, completed: T0 + 300 },
        tool_calls: [{ function: { name: 'x' }, state: 'error', error: 'ECONNREFUSED 10.0.0.1' }],
    }];
    assert.deepEqual(computeCallStats(items), computeCallStats(items));
});

test('模型名缺失回退 fallbackModel，再缺回退 __unknown', () => {
    const item = { role: 'assistant', timeInfo: { created: T0, completed: T0 + 100 } };
    assert.ok(computeCallStats([item], { fallbackModel: 'fb' }).llm['fb']);
    assert.ok(computeCallStats([item]).llm[UNKNOWN_KEY]);
});

test('classifyToolError 规则表', () => {
    assert.equal(classifyToolError('HTTP 429 rate limit exceeded'), '限流');
    assert.equal(classifyToolError('request timed out'), '超时');
    assert.equal(classifyToolError('context length exceeded: maximum 128000 tokens'), '上下文超限');
    assert.equal(classifyToolError('EACCES: permission denied'), '权限拒绝');
    assert.equal(classifyToolError('connect ECONNREFUSED 127.0.0.1:8080'), '网络/连接');
    assert.equal(classifyToolError('command failed: exit code 2'), '命令非零退出');
    assert.equal(classifyToolError('something exotic'), '其他');
});

test('histPercentile：桶内插值估算 + 空直方图 null', () => {
    // 100 次全落在 [800,1600) 桶 → P50 ≈ 桶中点附近
    const hist = new Array(LLM_BUCKET_EDGES.length + 1).fill(0);
    hist[4] = 100;
    const p50 = histPercentile(hist, LLM_BUCKET_EDGES, 0.5)!;
    assert.ok(p50 >= 800 && p50 < 1600, `p50=${p50}`);
    assert.equal(histPercentile(new Array(hist.length).fill(0), LLM_BUCKET_EDGES, 0.5), null);
    // 合并可加性：两半直方图合并 == 整体
    const a = [...hist]; const b = new Array(hist.length).fill(0); b[6] = 300;
    mergeHist(a, b);
    assert.equal(a[4], 100); assert.equal(a[6], 300);
    const p95 = histPercentile(a, LLM_BUCKET_EDGES, 0.95)!;
    assert.ok(p95 >= 3200 && p95 < 12800, `p95=${p95}`);   // 400 次中第 380 次落在 [3200,6400) 桶
});

test('parseCallStats：null/非法/哨兵/版本不符全部拒绝', () => {
    assert.equal(parseCallStats(null), null);
    assert.equal(parseCallStats('not json'), null);
    assert.equal(parseCallStats('{"v":1,"err":true}'), null);
    assert.equal(parseCallStats('{"v":99,"steps":1,"llm":{},"tool":{}}'), null);
    const ok = JSON.stringify(computeCallStats([]));
    assert.ok(parseCallStats(ok));
});

test('工具耗时分桶用 TOOL_BUCKET_EDGES（50ms 基）', () => {
    const s = computeCallStats([{ role: 'user', tool_calls: [{ function: { name: 't' }, state: 'success', duration_ms: 30 }] }]);
    assert.equal(s.tool['t'].hist[0], 1);              // 30ms < 50ms → 第 0 桶
    assert.equal(s.tool['t'].hist.length, TOOL_BUCKET_EDGES.length + 1);
});
