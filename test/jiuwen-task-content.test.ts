import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateJiuwenOtlpFromSpans, type JiuwenSpan } from '@/lib/ingest/otel/jiuwen/aggregate';

// The "任务内容" column = ExecutionRecord.query. jiuwen's prompt telemetry varies by
// topology and inbound channel; extractQuery normalizes WHERE the prompt lives (role
// aware, with a .1 → .0 index fallback) and HOW the channel wrapped it (ACP / metadata
// envelopes are unwrapped to the human-readable .content). A single-agent llm.call span
// (no enclosing agent span) routes to transformSingle, so rec.query == the derived task.
const llm = (attrs: Record<string, unknown>): JiuwenSpan => ({
    name: 'llm.call',
    traceId: 'tr1',
    spanId: 'l1',
    parentSpanId: undefined,
    attrs: {
        'gen_ai.completion.0.content': 'ok',
        'gen_ai.request.model': 'deepseek-v4-flash',
        ...attrs,
    },
    startNs: 1_000_000_000,
    endNs: 2_000_000_000,
});

const queryOf = (attrs: Record<string, unknown>): string =>
    aggregateJiuwenOtlpFromSpans([llm(attrs)])!.query ?? '';

test('clean user prompt at .1 is shown verbatim', () => {
    assert.equal(queryOf({ 'gen_ai.prompt.1.content': '你好' }), '你好');
});

test('user prompt at .0 (no system message) is recovered, not the "jiuwenswarm run" placeholder', () => {
    assert.equal(queryOf({ 'gen_ai.prompt.0.content': '介绍一下杭州' }), '介绍一下杭州');
});

test('role-aware: picks the role=user prompt regardless of index', () => {
    assert.equal(queryOf({
        'gen_ai.prompt.0.role': 'system', 'gen_ai.prompt.0.content': '你是一个助手',
        'gen_ai.prompt.1.role': 'user', 'gen_ai.prompt.1.content': '今天几号',
    }), '今天几号');
});

test('ACP user-message envelope is unwrapped to its .content (the bug the user reported)', () => {
    const env = '你收到一条消息： {"source": "acp", "timezone": "Asia/Shanghai", '
        + '"preferred_response_language": "zh", "content": "用一句话介绍杭州，并说说你查了哪些信息", '
        + '"files_updated_by_user": "{}", "type": "user input"}';
    assert.equal(queryOf({ 'gen_ai.prompt.1.content': env }), '用一句话介绍杭州，并说说你查了哪些信息');
});

test('bare envelope JSON (no 你收到一条消息 prefix) is still unwrapped', () => {
    const env = '{"source":"acp","content":"hello there","type":"user input"}';
    assert.equal(queryOf({ 'gen_ai.prompt.1.content': env }), 'hello there');
});

test('truncated envelope JSON falls back to a best-effort content regex', () => {
    const env = '你收到一条消息： {"source": "acp", "type": "user input", "content": "拉两个人报数", "files_updated';
    assert.equal(queryOf({ 'gen_ai.prompt.1.content': env }), '拉两个人报数');
});

test('a non-envelope JSON that happens to have a content field is NOT unwrapped (no markers)', () => {
    const text = '{"content":"not an envelope","foo":1}';
    assert.equal(queryOf({ 'gen_ai.prompt.1.content': text }), text);
});

test('no prompt content at all → "jiuwenswarm run" fallback is unchanged', () => {
    assert.equal(queryOf({}), 'jiuwenswarm run');
});
