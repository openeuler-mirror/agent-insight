/**
 * Agent 工具调用成功率评估器测试。
 *
 * 注入点在 setJudgeLlmCallerForTest（judge 边界），完整走全链路。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setJudgeLlmCallerForTest } from '../src/lib/engine/experiment/judge-llm';
import { JudgeOutputParseError } from '../src/lib/evaluators/judge-assembly';
import { runToolSuccessRatePreset } from '../src/lib/engine/experiment/agent-tool-success-rate-evaluator';
import {
  normalizeEvaluatorCaseContext,
  type EvaluatorCaseContext,
} from '../src/lib/evaluators/evaluator-case-context';

const USER = 'test';

function ctx(overrides: {
  caseInput?: string;
  actualOutput?: string;
  interactions?: unknown[];
  evaluatorContext?: EvaluatorCaseContext | null;
} = {}): Parameters<typeof runToolSuccessRatePreset>[1] {
  return {
    caseInput: overrides.caseInput ?? 'test task',
    actualOutput: overrides.actualOutput ?? 'test output',
    referenceOutput: null,
    traceSummaryText: null,
    interactions: overrides.interactions ?? [],
    taskId: null,
    executionId: null,
    user: null,
    execution: null,
    evaluatorContext: overrides.evaluatorContext ?? undefined,
  };
}

function interactionWithToolCalls(calls: Array<{ name: string; state: string; error?: string }>) {
  return {
    role: 'assistant',
    tool_calls: calls.map((c, i) => ({
      id: `call_${i}`,
      name: c.name,
      arguments: '{}',
      state: c.state,
      output: c.state === 'completed' ? { ok: true } : undefined,
      result: c.state === 'completed' ? { ok: true } : undefined,
    })),
  };
}

function inject(json: string) {
  setJudgeLlmCallerForTest(async () => json);
}

describe('tool success rate evaluator', () => {
  it('case1: 100% success rate -> 100', async () => {
    inject(JSON.stringify({
      overall_reason: 'All 10 calls succeeded.',
      overall_success_rate: 100,
      total_calls: 10,
      successful_calls: 10,
      failed_calls: 0,
      per_tool_breakdown: [
        { tool_name: 'search', total: 5, success: 5, fail: 0, failure_rate_pct: 0 },
        { tool_name: 'read', total: 5, success: 5, fail: 0, failure_rate_pct: 0 },
      ],
      error_patterns: [],
      failure_impact: {
        critical_path_failures: false,
        retry_recovery_count: 0,
        impact_verdict: 'none',
      },
    }));
    const r = await runToolSuccessRatePreset(USER, ctx({
      interactions: [
        interactionWithToolCalls([
          ...Array.from({ length: 5 }, () => ({ name: 'search', state: 'completed' })),
          ...Array.from({ length: 5 }, () => ({ name: 'read', state: 'completed' })),
        ]),
      ],
      evaluatorContext: normalizeEvaluatorCaseContext({ schemaVersion: 1, availableTools: [{ name: 'search' }, { name: 'read' }] }),
    }));
    assert.equal(r.score, 100);
  });

  it('case2: low overall success rate + critical path failure -> <=40', async () => {
    inject(JSON.stringify({
      overall_reason: 'Only 60% success, order step failed 3 times.',
      overall_success_rate: 60,
      total_calls: 20,
      successful_calls: 12,
      failed_calls: 8,
      per_tool_breakdown: [
        { tool_name: 'order', total: 10, success: 7, fail: 3, failure_rate_pct: 30 },
        { tool_name: 'search', total: 10, success: 5, fail: 5, failure_rate_pct: 50 },
      ],
      error_patterns: [],
      failure_impact: {
        critical_path_failures: true,
        critical_path_details: 'order step failed causing task incomplete',
        retry_recovery_count: 0,
        impact_verdict: 'severe',
      },
    }));
    const calls = [
      ...Array.from({ length: 10 }, (_, idx) => ({ name: 'order', state: idx >= 7 ? 'error' : 'completed' })),
      ...Array.from({ length: 10 }, (_, idx) => ({ name: 'search', state: idx >= 5 ? 'error' : 'completed' })),
    ];
    const r = await runToolSuccessRatePreset(USER, ctx({
      interactions: [interactionWithToolCalls(calls)],
      evaluatorContext: normalizeEvaluatorCaseContext({ schemaVersion: 1, availableTools: [{ name: 'order' }, { name: 'search' }] }),
    }));
    assert.ok(r.score! <= 40, `expected <=40, got ${r.score}`);
    assert.equal(r.verdict, 'fail');
  });

  it('case3: specific tool high failure rate -> ~80 (75% overall, moderate impact)', async () => {
    inject(JSON.stringify({
      overall_reason: 'search tool 50% failure rate, others normal.',
      overall_success_rate: 75,
      total_calls: 100,
      successful_calls: 75,
      failed_calls: 25,
      per_tool_breakdown: [
        { tool_name: 'search', total: 50, success: 25, fail: 25, failure_rate_pct: 50 },
        { tool_name: 'read', total: 50, success: 50, fail: 0, failure_rate_pct: 0 },
      ],
      error_patterns: [],
      failure_impact: {
        critical_path_failures: false,
        retry_recovery_count: 0,
        impact_verdict: 'moderate',
      },
    }));
    const calls = [
      ...Array.from({ length: 50 }, (_, i) => ({ name: 'search', state: i >= 25 ? 'error' : 'completed' })),
      ...Array.from({ length: 50 }, () => ({ name: 'read', state: 'completed' })),
    ];
    const r = await runToolSuccessRatePreset(USER, ctx({
      interactions: [interactionWithToolCalls(calls)],
      evaluatorContext: normalizeEvaluatorCaseContext({ schemaVersion: 1, availableTools: [{ name: 'search' }, { name: 'read' }] }),
    }));
    // 75% success rate: 100-20=80 (no critical path failure, so no extra deduction)
    assert.ok(r.score! >= 75 && r.score! <= 85, `expected ~80, got ${r.score}`);
  });

  it('case4: same error repeated -> <=40', async () => {
    inject(JSON.stringify({
      overall_reason: 'db_query failed with 401 repeatedly, Agent did not fix.',
      overall_success_rate: 50,
      total_calls: 10,
      successful_calls: 5,
      failed_calls: 5,
      per_tool_breakdown: [
        { tool_name: 'db_query', total: 5, success: 0, fail: 5, failure_rate_pct: 100 },
        { tool_name: 'search', total: 5, success: 5, fail: 0, failure_rate_pct: 0 },
      ],
      error_patterns: [
        { error_code: '401 Unauthorized', tool_name: 'db_query', count: 5, pattern: 'auth error repeated without fix' },
      ],
      failure_impact: {
        critical_path_failures: true,
        critical_path_details: 'all db queries failed',
        retry_recovery_count: 0,
        impact_verdict: 'severe',
      },
    }));
    const calls = [
      ...Array.from({ length: 5 }, () => ({ name: 'db_query', state: 'error' })),
      ...Array.from({ length: 5 }, () => ({ name: 'search', state: 'completed' })),
    ];
    const r = await runToolSuccessRatePreset(USER, ctx({
      interactions: [interactionWithToolCalls(calls)],
      evaluatorContext: normalizeEvaluatorCaseContext({ schemaVersion: 1, availableTools: [{ name: 'db_query' }, { name: 'search' }] }),
    }));
    assert.ok(r.score! <= 40, `expected <=40, got ${r.score}`);
  });

  it('case5: retry then succeed -> score 50 (2 calls, 1 fail+1 success=50% rate, minor impact)', async () => {
    // 评估器按调用次数计：1 error + 1 completed → 50% 成功率 → base=50
    // LLM 判 minor（非关键路径），不扣分 → 50
    inject(JSON.stringify({
      overall_reason: 'First call timed out, retry succeeded.',
      overall_success_rate: 50,
      total_calls: 2,
      successful_calls: 1,
      failed_calls: 1,
      per_tool_breakdown: [
        { tool_name: 'search', total: 2, success: 1, fail: 1, failure_rate_pct: 50 },
      ],
      error_patterns: [],
      failure_impact: {
        critical_path_failures: false,
        retry_recovery_count: 1,
        impact_verdict: 'minor',
      },
    }));
    const r = await runToolSuccessRatePreset(USER, ctx({
      interactions: [interactionWithToolCalls([
        { name: 'search', state: 'error' },
        { name: 'search', state: 'completed' },
      ])],
      evaluatorContext: normalizeEvaluatorCaseContext({ schemaVersion: 1, availableTools: [{ name: 'search' }] }),
    }));
    // 50 (base) - 0 (no critical path) = 50
    assert.ok(r.score! >= 50, `expected >=50, got ${r.score}`);
  });

  it('case7: no tool calls -> 无分（不适用，不返回 100）', async () => {
    const r = await runToolSuccessRatePreset(USER, ctx({
      interactions: [],
      evaluatorContext: normalizeEvaluatorCaseContext({ schemaVersion: 1, availableTools: [] }),
    }));
    assert.equal(r.score, undefined);
    assert.match(r.summary ?? '', /无工具调用/);
    // 无分分支不展示评分点，evidence.md 与 summary 一致；判重后展开区为空
    assert.match((r.evidence as { md?: string } | undefined)?.md ?? '', /无工具调用/);
  });

  it('全部调用无明确终态（未结束 + 未知）-> 无分（不判成功率）', async () => {
    inject(JSON.stringify({
      overall_reason: 'unknown states',
      overall_success_rate: 100,
      total_calls: 2,
      successful_calls: 0,
      failed_calls: 0,
      per_tool_breakdown: [],
      error_patterns: [],
      failure_impact: { critical_path_failures: false, retry_recovery_count: 0, impact_verdict: 'none' },
    }));
    const r = await runToolSuccessRatePreset(USER, ctx({
      interactions: [{
        role: 'assistant',
        tool_calls: [
          { id: 'u1', name: 'search', arguments: '{}' },
          { id: 'u2', name: 'read', arguments: '{}', state: 'pending' },
        ],
      }],
      evaluatorContext: normalizeEvaluatorCaseContext({ schemaVersion: 1, availableTools: [{ name: 'search' }, { name: 'read' }] }),
    }));
    assert.equal(r.score, undefined);
    assert.match(r.summary ?? '', /无明确终态/);
  });

  it('未知状态排除出成功率分母，不当作成功', async () => {
    // 1 次 completed + 1 次未知 + 1 次 error → 明确状态 2 次（1 成功 1 失败）= 50%
    inject(JSON.stringify({
      overall_reason: 'one unknown excluded',
      overall_success_rate: 50,
      total_calls: 3,
      successful_calls: 1,
      failed_calls: 1,
      per_tool_breakdown: [{ tool_name: 'search', total: 3, success: 1, fail: 1, failure_rate_pct: 50 }],
      error_patterns: [],
      failure_impact: { critical_path_failures: false, retry_recovery_count: 0, impact_verdict: 'none' },
    }));
    const r = await runToolSuccessRatePreset(USER, ctx({
      interactions: [{
        role: 'assistant',
        tool_calls: [
          { id: 'a', name: 'search', arguments: '{}', state: 'completed' },
          { id: 'b', name: 'search', arguments: '{}' },
          { id: 'c', name: 'search', arguments: '{}', state: 'error' },
        ],
      }],
      evaluatorContext: normalizeEvaluatorCaseContext({ schemaVersion: 1, availableTools: [{ name: 'search' }] }),
    }));
    // 评分点「整体成功率」应反映 50%（1 成功 / 2 明确状态），未知状态排除
    const ratePoint = r.points?.find((p) => p.label === '整体成功率');
    assert.equal(ratePoint?.score, 50);
    const rateMd = (ratePoint?.evidence as { md?: string } | undefined)?.md ?? '';
    assert.match(rateMd, /1\/2 成功/);
    assert.match(rateMd, /1 次状态未知/);
  });

  it('四分类：成功/失败/未结束/未知 分别统计，未结束与未知都不进分母', async () => {
    // 1 completed + 1 error + 1 pending + 1 缺失 → 明确 2 次（1 成功 1 失败），未结束 1，未知 1
    inject(JSON.stringify({
      overall_reason: 'four-way classification',
      overall_success_rate: 50,
      total_calls: 4,
      successful_calls: 1,
      failed_calls: 1,
      per_tool_breakdown: [{ tool_name: 'search', total: 4, success: 1, fail: 1, failure_rate_pct: 50 }],
      error_patterns: [],
      failure_impact: { critical_path_failures: false, retry_recovery_count: 0, impact_verdict: 'none' },
    }));
    const r = await runToolSuccessRatePreset(USER, ctx({
      interactions: [{
        role: 'assistant',
        tool_calls: [
          { id: 'a', name: 'search', arguments: '{}', state: 'completed' },
          { id: 'b', name: 'search', arguments: '{}', state: 'error' },
          { id: 'c', name: 'search', arguments: '{}', state: 'pending' },
          { id: 'd', name: 'search', arguments: '{}' },
        ],
      }],
      evaluatorContext: normalizeEvaluatorCaseContext({ schemaVersion: 1, availableTools: [{ name: 'search' }] }),
    }));
    const ratePoint = r.points?.find((p) => p.label === '整体成功率');
    assert.equal(ratePoint?.score, 50);
    const md = (ratePoint?.evidence as { md?: string } | undefined)?.md ?? '';
    assert.match(md, /1 次未结束/);
    assert.match(md, /1 次状态未知/);
  });

  it('case8: failures on non-critical path -> >=80', async () => {
    inject(JSON.stringify({
      overall_reason: 'Core tools succeeded, auxiliary get_weather failed.',
      overall_success_rate: 85,
      total_calls: 20,
      successful_calls: 17,
      failed_calls: 3,
      per_tool_breakdown: [
        { tool_name: 'search', total: 10, success: 10, fail: 0, failure_rate_pct: 0 },
        { tool_name: 'summarize', total: 7, success: 7, fail: 0, failure_rate_pct: 0 },
        { tool_name: 'get_weather', total: 3, success: 0, fail: 3, failure_rate_pct: 100 },
      ],
      error_patterns: [],
      failure_impact: {
        critical_path_failures: false,
        retry_recovery_count: 0,
        impact_verdict: 'minor',
      },
    }));
    const calls = [
      ...Array.from({ length: 10 }, () => ({ name: 'search', state: 'completed' })),
      ...Array.from({ length: 7 }, () => ({ name: 'summarize', state: 'completed' })),
      ...Array.from({ length: 3 }, () => ({ name: 'get_weather', state: 'error' })),
    ];
    const r = await runToolSuccessRatePreset(USER, ctx({
      interactions: [interactionWithToolCalls(calls)],
      evaluatorContext: normalizeEvaluatorCaseContext({ schemaVersion: 1, availableTools: [{ name: 'search' }, { name: 'summarize' }, { name: 'get_weather' }] }),
    }));
    assert.ok(r.score! >= 80, `expected >=80, got ${r.score}`);
  });

  it('case9: all failed -> <=20', async () => {
    inject(JSON.stringify({
      overall_reason: 'All 5 calls failed.',
      overall_success_rate: 0,
      total_calls: 5,
      successful_calls: 0,
      failed_calls: 5,
      per_tool_breakdown: [
        { tool_name: 'search', total: 3, success: 0, fail: 3, failure_rate_pct: 100 },
        { tool_name: 'read', total: 2, success: 0, fail: 2, failure_rate_pct: 100 },
      ],
      error_patterns: [
        { error_code: 'timeout', tool_name: 'search', count: 3, pattern: 'all searches timed out' },
        { error_code: 'not_found', tool_name: 'read', count: 2, pattern: 'file not found' },
      ],
      failure_impact: {
        critical_path_failures: true,
        critical_path_details: 'all calls failed, task not completed',
        retry_recovery_count: 0,
        impact_verdict: 'severe',
      },
    }));
    const calls = [
      ...Array.from({ length: 3 }, () => ({ name: 'search', state: 'error' })),
      ...Array.from({ length: 2 }, () => ({ name: 'read', state: 'error' })),
    ];
    const r = await runToolSuccessRatePreset(USER, ctx({
      interactions: [interactionWithToolCalls(calls)],
      evaluatorContext: normalizeEvaluatorCaseContext({ schemaVersion: 1, availableTools: [{ name: 'search' }, { name: 'read' }] }),
    }));
    // 50 (base for 0% rate) - 30 (severe) = 20 (repeated errors blocked by severe already charged)
    assert.ok(r.score! <= 20, `expected <=20, got ${r.score}`);
    assert.equal(r.verdict, 'fail');
  });

  it('case10: fallback success -> >=80', async () => {
    inject(JSON.stringify({
      overall_reason: 'Main data source failed, switched to cache backup.',
      overall_success_rate: 90,
      total_calls: 10,
      successful_calls: 9,
      failed_calls: 1,
      per_tool_breakdown: [
        { tool_name: 'query_database', total: 1, success: 0, fail: 1, failure_rate_pct: 100 },
        { tool_name: 'query_cache', total: 9, success: 9, fail: 0, failure_rate_pct: 0 },
      ],
      error_patterns: [],
      failure_impact: {
        critical_path_failures: false,
        retry_recovery_count: 1,
        impact_verdict: 'minor',
      },
    }));
    const calls = [
      { name: 'query_database', state: 'error' },
      ...Array.from({ length: 9 }, () => ({ name: 'query_cache', state: 'completed' })),
    ];
    const r = await runToolSuccessRatePreset(USER, ctx({
      interactions: [interactionWithToolCalls(calls)],
      evaluatorContext: normalizeEvaluatorCaseContext({ schemaVersion: 1, availableTools: [{ name: 'query_database' }, { name: 'query_cache' }] }),
    }));
    assert.ok(r.score! >= 80, `expected >=80, got ${r.score}`);
  });

  it('case6: multiple failure modes -> 40~60', async () => {
    inject(JSON.stringify({
      overall_reason: 'file_read and send_email have various failure modes.',
      overall_success_rate: 55,
      total_calls: 20,
      successful_calls: 11,
      failed_calls: 9,
      per_tool_breakdown: [
        { tool_name: 'file_read', total: 10, success: 5, fail: 5, failure_rate_pct: 50 },
        { tool_name: 'send_email', total: 10, success: 6, fail: 4, failure_rate_pct: 40 },
      ],
      error_patterns: [
        { error_code: 'file_not_found', tool_name: 'file_read', count: 3, pattern: 'file not found' },
        { error_code: 'permission_denied', tool_name: 'file_read', count: 2, pattern: 'permission denied' },
        { error_code: 'network_timeout', tool_name: 'send_email', count: 4, pattern: 'network timeout' },
      ],
      failure_impact: {
        critical_path_failures: false,
        retry_recovery_count: 0,
        impact_verdict: 'moderate',
      },
    }));
    const calls = [
      ...Array.from({ length: 10 }, (_, i) => ({ name: 'file_read', state: i < 5 ? 'error' : 'completed' })),
      ...Array.from({ length: 10 }, (_, i) => ({ name: 'send_email', state: i < 4 ? 'error' : 'completed' })),
    ];
    const r = await runToolSuccessRatePreset(USER, ctx({
      interactions: [interactionWithToolCalls(calls)],
      evaluatorContext: normalizeEvaluatorCaseContext({ schemaVersion: 1, availableTools: [{ name: 'file_read' }, { name: 'send_email' }] }),
    }));
    assert.ok(r.score! >= 40 && r.score! <= 60, `expected 40~60, got ${r.score}`);
  });

  it('missing evaluatorContext -> still works (no tool catalog required)', async () => {
    // 无工具调用时返回无分（不适用），但不因缺失目录报错
    const r = await runToolSuccessRatePreset(USER, ctx({ evaluatorContext: null }));
    assert.equal(r.score, undefined);
  });

  it('judge 幻觉工具名（不在真实轨迹）→ fail-fast', async () => {
    inject(JSON.stringify({
      overall_reason: 'hallucinated tool name',
      overall_success_rate: 50,
      total_calls: 2,
      successful_calls: 1,
      failed_calls: 1,
      per_tool_breakdown: [{ tool_name: 'search', total: 2, success: 1, fail: 1, failure_rate_pct: 50 }],
      error_patterns: [
        { error_code: 'timeout', tool_name: 'not_called_tool', count: 1, pattern: 'invented' },
      ],
      failure_impact: {
        critical_path_failures: false,
        retry_recovery_count: 0,
        impact_verdict: 'minor',
      },
    }));
    await assert.rejects(
      runToolSuccessRatePreset(USER, ctx({
        interactions: [interactionWithToolCalls([
          { name: 'search', state: 'error' },
          { name: 'search', state: 'completed' },
        ])],
        evaluatorContext: normalizeEvaluatorCaseContext({ schemaVersion: 1, availableTools: [{ name: 'search' }] }),
      })),
      JudgeOutputParseError,
    );
  });

  it('judge 错误计数超过真实失败次数 → fail-fast', async () => {
    inject(JSON.stringify({
      overall_reason: 'inflated error count',
      overall_success_rate: 50,
      total_calls: 2,
      successful_calls: 1,
      failed_calls: 1,
      per_tool_breakdown: [{ tool_name: 'search', total: 2, success: 1, fail: 1, failure_rate_pct: 50 }],
      error_patterns: [
        { error_code: 'timeout', tool_name: 'search', count: 5, pattern: 'inflated' },
      ],
      failure_impact: {
        critical_path_failures: false,
        retry_recovery_count: 0,
        impact_verdict: 'minor',
      },
    }));
    await assert.rejects(
      runToolSuccessRatePreset(USER, ctx({
        interactions: [interactionWithToolCalls([
          { name: 'search', state: 'error' },
          { name: 'search', state: 'completed' },
        ])],
        evaluatorContext: normalizeEvaluatorCaseContext({ schemaVersion: 1, availableTools: [{ name: 'search' }] }),
      })),
      JudgeOutputParseError,
    );
  });
});
