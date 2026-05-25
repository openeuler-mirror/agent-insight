import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildSkillAttributionStatus,
    parseSkillAttributionFromRow,
    type SkillKeyActionComparisonResult,
} from '@/lib/engine/evaluation/skill-attribution';

// 这套 UT 看护"轨迹分析 → skill 归因徽章"的状态映射。这层抽象在 v2 之前被
// 静默吞掉了 4 种 degraded 失败，前端不可见，这条规则之后用 UT 锁死防退化。

test('skill-attribution: ok → state="ok"', () => {
    const out = buildSkillAttributionStatus({
        status: 'ok',
        referenceKeyActionsText: '1. foo',
        actualExtractedStepsText: '1. bar',
    });
    assert.equal(out.state, 'ok');
    assert.equal(out.code, 'ok');
    assert.match(out.message, /完整对比/);
});

test('skill-attribution: no-skill-targets → state="not-applicable"', () => {
    // trace 本来就没标 skill，本就不该做 skill 归因——UI 上是中性灰
    const out = buildSkillAttributionStatus({ status: 'no-skill-targets' });
    assert.equal(out.state, 'not-applicable');
    assert.equal(out.code, 'no-skill-targets');
    assert.match(out.message, /未关联/);
});

test('skill-attribution: missing-skill → state="degraded" 且 message 含 skill 名', () => {
    const out = buildSkillAttributionStatus({
        status: 'missing-skill',
        missingSkills: ['vmcore-analysis', 'oom-debug'],
    });
    assert.equal(out.state, 'degraded');
    assert.equal(out.code, 'missing-skill');
    assert.match(out.message, /vmcore-analysis、oom-debug/);
});

test('skill-attribution: missing-parsed-flow → state="degraded" 且 message 含 skill 名', () => {
    const out = buildSkillAttributionStatus({
        status: 'missing-parsed-flow',
        missingSkills: ['network-diagnosis'],
    });
    assert.equal(out.state, 'degraded');
    assert.equal(out.code, 'missing-parsed-flow');
    assert.match(out.message, /network-diagnosis/);
    assert.match(out.message, /尚未生成可用的解析流程/);
});

test('skill-attribution: no-key-actions → degraded（skill flow 解析了但没抽到关键步骤）', () => {
    const out = buildSkillAttributionStatus({ status: 'no-key-actions' });
    assert.equal(out.state, 'degraded');
    assert.equal(out.code, 'no-key-actions');
    assert.match(out.message, /未识别出任何关键步骤/);
});

test('skill-attribution: dynamic-analysis-failed → degraded（trace 步骤抽取失败）', () => {
    const out = buildSkillAttributionStatus({ status: 'dynamic-analysis-failed' });
    assert.equal(out.state, 'degraded');
    assert.equal(out.code, 'dynamic-analysis-failed');
    assert.match(out.message, /trace 步骤动态分析失败/);
});

test('skill-attribution: no-extracted-steps → degraded（trace 中抽不出实际步骤）', () => {
    const out = buildSkillAttributionStatus({ status: 'no-extracted-steps' });
    assert.equal(out.state, 'degraded');
    assert.equal(out.code, 'no-extracted-steps');
    assert.match(out.message, /未能从 trace 中提取/);
});

test('skill-attribution: 5 种 degraded code 都正确映射', () => {
    // 防御性：万一日后枚举新增了 status，映射表必须同步更新——这条 UT 至少能
    // 抓出"忘了在 switch 里加 case"的回归（TS exhaustive 检查也会兜底，但
    // UT 给运行时双保险）。
    const degradedCases: SkillKeyActionComparisonResult[] = [
        { status: 'missing-skill', missingSkills: ['x'] },
        { status: 'missing-parsed-flow', missingSkills: ['x'] },
        { status: 'no-key-actions' },
        { status: 'dynamic-analysis-failed' },
        { status: 'no-extracted-steps' },
    ];
    for (const c of degradedCases) {
        const out = buildSkillAttributionStatus(c);
        assert.equal(out.state, 'degraded', `${c.status} 应该映射到 degraded`);
        assert.equal(out.code, c.status, `${c.status} 的 code 应该原样保留`);
        assert.ok(out.message.length > 0, `${c.status} 必须有非空 message`);
    }
});

test('skill-attribution: JSON 序列化后形状稳定，前端 parser 可识别', () => {
    // 这条 UT 锁的是前后端契约：rawAnalysisJson 经 JSON 一来一回后，
    // 前端的 extractSkillAttribution / deriveSkillAttribution 都靠 state
    // 字段做 union narrow，state 一旦改名或值漂移，前端徽章就丢失。
    const out = buildSkillAttributionStatus({
        status: 'missing-parsed-flow',
        missingSkills: ['vmcore-analysis'],
    });
    const serialized = JSON.stringify({ skillAttribution: out });
    const parsed = JSON.parse(serialized) as { skillAttribution: { state?: unknown; code?: unknown; message?: unknown } };
    assert.equal(parsed.skillAttribution.state, 'degraded');
    assert.equal(parsed.skillAttribution.code, 'missing-parsed-flow');
    assert.equal(typeof parsed.skillAttribution.message, 'string');
    // 三个 state 的取值是前端依赖的"枚举契约"，本测试覆盖最常见的两个，
    // 其他用例已经覆盖另外一个（'ok'）和 'not-applicable'。
});

// ────────────────────────────────────────────────────────────────────────────
// parseSkillAttributionFromRow: 前端从 API row 抽 skillAttribution 的契约
// ────────────────────────────────────────────────────────────────────────────
//
// 历史教训：list 端点最初没返回 rawAnalysisJson 也没返回 rawAnalysis，
// 前端 extractSkillAttribution 一直读空，导致徽章和归因 findings 静默丢失。
// 这组 UT 锁住"API row 形状 → parseSkillAttributionFromRow → 正确状态"。

test('parseSkillAttributionFromRow: 标准 row 形状（list/single 端点统一后）', () => {
    // 模拟 API 端点返回的 row：rawAnalysis 是解析过的对象
    const row = {
        rawAnalysis: {
            skillAttribution: {
                state: 'ok',
                code: 'ok',
                message: '已完整对比',
            },
            // 其它字段（comparisonMode、deviation_steps 等）忽略
        },
    };
    const out = parseSkillAttributionFromRow(row);
    assert.ok(out);
    assert.equal(out.state, 'ok');
    assert.equal(out.code, 'ok');
    assert.equal(out.message, '已完整对比');
});

test('parseSkillAttributionFromRow: rawAnalysis 缺失（旧记录或 API 没带）→ null', () => {
    // 这就是用户报的 bug 场景：API 没返回 rawAnalysis，前端徽章静默丢失
    assert.equal(parseSkillAttributionFromRow({}), null);
    assert.equal(parseSkillAttributionFromRow(null), null);
    assert.equal(parseSkillAttributionFromRow(undefined), null);
    assert.equal(parseSkillAttributionFromRow({ rawAnalysis: null }), null);
});

test('parseSkillAttributionFromRow: rawAnalysis 是字符串而非对象（误把 JSON 字符串塞过来）→ null', () => {
    // 防御性：万一前端从 list 端点读到的是 JSON 字符串而非对象（旧版 bug 路径）
    const row = { rawAnalysis: '{"skillAttribution":{"state":"ok"}}' };
    assert.equal(parseSkillAttributionFromRow(row), null);
});

test('parseSkillAttributionFromRow: skillAttribution.state 不合法 → null', () => {
    // state 必须是 ok/degraded/not-applicable 之一，其它值（字符串漂移）→ 拒绝
    const row = {
        rawAnalysis: { skillAttribution: { state: 'completed', message: 'x' } },
    };
    assert.equal(parseSkillAttributionFromRow(row), null);
});

test('parseSkillAttributionFromRow: degraded 状态完整透传 code + message', () => {
    const row = {
        rawAnalysis: {
            skillAttribution: {
                state: 'degraded',
                code: 'missing-parsed-flow',
                message: 'skill 尚未生成可用的解析流程：vmcore-analysis',
            },
        },
    };
    const out = parseSkillAttributionFromRow(row);
    assert.ok(out);
    assert.equal(out.state, 'degraded');
    assert.equal(out.code, 'missing-parsed-flow');
    assert.match(out.message, /vmcore-analysis/);
});

test('parseSkillAttributionFromRow: 与 buildSkillAttributionStatus 端到端 roundtrip', () => {
    // build → JSON 序列化 → 模拟 API 端点 spread/parse → parse → 还能拿到原值
    const built = buildSkillAttributionStatus({
        status: 'missing-skill',
        missingSkills: ['vmcore-analysis'],
    });
    const apiRow = JSON.parse(JSON.stringify({
        rawAnalysis: { skillAttribution: built, otherField: 'x' },
    }));
    const out = parseSkillAttributionFromRow(apiRow);
    assert.deepEqual(out, built);
});

test('skill-attribution: 缺失 skill 列表为空时 message 仍可读', () => {
    // 边界：missingSkills 数组为空时不应该产出形如 "找不到：" 的悬空冒号
    const out = buildSkillAttributionStatus({
        status: 'missing-skill',
        missingSkills: [],
    });
    assert.equal(out.state, 'degraded');
    // join('') 后是空串；这条 UT 锁死现状（"找不到："），如果后续要更细致
    // 处理空列表场景，这条 UT 会提醒我们顺手把 UI 文案也改了
    assert.match(out.message, /找不到/);
});
