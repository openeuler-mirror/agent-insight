import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InferenceAnalysisDetails } from '@/components/observe/InferenceAnalysisButton';

const target = {
    scope: 'llm' as const,
    sessionIds: ['session'],
    callIds: ['failed-call', 'final-call'],
    preferredCallId: 'final-call',
    calls: [
        { callId: 'failed-call', statusCode: 503, startedAt: '2026-10-15T08:00:00Z' },
        { callId: 'final-call', statusCode: 200, startedAt: '2026-10-15T08:00:01Z' },
    ],
};

test('Inference dialog offers separate single-ID links for failed and final model requests', () => {
    const html = renderToStaticMarkup(React.createElement(InferenceAnalysisDetails, {
        target, locale: 'zh', config: { status: 'ready', origin: 'http://127.0.0.1:19090' },
    }));
    assert.match(html, /href="http:\/\/127.0.0.1:19090\/model-performance\?GlobalTrackNO=failed-call"/);
    assert.match(html, /href="http:\/\/127.0.0.1:19090\/model-performance\?GlobalTrackNO=final-call"/);
    assert.match(html, /HTTP 503/);
    assert.match(html, /HTTP 200/);
    assert.match(html, /最近一次请求/);
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noopener noreferrer"/);
    assert.doesNotMatch(html, /GlobalTrackNO=failed-call[,\u0026]/);
});

test('Inference dialog keeps legacy identities visible but never uses them as GlobalTrackNO', () => {
    const html = renderToStaticMarkup(React.createElement(InferenceAnalysisDetails, {
        target: { scope: 'llm', sessionIds: ['legacy-session'], responseId: 'legacy-response' },
        locale: 'zh', config: { status: 'ready', origin: 'https://inference.example.com' },
    }));
    assert.match(html, /legacy-response/);
    assert.match(html, /未采集到统一模型调用 ID/);
    assert.doesNotMatch(html, /href=/);
});

test('Inference dialog explains invalid or missing service configuration without external links', () => {
    for (const status of ['invalid', 'unconfigured'] as const) {
        const html = renderToStaticMarkup(React.createElement(InferenceAnalysisDetails, {
            target, locale: 'zh', config: { status },
        }));
        assert.doesNotMatch(html, /href=/);
        assert.match(html, status === 'invalid' ? /推理分析页面地址配置无效/ : /尚未配置推理分析页面地址/);
    }
});

test('Trace dialog labels unassigned calls and never presents them as an LLM result', () => {
    const html = renderToStaticMarkup(React.createElement(InferenceAnalysisDetails, {
        target: { scope: 'trace', sessionIds: ['session'], callIds: ['unassigned'], calls: [{ callId: 'unassigned', unassigned: true, statusCode: 503 }] },
        locale: 'zh', config: { status: 'ready', origin: 'http://127.0.0.1:19090' },
    }));
    assert.match(html, /未确定所属 LLM/);
    assert.match(html, /GlobalTrackNO=unassigned/);
    assert.doesNotMatch(html, /最近一次请求/);
});
