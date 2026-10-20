import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQoderOtlpPayload } from '../scripts/qoder_trace_collector.mjs';
import { normalizeOtlpTraces } from '@/lib/ingest/otel/normalize';
import { aggregateOtelTraceEvents } from '@/lib/ingest/otel/aggregate';
import { inferenceAnalysisTarget } from '@/lib/trace/inference-analysis';
import type { RawInteraction } from '@/lib/engine/observability/agent-trace';

for (const product of ['desktop', 'jetbrains']) test(`Qoder ${product} local message IDs do not imply inference response or gateway identity`, () => {
    const session = 'gui-session', messageId = 'local-llm-message';
    const callId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const events = normalizeOtlpTraces(buildQoderOtlpPayload({
        product,
        capturedAt: '2026-10-16T01:00:05.000Z',
        hookEvents: [{ capturedAt: '2026-10-16T01:00:05.000Z', event: { hook_event_name: 'Stop', session_id: session } }],
        transcriptRecords: [
            { type: 'user', sessionId: session, timestamp: '2026-10-16T01:00:01.000Z', message: { content: 'probe' } },
            { type: 'assistant', sessionId: session, timestamp: '2026-10-16T01:00:04.000Z', message: { id: messageId, model: 'fixture', content: [{ type: 'text', text: 'result' }] } },
        ],
        inferenceCalls: [{ agent: 'qoder', session_id: session, response_id: messageId, call_id: callId, started_at: '2026-10-16T01:00:03.000Z' }],
    }));
    assert.ok(events.every(e => !e.attributes['agent_insight.inference.call_ids'] && !e.attributes['agent_insight.inference.unassigned_calls']));
    const llm = events.find(e => e.attributes['qoder.llm.message_id'] === messageId)!;
    assert.ok(llm, 'retain the local message ID for observability');
    llm.attributes['agent_insight.inference.call_ids'] = JSON.stringify([callId]);
    const root = events.find(e => e.attributes['qoder.span.type'] === 'agent')!;
    root.attributes['agent_insight.inference.unassigned_calls'] = JSON.stringify([{ call_id: callId }]);
    const record = aggregateOtelTraceEvents(session, events)!;
    const interactions = record.interactions as RawInteraction[];
    const node = interactions.find(item => item.messageID === messageId)!;
    assert.ok(node);
    assert.equal(node.inference_response_id, undefined);
    assert.equal(node.inference_response_unavailable, true);
    assert.ok(interactions.every(item => !item.inference_call_ids?.length && !item.inference_unassigned_calls?.length));
    const target = inferenceAnalysisTarget({ framework: 'qoder', scope: 'llm', interaction: node });
    assert.equal(target.responseId, undefined);
    assert.equal(target.callIds, undefined);
});
