export type ReportingChannelId = 'otlp-logs' | 'otlp-traces' | 'json-snapshot';

export type ReportingChannel = {
    id: ReportingChannelId;
    endpoint: string;
    labelZh: string;
    labelEn: string;
};

export type SelectedReportingChannel = ReportingChannel & {
    frameworks: string[];
};

export const REPORTING_CHANNELS: readonly ReportingChannel[] = [
    {
        id: 'otlp-logs',
        endpoint: '/api/ingest/otel/v1/logs',
        labelZh: 'OTLP Logs',
        labelEn: 'OTLP Logs',
    },
    {
        id: 'otlp-traces',
        endpoint: '/api/ingest/otel/v1/traces',
        labelZh: 'OTLP Traces',
        labelEn: 'OTLP Traces',
    },
    {
        id: 'json-snapshot',
        endpoint: '/api/ingest/upload',
        labelZh: 'JSON 会话快照',
        labelEn: 'JSON session snapshot',
    },
];

const FRAMEWORK_REPORTING_CHANNELS: Readonly<Record<string, readonly ReportingChannelId[]>> = {
    opencode: ['json-snapshot'],
    claude: ['otlp-logs'],
    codeagent: ['otlp-logs'],
    openclaw: ['otlp-logs', 'otlp-traces'],
    hermes: ['otlp-traces'],
    xiaoo: ['otlp-traces'],
    jiuwen: ['otlp-traces'],
    llamaindex: ['otlp-traces'],
    qoder: ['otlp-traces'],
    trae: ['json-snapshot'],
    actrail: ['otlp-traces'],
    'pi-agent': ['otlp-traces'],
    qwencode: ['otlp-logs', 'otlp-traces'],
    codex: ['otlp-traces'],
    'deepseek-harness': ['otlp-logs'],
};

export function getSelectedReportingChannels(
    frameworks: readonly string[],
): SelectedReportingChannel[] {
    const selectedFrameworks = Array.from(new Set(
        frameworks.map(framework => framework.trim().toLowerCase()).filter(Boolean),
    ));

    return REPORTING_CHANNELS.flatMap(channel => {
        const matchedFrameworks = selectedFrameworks.filter(framework =>
            FRAMEWORK_REPORTING_CHANNELS[framework]?.includes(channel.id),
        );
        return matchedFrameworks.length ? [{ ...channel, frameworks: matchedFrameworks }] : [];
    });
}
