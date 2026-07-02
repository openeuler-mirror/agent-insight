import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateJiuwenOtlpFromSpans, type JiuwenSpan } from '@/lib/ingest/otel/jiuwen/aggregate';

// ---- main-agent naming (PR !146 "适配自定义主agent" ported to jiuwen) -----------
// A single-agent (run_agent / ReAct) run emits only llm.call / tool.* spans — no
// agent.<member>.task_iteration boundary span — so agent-core carries no agent name
// for it. The old port hardcoded a spike's "jiuwenswarm/spike_agent", which then
// showed up as the main agent of EVERY single-agent jiuwen trace. The main agent must
// instead be the real configured name when present, falling back to the framework
// label "jiuwenswarm".

const singleLlmSpan = (attrs: Record<string, unknown> = {}): JiuwenSpan => ({
    name: 'llm.call',
    traceId: 'tr-single',
    spanId: 'l1',
    parentSpanId: undefined, // no enclosing agent span → routes to transformSingle
    attrs: {
        'gen_ai.completion.0.content': '杭州是一座历史文化名城。',
        'gen_ai.request.model': 'deepseek-v4-flash',
        'gen_ai.usage.prompt_tokens': 29,
        'gen_ai.usage.completion_tokens': 135,
        'gen_ai.usage.total_tokens': 164,
        ...attrs,
    },
    startNs: 3_000_000_000,
    endNs: 7_000_000_000,
});

test('single-agent run with no agent-name attribute → framework label, not the spike placeholder', () => {
    const rec = aggregateJiuwenOtlpFromSpans([singleLlmSpan()]);
    assert.ok(rec);
    assert.equal(rec!.framework, 'jiuwenswarm');
    assert.equal(rec!.agentName, 'jiuwenswarm');
    assert.equal(rec!.agent, 'jiuwenswarm');
    assert.deepEqual(rec!.agents, ['jiuwenswarm']);
    // the baked-in spike name must be gone everywhere
    assert.equal(JSON.stringify(rec).includes('spike_agent'), false);
    // the assistant interaction's agent matches the resolved main agent
    const assistant = (rec!.interactions as Array<{ role?: string; agent?: string }>).find((i) => i.role === 'assistant')!;
    assert.equal(assistant.agent, 'jiuwenswarm');
});

test('single-agent run honors a configured agentteam.agent.name', () => {
    const rec = aggregateJiuwenOtlpFromSpans([singleLlmSpan({ 'agentteam.agent.name': 'researcher' })]);
    assert.ok(rec);
    assert.equal(rec!.agentName, 'researcher');
    assert.deepEqual(rec!.agents, ['researcher']);
    const assistant = (rec!.interactions as Array<{ role?: string; agent?: string }>).find((i) => i.role === 'assistant')!;
    assert.equal(assistant.agent, 'researcher');
});

test('single-agent run honors a configured gen_ai.agent.name', () => {
    const rec = aggregateJiuwenOtlpFromSpans([singleLlmSpan({ 'gen_ai.agent.name': 'my_assistant' })]);
    assert.ok(rec);
    assert.equal(rec!.agentName, 'my_assistant');
});

test('single-agent run normalizes the "default" sentinel to the framework label', () => {
    const rec = aggregateJiuwenOtlpFromSpans([singleLlmSpan({ 'agentteam.agent.name': 'default' })]);
    assert.ok(rec);
    assert.equal(rec!.agentName, 'jiuwenswarm');
});

// ---- regression guard: team-run leader naming is unchanged --------------------
// Team runs DO carry the agent identity (agent.<member>.task_iteration spans); the
// leader must still resolve to the clean configured member name, untouched by the
// single-agent fix.

test('team run still names the main agent after the leader (regression)', () => {
    const spans: JiuwenSpan[] = [
        {
            name: 'team.demo',
            traceId: 'tr-team',
            spanId: 't1',
            parentSpanId: undefined,
            attrs: { 'agentteam.team.name': 'demo', 'agentteam.session.id': 'sess-team' },
            startNs: 1_000_000_000,
            endNs: 9_000_000_000,
        },
        {
            name: 'agent.TeamLeader.task_iteration.1',
            traceId: 'tr-team',
            spanId: 'a1',
            parentSpanId: 't1',
            attrs: { 'agentteam.agent.output': "{'output': 'done'}" },
            startNs: 2_000_000_000,
            endNs: 8_000_000_000,
        },
        {
            name: 'llm.call',
            traceId: 'tr-team',
            spanId: 'l1',
            parentSpanId: 'a1',
            attrs: {
                'gen_ai.completion.0.content': 'hi',
                'gen_ai.request.model': 'deepseek-v4-flash',
                'gen_ai.usage.total_tokens': 8,
            },
            startNs: 3_000_000_000,
            endNs: 7_000_000_000,
        },
    ];

    const rec = aggregateJiuwenOtlpFromSpans(spans);
    assert.ok(rec);
    assert.equal(rec!.agentName, 'TeamLeader');
    assert.ok((rec!.agents as string[]).includes('TeamLeader'));
});
