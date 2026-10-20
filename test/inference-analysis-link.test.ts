import assert from 'node:assert/strict';
import test from 'node:test';
import { inferenceAnalysisTarget } from '@/lib/trace/inference-analysis';
import { buildInferenceAnalysisUrl, resolveInferenceAnalysisConfig } from '@/lib/trace/inference-analysis-link';
import type { RawInteraction } from '@/lib/engine/observability/agent-trace';

const failedId = 'c5ea737b-a040-4b64-b5f5-99981e24be28';
const successId = '95e2b0dc-90dd-4baa-92ae-270b71edb4e7';
const childId = 'd4227636-69bc-4b13-9cec-d74feb5ccc25';
const unknownId = '9792e667-98c7-410c-a67e-53b0c60349cb';

function retryInteraction(): RawInteraction {
    return {
        role: 'assistant', model: 'probe-model', messageID: 'msg-answer',
        inference_session_id: 'session-root', inference_request_id: 'request-answer',
        inference_call_ids: [failedId, successId],
        inference_attempts: [
            { request_id: 'request-answer', attempt_id: 'attempt-failed', call_id: failedId, started_at: '2026-10-15T01:00:00.000Z', status_code: 503 },
            { request_id: 'request-answer', attempt_id: 'attempt-success', call_id: successId, started_at: '2026-10-15T01:00:01.000Z', status_code: 200 },
        ],
    };
}

function llm(interaction: RawInteraction) {
    return inferenceAnalysisTarget({ framework: 'opencode', scope: 'llm', rootSessionId: 'session-root', interaction });
}

test('LLM analysis retains failed and successful retry metadata and recommends the latest attempt', () => {
    const target = llm(retryInteraction());
    assert.deepEqual(target.calls, [
        { callId: failedId, startedAt: '2026-10-15T01:00:00.000Z', statusCode: 503, model: 'probe-model', messageId: 'msg-answer', sessionId: 'session-root' },
        { callId: successId, startedAt: '2026-10-15T01:00:01.000Z', statusCode: 200, model: 'probe-model', messageId: 'msg-answer', sessionId: 'session-root' },
    ]);
    assert.equal(target.preferredCallId, successId);
});

test('latest retry selection uses start time instead of array order or success status', () => {
    const interaction = retryInteraction();
    interaction.inference_call_ids?.reverse();
    interaction.inference_attempts?.reverse();
    assert.equal(llm(interaction).preferredCallId, successId);
    interaction.inference_attempts![0].status_code = 503;
    interaction.inference_attempts![1].status_code = 200;
    assert.equal(llm(interaction).preferredCallId, successId);
});

test('ambiguous or missing retry timestamps require explicit selection', () => {
    for (const timestamp of [undefined, 'invalid', '2026-10-15T01:00:00.000Z']) {
        const interaction = retryInteraction();
        interaction.inference_attempts![1].started_at = timestamp;
        const target = llm(interaction);
        assert.equal(target.calls?.length, 2);
        assert.equal(target.preferredCallId, undefined);
    }
});

test('equivalent timestamp offsets do not create an arbitrary latest attempt', () => {
    const interaction = retryInteraction();
    interaction.inference_attempts![1].started_at = '2026-10-15T09:00:00+08:00';
    assert.equal(llm(interaction).preferredCallId, undefined);
});

test('a single failed call is selectable without a timestamp', () => {
    const interaction = retryInteraction();
    interaction.inference_call_ids = [failedId];
    interaction.inference_attempts = [{ request_id: 'request-answer', attempt_id: 'failed', call_id: failedId, status_code: 503 }];
    assert.equal(llm(interaction).preferredCallId, failedId);
    assert.equal(llm(interaction).calls?.[0].statusCode, 503);
});

test('recorded attempt state is retained without inferring completion from an HTTP status', () => {
    const interaction = retryInteraction();
    interaction.inference_attempts![1] = { ...interaction.inference_attempts![1], state: 'cancelled' };
    assert.equal(llm(interaction).calls?.find(call => call.callId === successId)?.state, 'cancelled');
});

test('matching attempt call IDs are usable even when the redundant call ID list is missing', () => {
    const interaction = retryInteraction();
    delete interaction.inference_call_ids;
    interaction.inference_attempts!.push({ request_id: 'different-request', attempt_id: 'foreign', call_id: childId, started_at: '2026-10-15T02:00:00Z' });
    assert.deepEqual(llm(interaction).callIds, [failedId, successId]);
    assert.equal(llm(interaction).preferredCallId, successId);
});

test('attempts from another request cannot supply metadata for an explicitly owned call', () => {
    const interaction = retryInteraction();
    interaction.inference_attempts![1].request_id = 'different-request';
    const target = llm(interaction);
    assert.deepEqual(target.callIds, [failedId, successId]);
    assert.equal(target.calls?.find(call => call.callId === successId)?.startedAt, undefined);
    assert.equal(target.preferredCallId, undefined);
});

test('Trace includes child and unassigned calls but never recommends one ID as a multi-call Trace', () => {
    const interactions: RawInteraction[] = [retryInteraction(), {
        role: 'subagent', model: 'child-model', messageID: 'msg-child', inference_session_id: 'session-child', inference_call_ids: [childId],
    }, {
        role: 'system', inference_session_id: 'session-root',
        inference_unassigned_calls: [{ call_id: unknownId, status_code: 503, state: 'completed', started_at: '2026-10-15T01:00:02Z', reason: 'missing_response_id' }],
    }];
    const target = inferenceAnalysisTarget({ framework: 'qoder', scope: 'trace', rootSessionId: 'session-root', interactions });
    assert.deepEqual(target.callIds, [failedId, successId, childId, unknownId]);
    assert.deepEqual(target.unassignedCallIds, [unknownId]);
    assert.equal(target.calls?.length, 4);
    assert.deepEqual(target.calls?.find(call => call.callId === unknownId), {
        callId: unknownId, statusCode: 503, state: 'completed', startedAt: '2026-10-15T01:00:02Z', unassigned: true, sessionId: 'session-root',
    });
    assert.equal(target.calls?.find(call => call.callId === childId)?.messageId, 'msg-child');
    assert.equal(target.preferredCallId, undefined);
});

test('LLM targets do not absorb unassigned calls from their interaction or neighboring nodes', () => {
    const interaction = retryInteraction();
    interaction.inference_unassigned_calls = [{ call_id: unknownId, status_code: 503 }];
    const target = inferenceAnalysisTarget({ framework: 'opencode', scope: 'llm', interaction, interactions: [{ role: 'assistant', inference_call_ids: [childId] }] });
    assert.deepEqual(target.calls?.map(call => call.callId), [failedId, successId]);
    assert.equal(target.unassignedCallIds, undefined);
});

test('Trace deduplicates repeated snapshots while retaining richer metadata', () => {
    const interactions: RawInteraction[] = [
        { role: 'assistant', inference_call_ids: [failedId], inference_session_id: 'session-root' },
        retryInteraction(), retryInteraction(),
    ];
    const target = inferenceAnalysisTarget({ scope: 'trace', rootSessionId: 'session-root', interactions });
    assert.equal(target.calls?.length, 2);
    assert.equal(target.calls?.[0].statusCode, 503);
    assert.equal(target.calls?.[0].model, 'probe-model');
});

test('a single unassigned Trace call remains available and explicitly marked', () => {
    const target = inferenceAnalysisTarget({ scope: 'trace', interactions: [{ role: 'system', inference_unassigned_calls: [{ call_id: unknownId, state: 'failed' }] }] });
    assert.equal(target.preferredCallId, unknownId);
    assert.equal(target.calls?.[0].unassigned, true);
});

test('legacy session, response, message, request and attempt IDs never become unified call IDs', () => {
    for (const framework of ['qoder', 'opencode']) {
        const target = inferenceAnalysisTarget({ framework, scope: 'llm', rootSessionId: 'legacy-root', interaction: {
            role: 'assistant', messageID: 'legacy-message', inference_response_id: 'legacy-response', inference_request_id: 'legacy-request', inference_session_id: 'legacy-session',
            inference_attempts: [{ request_id: 'legacy-request', attempt_id: 'legacy-attempt', started_at: '2026-10-15T00:00:00Z' }],
        } });
        assert.equal(target.callIds, undefined);
        assert.equal(target.calls, undefined);
        assert.equal(target.preferredCallId, undefined);
        assert.equal(target.responseId, 'legacy-response');
    }
});

test('an absent inference origin is explicitly unconfigured', () => {
    for (const raw of [undefined, null, '', '  ']) {
        assert.deepEqual(resolveInferenceAnalysisConfig(raw), { status: 'unconfigured' });
    }
});

test('inference origins support HTTP, HTTPS, IPv4, IPv6 and ports', () => {
    for (const [raw, origin] of [
        ['http://192.0.2.10:8080', 'http://192.0.2.10:8080'],
        [' https://Analysis.Example.com:8443/ ', 'https://analysis.example.com:8443'],
        ['http://[::1]:3088/', 'http://[::1]:3088'],
    ]) {
        assert.deepEqual(resolveInferenceAnalysisConfig(raw), { status: 'ready', origin });
    }
});

test('unsafe or non-origin configuration is invalid', () => {
    for (const raw of [
        'javascript:alert(1)', 'file:///tmp/model-performance', '//example.com', 'example.com:8080',
        'http://user:secret@example.com', 'http://example.com/path', 'http://example.com/..',
        'http://example.com?x=1', 'http://example.com#part', 'http://example.com?', 'http://example.com#',
        'http://example.com:999999', 'http://example.com\\path', 'http:/example.com', 'https://exa\nmple.com',
    ]) {
        assert.deepEqual(resolveInferenceAnalysisConfig(raw), { status: 'invalid' }, raw);
    }
});

test('a configured link uses the fixed path and exactly one encoded GlobalTrackNO', () => {
    const callId = 'call/?#&= +汉字';
    const link = buildInferenceAnalysisUrl(resolveInferenceAnalysisConfig('http://192.0.2.10:8080/'), callId);
    assert.ok(link);
    const url = new URL(link);
    assert.equal(url.origin, 'http://192.0.2.10:8080');
    assert.equal(url.pathname, '/model-performance');
    assert.equal(url.searchParams.get('GlobalTrackNO'), callId);
    assert.deepEqual([...url.searchParams.keys()], ['GlobalTrackNO']);
    assert.equal(url.hash, '');
    assert.ok(!link.includes('汉字'));
});

test('missing or invalid configuration and blank IDs never produce an external URL', () => {
    assert.equal(buildInferenceAnalysisUrl({ status: 'unconfigured' }, failedId), undefined);
    assert.equal(buildInferenceAnalysisUrl({ status: 'invalid' }, failedId), undefined);
    assert.equal(buildInferenceAnalysisUrl({ status: 'ready', origin: 'javascript:alert(1)' }, failedId), undefined);
    for (const id of [undefined, null, '', '  ']) {
        assert.equal(buildInferenceAnalysisUrl(resolveInferenceAnalysisConfig('https://analysis.example.com'), id), undefined);
    }
});

test('the link contract accepts only the selected single unified call ID', () => {
    const config = resolveInferenceAnalysisConfig('https://analysis.example.com');
    const target = llm(retryInteraction());
    const url = new URL(buildInferenceAnalysisUrl(config, target.preferredCallId)!);
    assert.equal(url.searchParams.get('GlobalTrackNO'), successId);
    assert.ok(!url.href.includes(failedId));
    const legacy = llm({ role: 'assistant', inference_session_id: 'legacy-session', inference_request_id: 'legacy-request', messageID: 'legacy-message' });
    assert.equal(buildInferenceAnalysisUrl(config, legacy.preferredCallId), undefined);
});
