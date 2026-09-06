import test from 'node:test';
import assert from 'node:assert/strict';
import { getSelectedReportingChannels } from '@/lib/ingest/framework-reporting-channels';

test('OpenCode 只展示 JSON 会话快照入口', () => {
    assert.deepEqual(getSelectedReportingChannels(['opencode']), [
        {
            id: 'json-snapshot',
            endpoint: '/api/ingest/upload',
            labelZh: 'JSON 会话快照',
            labelEn: 'JSON session snapshot',
            frameworks: ['opencode'],
        },
    ]);
});

test('多选框架按通道去重并保留每个通道对应的框架', () => {
    const channels = getSelectedReportingChannels(['claude', 'openclaw', 'trae']);

    assert.deepEqual(channels.map(channel => ({
        id: channel.id,
        endpoint: channel.endpoint,
        frameworks: channel.frameworks,
    })), [
        {
            id: 'otlp-logs',
            endpoint: '/api/ingest/otel/v1/logs',
            frameworks: ['claude', 'openclaw'],
        },
        {
            id: 'otlp-traces',
            endpoint: '/api/ingest/otel/v1/traces',
            frameworks: ['openclaw'],
        },
        {
            id: 'json-snapshot',
            endpoint: '/api/ingest/upload',
            frameworks: ['trae'],
        },
    ]);
});

test('重复、空白和未知框架不会产生重复或虚假的通道', () => {
    assert.deepEqual(getSelectedReportingChannels([' QWENCODE ', 'qwencode']), [
        {
            id: 'otlp-logs',
            endpoint: '/api/ingest/otel/v1/logs',
            labelZh: 'OTLP Logs',
            labelEn: 'OTLP Logs',
            frameworks: ['qwencode'],
        },
        {
            id: 'otlp-traces',
            endpoint: '/api/ingest/otel/v1/traces',
            labelZh: 'OTLP Traces',
            labelEn: 'OTLP Traces',
            frameworks: ['qwencode'],
        },
    ]);
    assert.deepEqual(getSelectedReportingChannels(['', 'unknown']), []);
});
