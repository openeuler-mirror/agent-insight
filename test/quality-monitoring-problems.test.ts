import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProblemSummary, rankProblems, lowScoreProblems, clusterErrorSteps, isErrorStep } from '@/lib/engine/quality-monitoring/problem-summary';
import type { TraceLite, DimScore } from '@/lib/engine/quality-monitoring/types';
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
        { key: 'c', desc: 'mid', source: '评测' as const, affectedDimensions: ['结果', '过程'], frequency: 6, severity: 'medium' as const, attribution: '模型能力' as const, relatedTraces: [], impact: 0 },
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

test('lowScoreProblems：低分维度转问题项', () => {
    const dims = {
        result: { score: 92, status: '达标', coverage: 1, n: 10 } as DimScore,
        process: { score: 55, status: '异常', coverage: 0.8, n: 8, signal: '工具错误偏高' } as DimScore,
        cost: { score: 75, status: '关注', coverage: 1, n: 10 } as DimScore,
    };
    const out = lowScoreProblems(dims, 70);
    assert.ok(out.some((p) => p.affectedDimensions[0] === '过程' && p.severity === 'high'), '异常维 → high');
    assert.ok(!out.some((p) => p.affectedDimensions[0] === '结果'), '达标维不生成问题');
});
