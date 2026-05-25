import { NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';
import { resolveUser } from '@/lib/auth/auth';

export const dynamic = 'force-dynamic';

function p95(values: number[]): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.ceil(sorted.length * 0.95) - 1;
    return sorted[Math.max(0, idx)];
}

type ExecRow = {
    agentName: string | null;
    latency: number | null;
    isAnswerCorrect: boolean | null;
    toolCallErrorCount: number | null;
    failures: string | null;
    cost: number | null;
    timestamp: Date;
};

function isSuccess(e: Pick<ExecRow, 'isAnswerCorrect' | 'toolCallErrorCount' | 'failures'>): boolean {
    if (e.isAnswerCorrect !== null) return e.isAnswerCorrect;
    if (e.toolCallErrorCount != null && e.toolCallErrorCount > 0) return false;
    if (e.failures) {
        try { const f = JSON.parse(e.failures); return !Array.isArray(f) || f.length === 0; } catch { /* ignore */ }
    }
    return true;
}

function timeAgo(ts: Date, now: Date): string {
    const mins = Math.floor((now.getTime() - new Date(ts).getTime()) / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return `${mins} 分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} 小时前`;
    return '昨天';
}

export async function GET(req: Request) {
    try {
        const { username } = await resolveUser(req);
        const userFilter = username ? { user: username } : {};

        const url = new URL(req.url);
        const platformParam = url.searchParams.get('platform') || '';
        const ownershipParam = url.searchParams.get('agentOwnership') || 'user';

        const now = new Date();
        const todayStart = new Date(now);
        todayStart.setHours(0, 0, 0, 0);

        const yesterdayStart = new Date(todayStart);
        yesterdayStart.setDate(yesterdayStart.getDate() - 1);

        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

        const sevenDaysAgo = new Date(todayStart);
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);

        // Build agent filter clause
        const agentWhere = {
            ...userFilter,
            ...(platformParam ? { platform: platformParam } : {}),
            ...(ownershipParam !== 'all' ? { agentOwnership: ownershipParam } : {}),
        };

        // ── Parallel fetches ───────────────────────────────────────────────
        // Fetch filtered agents + all agents (for available platforms), then executions
        const [agents, allAgentsForFilter] = await Promise.all([
            prisma.registeredAgent.findMany({
                where: agentWhere,
                orderBy: { createdAt: 'desc' },
            }),
            prisma.registeredAgent.findMany({
                where: userFilter,
                select: { platform: true },
            }),
        ]);

        // Available platforms for the filter bar (unfiltered by platform/ownership)
        const availablePlatforms = [...new Set(
            allAgentsForFilter.map((a: any) => a.platform).filter(Boolean)
        )].sort() as string[];

        // If agent-level filters are active, scope executions to matching agent names
        const agentFiltered = platformParam || ownershipParam !== 'all';
        const agentNames = agentFiltered ? agents.map((a: any) => a.name) : null;
        const execWhere = {
            ...userFilter,
            ...(agentNames ? { agentName: { in: agentNames } } : {}),
        };

        const [todayExecs, yesterdayCalls, lastHourExecs, sevenDaysExecs, recentExecs] =
            await Promise.all([
                prisma.execution.findMany({
                    where: { ...execWhere, timestamp: { gte: todayStart } },
                    select: {
                        agentName: true, latency: true, isAnswerCorrect: true,
                        toolCallErrorCount: true, failures: true, cost: true, timestamp: true,
                    },
                }),
                prisma.execution.count({
                    where: { ...execWhere, timestamp: { gte: yesterdayStart, lt: todayStart } },
                }),
                prisma.execution.findMany({
                    where: { ...execWhere, timestamp: { gte: oneHourAgo } },
                    select: { isAnswerCorrect: true, toolCallErrorCount: true, failures: true },
                }),
                prisma.execution.findMany({
                    where: { ...execWhere, timestamp: { gte: sevenDaysAgo } },
                    select: {
                        timestamp: true, isAnswerCorrect: true, toolCallErrorCount: true,
                        failures: true, agentName: true, latency: true,
                    },
                }),
                prisma.execution.findMany({
                    where: execWhere,
                    orderBy: { timestamp: 'desc' },
                    take: 5,
                    select: {
                        taskId: true, query: true, agentName: true,
                        skill: true, isAnswerCorrect: true, timestamp: true,
                    },
                }),
            ]);

        // ── Health snapshot ────────────────────────────────────────────────
        const todayCalls = todayExecs.length;
        const todayCost = todayExecs.reduce((s: number, e: any) => s + (e.cost ?? 0), 0);
        const todayLatencies = todayExecs
            .map((e: any) => e.latency)
            .filter((v: any): v is number => v != null && v > 0);

        const lastHourTotal = lastHourExecs.length;
        const lastHourSuccess = lastHourExecs.filter(isSuccess).length;
        const successRate1h = lastHourTotal > 0
            ? Math.round((lastHourSuccess / lastHourTotal) * 1000) / 10
            : null;

        // ── Per-agent stats ────────────────────────────────────────────────
        const agentExecMap = new Map<string, ExecRow[]>();
        const recentByAgent = new Map<string, Date>();

        for (const e of todayExecs) {
            const key = e.agentName?.trim() || '__unknown__';
            if (!agentExecMap.has(key)) agentExecMap.set(key, []);
            agentExecMap.get(key)!.push(e);
        }
        for (const e of sevenDaysExecs) {
            const key = e.agentName?.trim() || '__unknown__';
            const ts = new Date(e.timestamp);
            if (!recentByAgent.has(key) || ts > recentByAgent.get(key)!) {
                recentByAgent.set(key, ts);
            }
        }

        const enrichedAgents = agents.map((agent: any) => {
            const key = agent.name.trim();
            const execs = agentExecMap.get(key) || [];
            const calls = execs.length;
            const successCount = execs.filter(isSuccess).length;
            const successRate = calls > 0 ? (successCount / calls) * 100 : 100;
            const latencies = execs
                .map((e: any) => e.latency)
                .filter((v: any): v is number => v != null && v > 0);
            const agentP95 = p95(latencies);
            const lastExec = recentByAgent.get(key);
            const minutesSinceLast = lastExec
                ? (now.getTime() - lastExec.getTime()) / 60000
                : Infinity;

            let status: 'running' | 'idle' | 'error' = 'idle';
            if (calls > 0 && successRate < 90) status = 'error';
            else if (minutesSinceLast < 60) status = 'running';

            return {
                name: agent.name,
                platform: agent.platform,
                status,
                calls,
                successRate: Math.round(successRate * 10) / 10,
                p95ms: Math.round(agentP95),
            };
        });

        const onlineAgents = enrichedAgents.filter((a: any) => a.status !== 'idle').length;

        // ── 7-day trend ────────────────────────────────────────────────────
        const trend = Array.from({ length: 7 }, (_, i) => {
            const dayStart = new Date(todayStart);
            dayStart.setDate(dayStart.getDate() - (6 - i));
            const dayEnd = new Date(dayStart);
            dayEnd.setDate(dayEnd.getDate() + 1);

            const dayExecs = sevenDaysExecs.filter((e: any) => {
                const ts = new Date(e.timestamp);
                return ts >= dayStart && ts < dayEnd;
            });

            const total = dayExecs.length;
            const successful = dayExecs.filter(isSuccess).length;
            const successPct = total > 0
                ? Math.round((successful / total) * 1000) / 10
                : 0;

            return {
                day: `${dayStart.getMonth() + 1}/${dayStart.getDate()}`,
                calls: total,
                success: successPct,
            };
        });

        // ── Alerts ─────────────────────────────────────────────────────────
        const alerts: {
            id: number; level: string; agent: string;
            desc: string; href: string; cta: string;
        }[] = [];
        let alertId = 1;

        for (const a of enrichedAgents) {
            if (a.status === 'error') {
                const errorRate = (100 - a.successRate).toFixed(1);
                alerts.push({
                    id: alertId++,
                    level: 'error',
                    agent: a.name,
                    desc: `错误率 ${errorRate}%，今日 ${a.calls} 次调用`,
                    href: '/trace',
                    cta: '查看链路',
                });
            } else if (a.p95ms > 2000 && a.calls > 0) {
                alerts.push({
                    id: alertId++,
                    level: 'warn',
                    agent: a.name,
                    desc: `P95 时延 ${a.p95ms}ms，超过 2s 阈值`,
                    href: '/trace',
                    cta: '查看链路',
                });
            }
        }

        // ── Recent activity ────────────────────────────────────────────────
        const recent = recentExecs.map((e: any) => ({
            icon: e.isAnswerCorrect === false ? '❌' : '🔍',
            text: e.agentName
                ? `${e.agentName} 执行了任务${e.query ? `：${e.query.substring(0, 30)}` : ''}`
                : `链路记录：${(e.query || '(无query)').substring(0, 40)}`,
            time: timeAgo(e.timestamp, now),
            href: '/trace',
        }));

        return NextResponse.json({
            health: {
                totalAgents: agents.length,
                onlineAgents,
                todayCalls,
                yesterdayCalls,
                successRate1h,
                p95Latency: Math.round(p95(todayLatencies)),
                avgLatency: Math.round(
                    todayLatencies.length
                        ? todayLatencies.reduce((a: number, b: number) => a + b, 0) / todayLatencies.length
                        : 0
                ),
                todayCost,
            },
            trend,
            agents: enrichedAgents,
            alerts,
            recent,
            availablePlatforms,
        });
    } catch (error) {
        console.error('[Dashboard Stats Error]', error);
        return NextResponse.json({ error: 'Failed to load dashboard stats' }, { status: 500 });
    }
}
