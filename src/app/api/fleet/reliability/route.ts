import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { bucketStarts, normalizeWindow, planOf } from '@/lib/fleet/agg';
import { aggregateFleetReliability, type ReliabilityEventRow, type ReliabilityExecutionRow } from '@/lib/fleet/reliability';
import { prisma } from '@/lib/storage/prisma';

export const dynamic = 'force-dynamic';

const TASK_ID_CHUNK = 400;

export async function GET(req: Request) {
    try {
        const url = new URL(req.url);
        const { username } = await resolveUser(req, url.searchParams.get('user'));
        const window = normalizeWindow(url.searchParams.get('window'));
        const plan = planOf(window);
        const now = new Date();
        const starts = bucketStarts(now, plan);
        const from = new Date(starts[0]);
        const userFilter = username ? { user: username } : {};

        const rows = (await prisma.execution.findMany({
            where: { ...userFilter, isSubagent: false, timestamp: { gte: from } },
            select: {
                id: true, taskId: true, timestamp: true, framework: true, agentName: true, query: true,
                toolCallErrorCount: true, failures: true, callStats: true,
            },
        })) as ReliabilityExecutionRow[];
        const taskIds = [...new Set(rows.map((row) => row.taskId || row.id))];
        const eventBatches: ReliabilityEventRow[][] = [];
        for (let offset = 0; offset < taskIds.length; offset += TASK_ID_CHUNK) {
            const chunk = taskIds.slice(offset, offset + TASK_ID_CHUNK);
            const events = await prisma.rasAnomalyEvent.findMany({
                where: {
                    taskId: { in: chunk },
                    ...(username ? { OR: [{ user: username }, { user: null }] } : {}),
                },
                orderBy: { ts: 'asc' },
                select: {
                    id: true, deliveryId: true, taskId: true, type: true, platform: true, framework: true,
                    anomalyKind: true, severity: true, summary: true, actionTypes: true, payloadJson: true, ts: true,
                },
            });
            eventBatches.push(events);
        }

        const data = aggregateFleetReliability({
            rows,
            events: eventBatches.flat(),
            starts,
            plan,
            platform: url.searchParams.get('platform'),
            agent: url.searchParams.get('agent'),
        });
        return NextResponse.json({ window, granularity: plan.gran, ...data });
    } catch (error) {
        console.error('[Fleet Reliability Error]', error);
        return NextResponse.json({ error: 'Failed to load fleet reliability' }, { status: 500 });
    }
}
