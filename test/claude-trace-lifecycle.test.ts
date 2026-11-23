/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    hasAssistantOutput,
    inferQuietWindowTraceCompletedAt,
} from '@/lib/trace/lifecycle';
import { aggregateClaudeOtelEvents } from '@/lib/ingest/claude-otel/aggregator';
import { getTraceLifecycle, TRACE_INACTIVITY_TIMEOUT_MS } from '@/lib/observe/trace-lifecycle';

// 白名单是**显式清单**，不从 QUIET_WINDOW_INFERRED_FRAMEWORKS 反推——否则改了实现
// 测试跟着一起变，等于没测。往集合里加框架必须同步改这里，逼一次有意识的确认。
const QUIET_WINDOW_FRAMEWORKS = ['claudecode', 'jiuwenswarm', 'opencode', 'hermes', 'openclaw', 'qwenpaw'];
const NON_QUIET_WINDOW_FRAMEWORKS = ['claude', 'direct_llm', 'generic', 'langfuse-langgraph', undefined];

test('Claude Code trace lifecycle: quiet window infers completion for the allowlisted frameworks', () => {
    const latestActivityMs = Date.parse('2026-06-17T07:03:13.399Z');

    for (const framework of QUIET_WINDOW_FRAMEWORKS) {
        assert.equal(
            inferQuietWindowTraceCompletedAt({
                framework,
                latestActivityMs,
                quietLongEnough: true,
                explicitCompleted: false,
            }),
            '2026-06-17T07:03:13.399Z',
            `${framework} should use the quiet-window completion rule`,
        );
    }

    for (const framework of NON_QUIET_WINDOW_FRAMEWORKS) {
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

// ─── 客户端 hook 上报的轮次结束信号 ───────────────────────────────────────────
const TURN_SESSION = 'session-turn-end';

function turnEvents() {
    return [
        event(TURN_SESSION, 'user_prompt', { prompt: '一个简单任务' }, 1, '2026-06-17T07:00:00.000Z'),
        event(TURN_SESSION, 'api_request', { model: 'claude-sonnet-4-6', input_tokens: 10, output_tokens: 4 }, 2, '2026-06-17T07:00:01.000Z'),
        event(TURN_SESSION, 'assistant_response', { response: '做完了。', query_source: 'repl_main_thread' }, 3, '2026-06-17T07:00:02.000Z'),
    ];
}

function event(sid: string, eventName: string, attributes: Record<string, any>, sequence: number, ts: string) {
    return {
        sessionId: sid,
        promptId: 'p1',
        resource: {},
        receivedAt: ts,
        eventTimestamp: ts,
        sequence,
        eventName,
        attributes,
    } as any;
}

function turnEnd(hookEvent: string, ts: string, sequence = 90) {
    return event(TURN_SESSION, 'context_supplement', { kind: 'turn_end', hook_event: hookEvent }, sequence, ts);
}

test('Claude Code trace lifecycle: Stop 信号按客户端事件时间收敛为已完成', () => {
    const record = aggregateClaudeOtelEvents(TURN_SESSION, [
        ...turnEvents(),
        turnEnd('Stop', '2026-06-17T07:00:03.000Z'),
    ]);

    assert.ok(record);
    assert.equal(record.trace_completed_at, '2026-06-17T07:00:03.000Z');
    assert.equal(record.executionStatus, 'completed');
    // 结束信号只收敛状态,不产生任何 interaction
    assert.equal((record.interactions as any[]).some((item) => item.role === 'turn_end'), false);
    // 读侧据此立刻显示已完成,不需要等十分钟
    const lifecycle = getTraceLifecycle(record.trace_completed_at, {
        executionStatus: record.executionStatus,
        lastIngestedAt: '2026-06-17T07:00:04.000Z',
    });
    assert.equal(lifecycle.traceStatus, 'success');
});

test('Claude Code trace lifecycle: SubagentStop 与无结束信号都不算整轮完成', () => {
    const subagentStop = aggregateClaudeOtelEvents(TURN_SESSION, [
        ...turnEvents(),
        turnEnd('SubagentStop', '2026-06-17T07:00:03.000Z'),
    ]);
    assert.ok(subagentStop);
    assert.equal(subagentStop.trace_completed_at, undefined);
    assert.equal(subagentStop.executionStatus, 'in_progress');

    const noSignal = aggregateClaudeOtelEvents(TURN_SESSION, turnEvents());
    assert.ok(noSignal);
    assert.equal(noSignal.trace_completed_at, undefined);
    assert.equal(noSignal.executionStatus, 'in_progress');
});

test('Claude Code trace lifecycle: StopFailure 收敛为失败,重复 Stop 幂等', () => {
    const failed = aggregateClaudeOtelEvents(TURN_SESSION, [
        ...turnEvents(),
        turnEnd('StopFailure', '2026-06-17T07:00:03.000Z'),
    ]);
    assert.ok(failed);
    assert.equal(failed.executionStatus, 'failed');
    assert.equal(failed.trace_completed_at, '2026-06-17T07:00:03.000Z');
    const lifecycle = getTraceLifecycle(failed.trace_completed_at, { executionStatus: failed.executionStatus });
    assert.equal(lifecycle.traceStatus, 'failed');

    const repeated = aggregateClaudeOtelEvents(TURN_SESSION, [
        ...turnEvents(),
        turnEnd('Stop', '2026-06-17T07:00:03.000Z', 90),
        turnEnd('Stop', '2026-06-17T07:00:03.000Z', 91),
    ]);
    assert.ok(repeated);
    assert.equal(repeated.executionStatus, 'completed');
    assert.equal(repeated.trace_completed_at, '2026-06-17T07:00:03.000Z');
});

test('Claude Code trace lifecycle: Stop 之后迟到的 SessionEnd 不推迟完成时刻', () => {
    const record = aggregateClaudeOtelEvents(TURN_SESSION, [
        ...turnEvents(),
        turnEnd('Stop', '2026-06-17T07:00:03.000Z', 90),
        turnEnd('SessionEnd', '2026-06-17T09:30:00.000Z', 91),
    ]);
    assert.ok(record);
    assert.equal(record.trace_completed_at, '2026-06-17T07:00:03.000Z');
    assert.equal(record.executionStatus, 'completed');

    // 没有 Stop(进程直接退出)时才由 SessionEnd 兜底
    const sessionEndOnly = aggregateClaudeOtelEvents(TURN_SESSION, [
        ...turnEvents(),
        turnEnd('SessionEnd', '2026-06-17T07:30:00.000Z'),
    ]);
    assert.ok(sessionEndOnly);
    assert.equal(sessionEndOnly.trace_completed_at, '2026-06-17T07:30:00.000Z');
});

test('Claude Code trace lifecycle: 多轮会话中新的活动让上一轮 Stop 失效', () => {
    const record = aggregateClaudeOtelEvents(TURN_SESSION, [
        ...turnEvents(),
        turnEnd('Stop', '2026-06-17T07:00:03.000Z'),
        // 用户接着问了下一轮,新活动晚于上一次 Stop
        event(TURN_SESSION, 'user_prompt', { prompt: '再问一个' }, 10, '2026-06-17T07:05:00.000Z'),
        event(TURN_SESSION, 'assistant_response', { response: '答复中', query_source: 'repl_main_thread' }, 11, '2026-06-17T07:05:01.000Z'),
    ]);

    assert.ok(record);
    assert.equal(record.trace_completed_at, undefined);
    assert.equal(record.executionStatus, 'in_progress');
});

test('Claude Code trace lifecycle: 无活动超过十分钟仍落到超时兜底', () => {
    const now = Date.parse('2026-06-17T07:20:00.000Z');
    const lastIngestedAt = new Date(now - TRACE_INACTIVITY_TIMEOUT_MS).toISOString();
    const lifecycle = getTraceLifecycle(null, { executionStatus: 'in_progress', lastIngestedAt }, now);
    assert.equal(lifecycle.traceStatus, 'timed_out');
    assert.equal(lifecycle.traceStatusReason, 'inactivity-timeout');
    assert.equal(lifecycle.traceCompletedAt, null);

    // 有显式完成时间时,再长的空闲也不再判超时
    const completed = getTraceLifecycle('2026-06-17T07:00:03.000Z', { executionStatus: 'completed', lastIngestedAt }, now);
    assert.equal(completed.traceStatus, 'success');
});
