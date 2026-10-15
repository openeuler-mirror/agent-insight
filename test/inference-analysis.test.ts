import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { inferenceAnalysisTarget } from '@/lib/trace/inference-analysis';
import { InferenceAnalysisDetails } from '@/components/observe/InferenceAnalysisButton';
import { toTraceStructureInteractions } from '@/lib/trace/session-payload';

test('Qoder child inference uses the wire root session and real response ID', () => {
    const [interaction] = toTraceStructureInteractions([{ role: 'subagent', subagent_session_id: 'child-agent', inference_session_id: 'wire-root', messageID: 'response-1', model: 'probe' }]);
    const target = inferenceAnalysisTarget({ framework: 'qoder', scope: 'llm', rootSessionId: 'current-root', interaction });
    assert.deepEqual(target.sessionIds, ['wire-root']);
    assert.equal(target.responseId, 'response-1');
    assert.equal(target.unavailableReason, undefined);
});

test('Qoder local errors and missing response IDs never become link targets', () => {
    for (const interaction of [
        { role: 'assistant' as const, messageID: 'local-error', model: '<synthetic>' },
        { role: 'assistant' as const, messageID: 'local-error', inference_response_unavailable: true },
        { role: 'assistant' as const, spanId: 'internal-span', traceId: 'internal-trace' },
    ]) {
        const target = inferenceAnalysisTarget({ framework: 'qoder', scope: 'llm', rootSessionId: 'wire-root', interaction });
        assert.equal(target.responseId, undefined);
        assert.equal(target.unavailableReason, 'response');
    }
});

test('OpenCode retains per-call session and retry attempts without substituting message IDs', () => {
    const target = inferenceAnalysisTarget({ framework: 'opencode', scope: 'llm', rootSessionId: 'root', interaction: {
        role: 'subagent', inference_session_id: 'child', messageID: 'message', inference_request_id: 'logical-call',
        inference_attempts: [{ request_id: 'logical-call', attempt_id: 'try-1', status_code: 503 }, { request_id: 'logical-call', attempt_id: 'try-2', status_code: 200 }, { request_id: 'other-call', attempt_id: 'unrelated' }],
    } });
    assert.deepEqual(target.sessionIds, ['child']);
    assert.equal(target.requestId, 'logical-call');
    assert.deepEqual(target.attemptIds, ['try-1', 'try-2']);
    assert.equal(target.responseId, undefined);
    assert.equal(inferenceAnalysisTarget({ framework: 'opencode', scope: 'llm', rootSessionId: 'root', interaction: { role: 'assistant' as const, messageID: 'message' } }).unavailableReason, 'request');
});

test('Trace target includes OpenCode child sessions and deduplicates Qoder wire sessions', () => {
    const interactions = [{ role: 'assistant' as const, inference_session_id: 'root' }, { role: 'assistant' as const, inference_session_id: 'child' }, { role: 'assistant' as const, inference_session_id: 'child' }];
    assert.deepEqual(inferenceAnalysisTarget({ framework: 'opencode', scope: 'trace', rootSessionId: 'root', interactions }).sessionIds, ['root', 'child']);
    assert.deepEqual(inferenceAnalysisTarget({ framework: 'qoder', scope: 'trace', rootSessionId: 'root' }).sessionIds, ['root']);
});

test('Inference entry explains unconfigured and missing-ID states without fabricating a URL', () => {
    const ready = renderToStaticMarkup(React.createElement(InferenceAnalysisDetails, { target: inferenceAnalysisTarget({ framework: 'qoder', scope: 'llm', rootSessionId: 'root', interaction: { role: 'assistant' as const, messageID: 'response' } }), locale: 'zh' }));
    assert.match(ready, /尚未配置推理分析页面地址/);
    assert.match(ready, /response/);
    assert.doesNotMatch(ready, /href=/);
    const missing = renderToStaticMarkup(React.createElement(InferenceAnalysisDetails, { target: inferenceAnalysisTarget({ framework: 'qoder', scope: 'llm', rootSessionId: 'root', interaction: { role: 'assistant', model: '<synthetic>', messageID: 'local-error' } }), locale: 'zh' }));
    assert.match(missing, /未采集到推理服务响应 ID/);
    assert.doesNotMatch(missing, /local-error/);
});

test('Mixed-framework collaboration uses each call identity instead of the root framework', () => {
    const openCodeChild = inferenceAnalysisTarget({ framework: 'qoder', scope: 'llm', rootSessionId: 'qoder-root', interaction: {
        role: 'subagent', messageID: 'opencode-local-message', inference_session_id: 'opencode-child', inference_request_id: 'actual-wire-request',
    } });
    assert.equal(openCodeChild.responseId, undefined);
    assert.equal(openCodeChild.requestId, 'actual-wire-request');
    const qoderChild = inferenceAnalysisTarget({ framework: 'opencode', scope: 'llm', rootSessionId: 'opencode-root', interaction: {
        role: 'subagent', messageID: 'service-response', inference_response_id: 'service-response', inference_session_id: 'qoder-child',
    } });
    assert.equal(qoderChild.responseId, 'service-response');
    assert.deepEqual(qoderChild.sessionIds, ['qoder-child']);
    assert.equal(qoderChild.unavailableReason, undefined);
    const foreignLegacy = inferenceAnalysisTarget({ framework: 'qoder', scope: 'llm', rootSessionId: 'qoder-root', interaction: {
        role: 'subagent', messageID: 'foreign-local-message', _collaboration: { taskId: 'other-task' },
    } });
    assert.equal(foreignLegacy.responseId, undefined);
});
