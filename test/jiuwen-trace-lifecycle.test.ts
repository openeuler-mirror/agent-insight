import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferQuietWindowTraceCompletedAt } from '@/app/api/observe/data/route';
import { aggregateJiuwenOtlpFromSpans, type JiuwenSpan } from '@/lib/ingest/otel/jiuwen/aggregate';

// ---- read-side quiet-window inference (single-agent / mid-run team) ----------
// jiuwenswarm single-agent runs (run_agent / ReAct) emit only llm.call/tool spans
// with no enclosing root span, so — exactly like Claude Code (PR !150) — there is
// no explicit "trace finished" signal and completion is inferred from a quiet window.

test('jiuwen trace lifecycle: quiet window infers completion for jiuwenswarm', () => {
    const latestActivityMs = Date.parse('2026-06-17T07:03:13.399Z');

    assert.equal(
        inferQuietWindowTraceCompletedAt({
            framework: 'jiuwenswarm',
            latestActivityMs,
            quietLongEnough: true,
            explicitCompleted: false,
        }),
        '2026-06-17T07:03:13.399Z',
    );
});

test('jiuwen trace lifecycle: active or explicitly completed jiuwen traces are not inferred', () => {
    const latestActivityMs = Date.parse('2026-06-17T07:03:13.399Z');

    // still active (not quiet long enough) → keep showing 执行中
    assert.equal(
        inferQuietWindowTraceCompletedAt({
            framework: 'jiuwenswarm',
            latestActivityMs,
            quietLongEnough: false,
            explicitCompleted: false,
        }),
        null,
    );

    // already has Session.endTime → no need to infer
    assert.equal(
        inferQuietWindowTraceCompletedAt({
            framework: 'jiuwenswarm',
            latestActivityMs,
            quietLongEnough: true,
            explicitCompleted: true,
        }),
        null,
    );
});

// opencode / hermes 曾经在这份名单里（"有显式结束信号，不需要静默窗兜底"），后来
// 62be255「修复opencode执行状态并增加兜底逻辑」把它们加进了白名单：显式信号仍然优先
// （explicitCompleted=true 依旧返回 null，见上一条用例），静默窗只做信号缺失时的兜底。
test('jiuwen trace lifecycle: 白名单之外的框架不套 quiet-window 规则', () => {
    const latestActivityMs = Date.parse('2026-06-17T07:03:13.399Z');
    for (const framework of ['direct_llm', 'generic', 'langfuse-langgraph', undefined]) {
        assert.equal(
            inferQuietWindowTraceCompletedAt({
                framework,
                latestActivityMs,
                quietLongEnough: true,
                explicitCompleted: false,
            }),
            null,
            `${framework} should not use the quiet-window completion rule`,
        );
    }
});

// ---- ingest-side explicit signal (team runs have a `team.<name>` root span) ---

const llmSpan = (over: Partial<JiuwenSpan> = {}): JiuwenSpan => ({
    name: 'llm.call',
    traceId: 'tr1',
    spanId: 'l1',
    parentSpanId: 'a1',
    attrs: {
        'gen_ai.completion.0.content': 'hi',
        'gen_ai.request.model': 'deepseek-v4-flash',
        'gen_ai.usage.prompt_tokens': 5,
        'gen_ai.usage.completion_tokens': 3,
        'gen_ai.usage.total_tokens': 8,
    },
    startNs: 3_000_000_000,
    endNs: 7_000_000_000,
    ...over,
});

test('jiuwen aggregate: ended team.<name> root span sets trace_completed_at', () => {
    const spans: JiuwenSpan[] = [
        {
            name: 'team.demo',
            traceId: 'tr1',
            spanId: 't1',
            parentSpanId: undefined,
            attrs: { 'agentteam.team.name': 'demo', 'agentteam.session.id': 'sess-1' },
            startNs: 1_000_000_000,
            endNs: 9_000_000_000,
        },
        {
            name: 'agent.leader.task_iteration.1',
            traceId: 'tr1',
            spanId: 'a1',
            parentSpanId: 't1',
            attrs: { 'agentteam.agent.id': 'leader', 'agentteam.agent.output': "{'output': 'done'}" },
            startNs: 2_000_000_000,
            endNs: 8_000_000_000,
        },
        llmSpan(),
    ];

    const rec = aggregateJiuwenOtlpFromSpans(spans);
    assert.ok(rec);
    // team root ends at 9e9 ns → 9000 ms
    assert.equal(rec!.trace_completed_at, new Date(9_000).toISOString());
});

test('jiuwen aggregate: team run before its root span lands stays running', () => {
    // hasTeam is true (agent span present) but the team.<name> root span has not been
    // exported yet → no explicit completion signal, trace stays "执行中".
    const spans: JiuwenSpan[] = [
        {
            name: 'agent.leader.task_iteration.1',
            traceId: 'tr1',
            spanId: 'a1',
            parentSpanId: 't1',
            attrs: { 'agentteam.agent.id': 'leader' },
            startNs: 2_000_000_000,
            endNs: 8_000_000_000,
        },
        llmSpan(),
    ];

    const rec = aggregateJiuwenOtlpFromSpans(spans);
    assert.ok(rec);
    assert.equal(rec!.trace_completed_at, undefined);
});

test('jiuwen aggregate: single-agent run has no root span and no explicit completion', () => {
    const spans: JiuwenSpan[] = [llmSpan({ parentSpanId: undefined, attrs: { 'gen_ai.completion.0.content': 'hangzhou', 'gen_ai.request.model': 'deepseek-v4-flash' } })];

    const rec = aggregateJiuwenOtlpFromSpans(spans);
    assert.ok(rec);
    assert.equal(rec!.framework, 'jiuwenswarm');
    assert.equal(rec!.trace_completed_at, undefined);
});
