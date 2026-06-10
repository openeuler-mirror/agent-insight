import { NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';
import { resolveUser } from '@/lib/auth/auth';
import { listObservedAgentNames, listObservedSkills } from '@/lib/storage/data-service';
import type { QualityAgentInfo } from '@/lib/engine/quality-monitoring/types';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    try {
        const { username } = await resolveUser(req);
        const url = new URL(req.url);
        const platform = url.searchParams.get('platform') || undefined;

        const names = await listObservedAgentNames(username ?? undefined);
        if (!names.length) return NextResponse.json({ agents: [], skills: [] });

        const skillFacet = await listObservedSkills(username ?? undefined).catch(() => [] as { name: string }[]);
        const skills = skillFacet.map((s: { name: string }) => s.name);

        const userScope = username ? { OR: [{ user: username }, { user: null }] } : {};

        // 富化（platform/ownership）+ 统计（traceCount/lastSeen）。无 groupBy，内存聚合（对齐 dashboard/stats）。
        const [registered, execs] = await Promise.all([
            prisma.registeredAgent.findMany({
                where: { ...userScope, ...(platform ? { platform } : {}) },
                select: { name: true, platform: true, agentOwnership: true },
            }),
            prisma.execution.findMany({
                where: { ...userScope, isSubagent: false, agentName: { in: names } },
                select: { agentName: true, timestamp: true },
            }),
        ]);

        type RegRow = { name: string; platform: string | null; agentOwnership: string | null };
        const regByName = new Map<string, RegRow>(
            (registered as RegRow[]).map((r) => [r.name, r]),
        );
        const countByName = new Map<string, number>();
        const lastByName = new Map<string, number>();
        for (const e of execs) {
            const name = e.agentName ?? '';
            if (!name) continue;
            countByName.set(name, (countByName.get(name) ?? 0) + 1);
            const ts = new Date(e.timestamp).getTime();
            if (!lastByName.has(name) || ts > (lastByName.get(name) as number)) lastByName.set(name, ts);
        }

        const agents: QualityAgentInfo[] = names
            .filter((n) => !platform || regByName.has(n))
            .map((name) => {
                const reg = regByName.get(name);
                return {
                    name,
                    platform: reg?.platform ?? null,
                    ownership: reg?.agentOwnership ?? null,
                    traceCount: countByName.get(name) ?? 0,
                    lastSeen: lastByName.has(name) ? new Date(lastByName.get(name) as number).toISOString() : null,
                };
            })
            .sort((a, b) => (b.traceCount ?? 0) - (a.traceCount ?? 0));

        return NextResponse.json({ agents, skills });
    } catch (error) {
        console.error('[Quality Agents Error]', error);
        return NextResponse.json({ error: 'Failed to list agents' }, { status: 500 });
    }
}
