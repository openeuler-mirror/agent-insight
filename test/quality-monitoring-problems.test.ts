import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildProblemSummary, rankProblems, lowScoreProblems, clusterErrorSteps, isErrorStep,
    tableSkillIssueProblems, buildSkillDrag, applyDiagnoses, summarizeDiagnoses,
    type SkillIssueRowLite,
} from '@/lib/engine/quality-monitoring/problem-summary';
import type { TraceLite, DimScore, ProblemItem, DiagnosisLite } from '@/lib/engine/quality-monitoring/types';
import type { FaultPathStep } from '@/lib/engine/observability/fault-path';

function trace(over: Partial<TraceLite>): TraceLite {
    return { executionId: over.executionId ?? 'e', ts: over.ts ?? new Date(), ...over };
}

function step(over: Partial<FaultPathStep>): FaultPathStep {
    return { id: 'x', stepIndex: 1, name: 'tool', meta: '', kind: 'tool', status: 'ok', depth: 1, rawText: '', ...over } as FaultPathStep;
}

// FR-009：结构化错误聚类（节点×错误码×对象）。直接喂 fault-path 步骤，
// 避免依赖逐框架 interactions 形状（buildFaultPathSteps 不产 status==='error'，由内容判定）。
test('FR-009 结构化错误聚类：同主键归一簇 + 帕累托', () => {
    const perTrace = [
        { executionId: 't1', steps: [step({ kind: 'tool', name: 'ftp_log_fetch', rawOutput: 'connection timed out' })] },
        { executionId: 't2', steps: [step({ kind: 'tool', name: 'ftp_log_fetch', rawOutput: 'request timed out' })] },
        { executionId: 't3', steps: [step({ kind: 'tool', name: 'disk_query', rawOutput: 'invalid argument' })] },
    ];
    const { clusters, errorTraces, eventCount } = clusterErrorSteps(perTrace);
    assert.equal(eventCount, 3);
    assert.equal(errorTraces.size, 3);
    const timeoutCluster = clusters.find((c) => c.object === 'ftp_log_fetch');
    assert.ok(timeoutCluster && timeoutCluster.count === 2, '同 (工具调用×工具超时×ftp_log_fetch) 应归一簇、频次=2');
    assert.equal(timeoutCluster!.attribution, '工具&infra', '超时归因 → 工具&infra');
});

test('isErrorStep：容器节点不算错误、内容命中错误信号才算', () => {
    assert.equal(isErrorStep(step({ kind: 'agent', rawOutput: 'error here' })), false);
    assert.equal(isErrorStep(step({ kind: 'tool', rawOutput: 'all good' })), false);
    assert.equal(isErrorStep(step({ kind: 'tool', rawOutput: 'ENOENT not found' })), true);
});

// 回归：LLM 步骤的 rawOutput 是模型的自然语言输出——"谈论失败"≠"步骤失败"。
// 日志分析类 agent 的正常回答里全是 error/失败 字样，不得据此误判（实测数据踩坑）。
test('isErrorStep：LLM 步骤谈论失败不算失败，结构化元信息报错才算', () => {
    assert.equal(isErrorStep(step({ kind: 'llm', name: 'DeepSeek', meta: 'req 363 tok', rawOutput: '分析发现多处 Failed password 与认证失败记录' })), false);
    assert.equal(isErrorStep(step({ kind: 'llm', name: 'DeepSeek', meta: 'request failed: 429 rate limit', rawOutput: '' })), true);
});

test('errorCodeOf 兜底：未命中模式归"未分类错误"，描述带对象名', () => {
    const perTrace = [
        { executionId: 't1', steps: [step({ kind: 'tool', name: 'todowrite', meta: '', rawOutput: 'cannot proceed: weird st4te' })] },
    ];
    const { clusters } = clusterErrorSteps(perTrace);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].errorCode, '未分类错误', '兜底不截原始文本当错误码');
    assert.equal(clusters[0].object, 'todowrite');
});

test('FR-008 双源合并：错误事件 + 评测问题', () => {
    const traces: TraceLite[] = [
        trace({ executionId: 't1', toolCallErrorCount: 1, failures: [{ failure_type: '工具超时', description: 'ftp timeout', context: '', recovery: '' }] }),
        trace({ executionId: 't2', failures: [{ failure_type: '工具超时', description: 'ftp timeout again', context: '', recovery: '' }] }),
        trace({ executionId: 't3', skillIssues: [{ id: 'RC-0', type: 'root_cause', content: '遗漏关键步骤', match_score: 0.2, explanation: 'x', weight: 1, is_skill_issue: true, reasoning: 'y' } as any] }),
    ];
    const res = buildProblemSummary({ traces });

    assert.ok(res.problems.some((p) => p.source === '评测'), '应含评测来源');
    // 评测：工具超时 failures 跨 t1/t2 合并为一项，频次=2
    const failItem = res.problems.find((p) => p.key.startsWith('eval:fail:') && p.desc.includes('ftp'));
    assert.ok(failItem && failItem.frequency === 2, 'failures 同类型应合并、频次=2');
    assert.ok(res.problems.some((p) => p.key.startsWith('skill:')), '应含 skillIssue 评测问题');
});

test('BR-013 影响度排序 + 帕累托累计占比', () => {
    const problems = [
        { key: 'a', desc: 'low', source: '评测' as const, affectedDimensions: ['过程'], frequency: 2, severity: 'low' as const, attribution: 'agent逻辑' as const, relatedTraces: [], impact: 0 },
        { key: 'b', desc: 'high', source: '错误' as const, affectedDimensions: ['过程'], frequency: 10, severity: 'high' as const, attribution: '工具&infra' as const, relatedTraces: [], impact: 0 },
        { key: 'c', desc: 'mid', source: '评测' as const, affectedDimensions: ['过程'], frequency: 6, severity: 'medium' as const, attribution: '模型能力' as const, relatedTraces: [], impact: 0 },
    ];
    const ranked = rankProblems(problems);
    assert.equal(ranked[0].key, 'b', '高频高严重度应排第一');
    assert.ok(ranked[0].impact >= ranked[1].impact, '影响度降序');
    assert.equal(ranked[ranked.length - 1].cumulativePct, 100, '帕累托累计到 100%');
});

test('空源 → 空清单、不报错', () => {
    const res = buildProblemSummary({ traces: [], interactionsByTrace: new Map() });
    assert.equal(res.problems.length, 0);
    assert.equal(res.errorSummary.clusterCount, 0);
    assert.equal(rankProblems(res.problems).length, 0);
});

// ── SkillIssue 表级来源（切片1/2）────────────────────────────────────────────
function issueRow(over: Partial<SkillIssueRowLite>): SkillIssueRowLite {
    return { dedupKey: 'k1', severity: 'medium', summary: '工具误用：参数缺失', skillName: 'log-triage', version: 3, executionId: 'e1', category: '工具误用', ...over };
}

test('tableSkillIssueProblems：同 dedupKey 聚合、带 skillRef/suggestedFix/真实严重度', () => {
    const rows = [
        issueRow({ executionId: 'e1', suggestedFix: '补充参数示例' }),
        issueRow({ executionId: 'e2', severity: 'high' }),                       // 同 dedupKey 跨 trace
        issueRow({ dedupKey: 'k2', category: '关键观点遗漏', summary: '遗漏根因结论', executionId: 'e1' }),
    ];
    const items = tableSkillIssueProblems(rows);
    assert.equal(items.length, 2, '按 dedupKey 聚为 2 项');
    const k1 = items.find((p) => p.key.includes('k1'))!;
    assert.equal(k1.frequency, 2);
    assert.equal(k1.severity, 'high', '取簇内最高严重度');
    assert.deepEqual(k1.skillRef, { name: 'log-triage', version: 3 });
    assert.equal(k1.suggestedFix, '补充参数示例');
    assert.equal(k1.relatedTraces.length, 2);
    const k2 = items.find((p) => p.key.includes('k2'))!;
    assert.deepEqual(k2.affectedDimensions, ['过程'], '质量监控不再暴露结果维');
});

test('buildSkillDrag：按 skill 聚合未解决数/受影响面/拖累分排序', () => {
    const rows = [
        issueRow({ dedupKey: 'a', severity: 'high' }),
        issueRow({ dedupKey: 'b', severity: 'medium', executionId: 'e2' }),
        issueRow({ dedupKey: 'c', skillName: 'net-diag', version: 1, severity: 'low', executionId: 'e3' }),
    ];
    const traces: TraceLite[] = [
        trace({ executionId: 'e1', invokedSkills: [{ name: 'log-triage', version: 3 }] }),
        trace({ executionId: 'e2', invokedSkills: [{ name: 'log-triage', version: 3 }] }),
        trace({ executionId: 'e3' }),
        trace({ executionId: 'e4' }),
    ];
    const drag = buildSkillDrag(rows, traces);
    assert.equal(drag.length, 2);
    assert.equal(drag[0].name, 'log-triage', '严重度加权和高者居前');
    assert.equal(drag[0].unresolved, 2, 'dedupKey 去重');
    assert.equal(drag[0].affectedPct, 50, '2/4 trace 受影响');
    assert.equal(drag[1].name, 'net-diag');
    assert.equal(drag[1].affectedTraces, 1, 'invokedSkills 未匹配时按评测覆盖 executionId 兜底');
});

test('跨源去重：表级条目优先，JSON 快照同描述剔除', () => {
    const traces: TraceLite[] = [
        trace({ executionId: 'e1', skillIssues: [{ id: 'RC-0', type: 'root_cause', content: '工具误用：参数缺失', match_score: 0.2, explanation: 'x', weight: 1, is_skill_issue: true, reasoning: 'y' } as any] }),
    ];
    const res = buildProblemSummary({ traces, skillIssueRows: [issueRow({ summary: '工具误用：参数缺失' })] });
    const dupes = res.problems.filter((p) => p.desc.includes('工具误用'));
    assert.equal(dupes.length, 1, '同描述只留表级一条');
    assert.ok(dupes[0].key.startsWith('skilltbl:'), '保留的是表级条目（带 skillRef/severity 真值）');
});

// ── 诊断增强（焊点B）──────────────────────────────────────────────────────────
function diag(over: Partial<DiagnosisLite>): DiagnosisLite {
    return { module: 'action', guidance: '为该工具增加超时重试', ...over };
}
function problemItem(over: Partial<ProblemItem>): ProblemItem {
    return {
        key: 'err:x', desc: '工具超时', source: '错误', affectedDimensions: ['过程'],
        frequency: 3, severity: 'medium', attribution: 'agent逻辑', relatedTraces: ['e1', 'e2', 'e3'], impact: 0, ...over,
    };
}

test('applyDiagnoses：簇内模块投票 → rootCauseModule + 归因升级 + 修法补全', () => {
    const problems = [problemItem({})];
    const diagnoses = new Map<string, DiagnosisLite>([
        ['e1', diag({ module: 'action' })],
        ['e2', diag({ module: 'action', guidance: undefined })],
        // e3 未诊断
    ]);
    applyDiagnoses(problems, diagnoses);
    assert.equal(problems[0].rootCauseModule, 'action');
    assert.equal(problems[0].diagnosedTraces, 2);
    assert.equal(problems[0].attribution, '工具&infra', 'action 模块多数 → 归因升级为工具&infra');
    assert.equal(problems[0].suggestedFix, '为该工具增加超时重试', '诊断修复指引补进建议');
});

test('applyDiagnoses：triage=infra 优先于模块映射；评测来源问题不动', () => {
    const probs = [
        problemItem({ key: 'err:y', relatedTraces: ['e1'] }),
        problemItem({ key: 'eval:z', source: '评测', relatedTraces: ['e1'], attribution: 'agent逻辑' }),
    ];
    applyDiagnoses(probs, new Map([['e1', diag({ module: 'planning', category: 'infra' })]]));
    assert.equal(probs[0].attribution, '工具&infra', 'triage infra 直接判 infra');
    assert.equal(probs[1].rootCauseModule, undefined, '评测来源不参与诊断增强');
});

test('summarizeDiagnoses：模块指纹分布 + 诊断覆盖', () => {
    const traces: TraceLite[] = [
        trace({ executionId: 'e1', toolCallErrorCount: 1 }),
        trace({ executionId: 'e2', failures: [{ failure_type: 'x', description: '', context: '', recovery: '' }] }),
        trace({ executionId: 'e3' }),
    ];
    const { moduleFingerprint, diagnosisCoverage } = summarizeDiagnoses(traces, new Map([
        ['e1', diag({ module: 'planning' })],
        ['e2', diag({ module: 'planning' })],
    ]));
    assert.equal(diagnosisCoverage.diagnosed, 2);
    assert.equal(diagnosisCoverage.errorish, 2);
    assert.equal(moduleFingerprint[0].module, 'planning');
    assert.equal(moduleFingerprint[0].pct, 100);
});

test('lowScoreProblems：低分维度转问题项', () => {
    const dims = {
        process: { score: 55, status: '异常', coverage: 0.8, n: 8, signal: '工具错误偏高' } as DimScore,
        cost: { score: 75, status: '关注', coverage: 1, n: 10 } as DimScore,
    };
    const out = lowScoreProblems(dims, 70);
    assert.ok(out.some((p) => p.affectedDimensions[0] === '过程' && p.severity === 'high'), '异常维 → high');
    assert.ok(!out.some((p) => p.affectedDimensions[0] === '结果'), '结果维已从质量监控移除');
});
