import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    hasAssistantOutput,
    inferQuietWindowTraceCompletedAt,
} from '@/app/api/observe/data/route';
import { aggregateClaudeOtelEvents } from '@/lib/ingest/claude-otel/aggregator';

test('Claude Code trace lifecycle: quiet window infers completion for claudecode only', () => {
    const latestActivityMs = Date.parse('2026-06-17T07:03:13.399Z');

    assert.equal(
        inferQuietWindowTraceCompletedAt({
            framework: 'claudecode',
            latestActivityMs,
            quietLongEnough: true,
            explicitCompleted: false,
        }),
        '2026-06-17T07:03:13.399Z',
    );

    for (const framework of ['opencode', 'hermes', 'openclaw', 'claude', undefined]) {
        assert.equal(
            inferQuietWindowTraceCompletedAt({
                framework,
                latestActivityMs,
                quietLongEnough: true,
                explicitCompleted: false,
            }),
            null,
            `${framework} should not use the Claude Code quiet-window completion rule`,
        );
    }
});

test('Claude Code trace lifecycle: active or explicitly completed traces are not inferred', () => {
    const latestActivityMs = Date.parse('2026-06-17T07:03:13.399Z');

    assert.equal(
        inferQuietWindowTraceCompletedAt({
            framework: 'claudecode',
            latestActivityMs,
            quietLongEnough: false,
            explicitCompleted: false,
        }),
        null,
    );

    assert.equal(
        inferQuietWindowTraceCompletedAt({
            framework: 'claudecode',
            latestActivityMs,
            quietLongEnough: true,
            explicitCompleted: true,
        }),
        null,
    );
});

// 把「聚合」和「完成判定」串起来:客户端与服务端不同机时 body_ref 读不到,
// 若助手消息产不出来,hasAssistantOutput 为 false → 后端拒绝推断 trace_completed_at
// → 前端永远"执行中"。assistant_response 兜底必须让这条链重新闭合。
test('Claude Code trace lifecycle: unreachable body_ref still converges to completed', () => {
    const sid = 'session-lifecycle-crossmachine';
    const ev = (eventName: string, attributes: Record<string, any>, sequence: number, ts: string) => ({
        sessionId: sid,
        promptId: 'p1',
        resource: {},
        receivedAt: ts,
        eventTimestamp: ts,
        sequence,
        eventName,
        attributes,
    }) as any;

    const events = [
        ev('user_prompt', { prompt: '一个简单任务' }, 1, '2026-06-17T07:03:00.000Z'),
        ev('api_request', { model: 'claude-sonnet-4-6', input_tokens: 10, output_tokens: 4, duration_ms: 800 }, 2, '2026-06-17T07:03:01.000Z'),
        ev('assistant_response', { response: '做完了。', query_source: 'repl_main_thread', model: 'claude-sonnet-4-6' }, 3, '2026-06-17T07:03:02.000Z'),
        // 服务端不存在这个路径 —— 跨机上报时 body_ref 的真实形态
        ev('api_response_body', { model: 'claude-sonnet-4-6', body_ref: '/root/.agent-insight/claude_raw_bodies/absent.response.json' }, 4, '2026-06-17T07:03:02.000Z'),
    ];

    const record = aggregateClaudeOtelEvents(sid, events);
    assert.ok(record);
    const interactions = (record.interactions ?? []) as any[];
    assert.equal(record.final_result, '做完了。');
    assert.equal(hasAssistantOutput(interactions), true, '兜底须产出非空助手输出,否则后端不推断完成时间');
    assert.equal(
        inferQuietWindowTraceCompletedAt({
            framework: record.framework,
            latestActivityMs: Date.parse(interactions[interactions.length - 1].timestamp),
            quietLongEnough: true,
            explicitCompleted: false,
        }),
        '2026-06-17T07:03:02.000Z',
    );

    // 对照组:没有 assistant_response 可兜底(如模型调用直接报错)时仍然推不出完成时间
    const degraded = aggregateClaudeOtelEvents(sid, events.filter((e) => e.eventName !== 'assistant_response'));
    assert.equal(hasAssistantOutput((degraded?.interactions ?? []) as any[]), false);
});

test('Claude Code trace lifecycle: light records can use session assistant output as completion signal', () => {
    assert.equal(
        hasAssistantOutput([
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi there' },
        ]),
        true,
    );

    assert.equal(
        hasAssistantOutput([
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: '   ' },
        ]),
        false,
    );
});
