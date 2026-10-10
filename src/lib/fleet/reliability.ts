import { bucketLabel, isSuccess, type Plan } from '@/lib/fleet/agg';
import { parseCallStats } from '@/lib/fleet/call-stats';
import { resolveTracePlatform } from '@/lib/ingest/ras/platform-label';
import { buildRasTaskSummaries } from '@/lib/ingest/ras/store';

export type ReliabilityExecutionRow = {
    id: string;
    taskId: string | null;
    timestamp: Date;
    framework: string | null;
    agentName: string | null;
    query: string | null;
    toolCallErrorCount: number | null;
    failures: string | null;
    callStats: string | null;
};

export type ReliabilityEventRow = {
    id: string;
    deliveryId: string;
    taskId: string;
    type: string;
    platform: string | null;
    framework: string | null;
    anomalyKind: string | null;
    severity: string | null;
    summary: string | null;
    actionTypes: string | null;
    payloadJson: string;
    ts: Date;
};

export type FleetReliabilityResponse = {
    filters: { platforms: string[]; agents: string[] };
    kpi: {
        totalTraces: number;
        faultTraces: number;
        faultRate: number;
        recoveredTraces: number;
        recoveryRate: number;
        unrecoveredTraces: number;
    };
    trend: { label: string; faults: number; recovered: number }[];
    recovery: { recovered: number; unrecovered: number };
    severity: { key: string; label: string; count: number }[];
    modes: { kind: string; total: number; recovered: number; unrecovered: number }[];
    agents: { name: string; platform: string; traces: number; faults: number; faultRate: number; recoveryRate: number }[];
    failureSupplement: {
        failAgents: { name: string; total: number; fail: number; errorRate: number }[];
        errTypes: { tool: { label: string; count: number }[]; judge: { label: string; count: number }[] };
        callStatsCoverage: { withStats: number; total: number };
    };
    recentFaultTraces: {
        taskId: string;
        executionId: string;
        agent: string;
        platform: string;
        faultMode: string;
        recoveryStatus: 'recovered' | 'unrecovered';
        ts: string;
    }[];
};

type TraceView = {
    row: ReliabilityExecutionRow;
    taskId: string;
    platform: string;
    agent: string;
    hasFault: boolean;
    recovered: boolean;
    kinds: string[];
    maxSeverity: string | null;
    detectedAt: Date | null;
    recoveredAt: Date | null;
    latestAt: Date;
};

const SEVERITIES = [
    { key: 'critical', label: '严重' },
    { key: 'high', label: '高危' },
    { key: 'medium', label: '中危' },
    { key: 'low', label: '低危' },
    { key: 'normal', label: '正常' },
    { key: 'unlabeled', label: '未标注' },
];

const roundPct = (part: number, total: number) => total ? Math.round((part / total) * 1000) / 10 : 0;

function dedupeEvents(events: ReliabilityEventRow[]): ReliabilityEventRow[] {
    const seen = new Set<string>();
    return events.filter((event) => {
        const key = `${event.taskId}\u001f${event.deliveryId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function topN<T>(rows: T[], score: (row: T) => number, limit = 10): T[] {
    return [...rows].sort((a, b) => score(b) - score(a)).slice(0, limit);
}

function buildTraceViews(rows: ReliabilityExecutionRow[], events: ReliabilityEventRow[]): TraceView[] {
    const uniqueEvents = dedupeEvents(events);
    const summaries = buildRasTaskSummaries(uniqueEvents);
    const eventsByTask = new Map<string, ReliabilityEventRow[]>();
    for (const event of uniqueEvents) {
        const current = eventsByTask.get(event.taskId) || [];
        current.push(event);
        eventsByTask.set(event.taskId, current);
    }

    return rows.map((row) => {
        const taskId = row.taskId || row.id;
        const taskEvents = eventsByTask.get(taskId) || [];
        const summary = summaries[taskId];
        const anomalyEvents = taskEvents.filter((event) => event.type === 'anomaly');
        const platformEvent = [...taskEvents].reverse().find((event) => event.platform || event.framework);
        const platform = resolveTracePlatform({
            eventPlatform: platformEvent?.platform,
            eventFramework: platformEvent?.framework,
            executionFramework: row.framework,
        }) || 'unknown';
        const actionResults = taskEvents.filter((event) => event.type === 'action_result');
        const hasFault = Boolean(summary?.hasFault);
        const recovered = hasFault && summary?.recoveryOutcome === 'success';
        const detectedAt = anomalyEvents.length ? new Date(Math.min(...anomalyEvents.map((event) => event.ts.getTime()))) : null;
        const recoveredAt = recovered && actionResults.length
            ? new Date(Math.max(...actionResults.map((event) => event.ts.getTime())))
            : null;
        const latestAt = taskEvents.length
            ? new Date(Math.max(...taskEvents.map((event) => event.ts.getTime())))
            : row.timestamp;
        return {
            row, taskId, platform,
            agent: row.agentName?.trim() || '(未命名)',
            hasFault, recovered,
            kinds: summary?.kinds || [],
            maxSeverity: summary?.maxSeverity || null,
            detectedAt, recoveredAt, latestAt,
        };
    });
}

export function aggregateFleetReliability(input: {
    rows: ReliabilityExecutionRow[];
    events: ReliabilityEventRow[];
    starts: number[];
    plan: Plan;
    platform?: string | null;
    agent?: string | null;
}): FleetReliabilityResponse {
    const allViews = buildTraceViews(input.rows, input.events);
    const platforms = [...new Set(allViews.map((trace) => trace.platform))].sort();
    const platformViews = input.platform && input.platform !== 'all'
        ? allViews.filter((trace) => trace.platform === input.platform)
        : allViews;
    const agents = [...new Set(platformViews.map((trace) => trace.agent))].sort();
    const views = input.agent && input.agent !== 'all'
        ? platformViews.filter((trace) => trace.agent === input.agent)
        : platformViews;

    const faultViews = views.filter((trace) => trace.hasFault);
    const recoveredViews = faultViews.filter((trace) => trace.recovered);
    const unrecoveredViews = faultViews.filter((trace) => !trace.recovered);

    const trend = input.starts.map((start) => {
        const end = start + input.plan.step;
        return {
            label: bucketLabel(start, input.plan.gran),
            faults: faultViews.filter((trace) => {
                const ts = trace.detectedAt?.getTime() ?? trace.row.timestamp.getTime();
                return ts >= start && ts < end;
            }).length,
            recovered: recoveredViews.filter((trace) => {
                const ts = trace.recoveredAt?.getTime() ?? trace.detectedAt?.getTime() ?? trace.row.timestamp.getTime();
                return ts >= start && ts < end;
            }).length,
        };
    });

    const severityCounts = new Map(SEVERITIES.map((item) => [item.key, 0]));
    for (const trace of views) {
        const key = !trace.hasFault ? 'normal'
            : trace.maxSeverity && severityCounts.has(trace.maxSeverity) ? trace.maxSeverity : 'unlabeled';
        severityCounts.set(key, (severityCounts.get(key) || 0) + 1);
    }

    const modeMap = new Map<string, { total: number; recovered: number; unrecovered: number }>();
    for (const trace of faultViews) {
        const kinds = trace.kinds.length ? trace.kinds : ['unknown'];
        for (const kind of new Set(kinds)) {
            const current = modeMap.get(kind) || { total: 0, recovered: 0, unrecovered: 0 };
            current.total++;
            if (trace.recovered) current.recovered++; else current.unrecovered++;
            modeMap.set(kind, current);
        }
    }
    const modes = topN(
        [...modeMap].map(([kind, counts]) => ({ kind, ...counts })),
        (item) => item.total,
    );

    const agentMap = new Map<string, { name: string; platform: string; traces: number; faults: number; recovered: number }>();
    for (const trace of views) {
        const key = `${trace.platform}\u001f${trace.agent}`;
        const current = agentMap.get(key) || { name: trace.agent, platform: trace.platform, traces: 0, faults: 0, recovered: 0 };
        current.traces++;
        if (trace.hasFault) current.faults++;
        if (trace.recovered) current.recovered++;
        agentMap.set(key, current);
    }
    const agentRows = [...agentMap.values()].map((item) => ({
        name: item.name, platform: item.platform, traces: item.traces, faults: item.faults,
        faultRate: roundPct(item.faults, item.traces),
        recoveryRate: roundPct(item.recovered, item.faults),
    })).sort((a, b) => b.faultRate - a.faultRate || b.traces - a.traces);

    const failureAgentMap = new Map<string, { total: number; fail: number }>();
    const errMap = new Map<string, number>();
    let withStats = 0;
    for (const trace of views) {
        const current = failureAgentMap.get(trace.agent) || { total: 0, fail: 0 };
        current.total++;
        if (!isSuccess(trace.row)) current.fail++;
        failureAgentMap.set(trace.agent, current);
        const stats = parseCallStats(trace.row.callStats);
        if (!stats) continue;
        withStats++;
        for (const [label, count] of Object.entries(stats.errTypes)) {
            errMap.set(label, (errMap.get(label) || 0) + count);
        }
    }
    const failAgents = topN(
        [...failureAgentMap].map(([name, counts]) => ({
            name, ...counts, errorRate: roundPct(counts.fail, counts.total),
        })),
        (item) => item.errorRate * 1000 + item.total,
    );
    const errTypes = {
        tool: topN([...errMap].filter(([key]) => !key.startsWith('judge:')).map(([label, count]) => ({ label, count })), (item) => item.count),
        judge: topN([...errMap].filter(([key]) => key.startsWith('judge:')).map(([label, count]) => ({ label: label.slice(6), count })), (item) => item.count),
    };

    const recentFaultTraces = [...faultViews]
        .sort((a, b) => b.latestAt.getTime() - a.latestAt.getTime())
        .slice(0, 20)
        .map((trace) => ({
            taskId: trace.taskId,
            executionId: trace.row.id,
            agent: trace.agent,
            platform: trace.platform,
            faultMode: (trace.kinds.length ? trace.kinds : ['unknown']).join('、'),
            recoveryStatus: trace.recovered ? 'recovered' as const : 'unrecovered' as const,
            ts: trace.latestAt.toISOString(),
        }));

    return {
        filters: { platforms, agents },
        kpi: {
            totalTraces: views.length,
            faultTraces: faultViews.length,
            faultRate: roundPct(faultViews.length, views.length),
            recoveredTraces: recoveredViews.length,
            recoveryRate: roundPct(recoveredViews.length, faultViews.length),
            unrecoveredTraces: unrecoveredViews.length,
        },
        trend,
        recovery: { recovered: recoveredViews.length, unrecovered: unrecoveredViews.length },
        severity: SEVERITIES.map((item) => ({ ...item, count: severityCounts.get(item.key) || 0 })),
        modes,
        agents: agentRows,
        failureSupplement: {
            failAgents, errTypes,
            callStatsCoverage: { withStats, total: views.length },
        },
        recentFaultTraces,
    };
}
