/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { withCoreControlRoute } from '@/lib/storage-core/control-route';
import { readCoreAnalytics, analyticsFailure } from '@/lib/storage-core/analytics';


import { NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';
import type { QualityAgentInfo } from '@/lib/engine/quality-monitoring/types';
import { isEvaluatorAgentName } from '@/lib/evaluator-agent';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    return withCoreControlRoute(req, () => agents(req), ['read']);
}

async function agents(req: Request) {
    try {
        const url = new URL(req.url);
        const analytics = (await readCoreAnalytics(req));
        const platform = url.searchParams.get('platform') || undefined;

        const names = [...new Set([...analytics.rows].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()).flatMap(row => {
            let observed: unknown = [];
            try { observed = row.observedAgents ? JSON.parse(row.observedAgents) : []; } catch { /* malformed legacy facet */ }
            return [row.agentName, ...(Array.isArray(observed) ? observed : [])].filter((name): name is string => typeof name === 'string' && !!name.trim() && !isEvaluatorAgentName(name)).map(name => name.trim());
        }))];
        if (!names.length) return NextResponse.json({ agents: [], skills: [] });

        const bindings = analytics.rows.flatMap(row => row.executionSkills.map(skill => skill.skillName));
        const skillFacet = [...new Set(bindings.length ? bindings : analytics.rows.map(row => row.skill).filter((name): name is string => !!name?.trim()).map(name => name.trim()))].sort((a, b) => a.localeCompare(b)).map(name => ({name}));
        const skills = skillFacet.map((s: { name: string }) => s.name);

        const userScope = {OR: [{user: analytics.username}, {user: null}]};

        // 富化（platform/ownership）+ 统计（traceCount/lastSeen）。无 groupBy，内存聚合（对齐 dashboard/stats）。
        const [registered, execs] = await Promise.all([
            prisma.registeredAgent.findMany({
                where: userScope,
                select: { name: true, platform: true, agentOwnership: true },
            }),
            analytics.findMany({
                where: { isSubagent: false, agentName: { in: names } },
                select: { agentName: true, timestamp: true },
            }),
        ]);

        type RegRow = { name: string; platform: string | null; agentOwnership: string | null };
        const regByName = new Map<string, RegRow>(
            (registered as RegRow[]).map((r) => [r.name, r]),
        );
        const countByName = new Map<string, number>();
        const lastByName = new Map<string, number>();
        const observedPlatform = new Map<string, string>();
        for (const row of [...analytics.rows].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())) {
            if (row.agentName && row.framework) observedPlatform.set(row.agentName, row.framework);
            if (row.framework) {
                let observed: unknown = [];
                try { observed = row.observedAgents ? JSON.parse(row.observedAgents) : []; } catch { /* malformed legacy facet */ }
                if (Array.isArray(observed)) for (const name of observed) if (typeof name === 'string' && name.trim()) observedPlatform.set(name.trim(), row.framework);
            }
        }
        for (const e of execs) {
            const name = e.agentName ?? '';
            if (!name) continue;
            countByName.set(name, (countByName.get(name) ?? 0) + 1);
            const ts = new Date(e.timestamp).getTime();
            if (!lastByName.has(name) || ts > (lastByName.get(name) as number)) lastByName.set(name, ts);
        }

        const agents: QualityAgentInfo[] = names
            .filter((n) => !platform || (regByName.has(n) ? regByName.get(n)?.platform === platform : observedPlatform.get(n) === platform))
            .map((name) => {
                const reg = regByName.get(name);
                return {
                    name,
                    platform: reg?.platform ?? observedPlatform.get(name) ?? null,
                    ownership: reg?.agentOwnership ?? null,
                    traceCount: countByName.get(name) ?? 0,
                    lastSeen: lastByName.has(name) ? new Date(lastByName.get(name) as number).toISOString() : null,
                };
            })
            .sort((a, b) => (b.traceCount ?? 0) - (a.traceCount ?? 0));

        await analytics.validate();
        return NextResponse.json({ agents, skills });
    } catch (error) {
        return analyticsFailure(error);
    }
}
