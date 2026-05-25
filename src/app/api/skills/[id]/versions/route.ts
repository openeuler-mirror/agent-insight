import { canAccessSkill, resolveUser } from '@/lib/auth/auth';
import { parseSkillFlow } from '@/lib/engine/observability/flow-parser';
import { runStaticEvaluation } from '@/lib/engine/skill-issues/static-evaluator';
import { db, prismaRaw } from '@/lib/storage/prisma';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const body = await request.json();
        const { content, changeLog, user: explicitUser } = body;

        if (!content) {
            return NextResponse.json({ error: 'Content is required' }, { status: 400 });
        }

        const { username } = await resolveUser(request, explicitUser);

        const { allowed, skill } = await canAccessSkill(id, username);
        if (!skill) {
            return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
        }
        if (!allowed) {
            return NextResponse.json({ error: 'Unauthorized: You do not own this skill' }, { status: 403 });
        }

        const latestVersion = await db.findLatestSkillVersion(id);

        const nextVersionNum = (latestVersion?.version || 0) + 1;

        const assetPath = latestVersion?.assetPath || '';
        const files = latestVersion?.files || '[]';

        const newVersion = await db.createSkillVersion({
            skillId: id,
            version: nextVersionNum,
            content,
            assetPath,
            files,
            changeLog: changeLog || `Updated v${nextVersionNum} via Editor`
        });

        parseSkillFlow(content, id, nextVersionNum, username || null)
            .then(result => {
                if (result.success) {
                    console.log(`[VersionCreate] Auto-parsed flow for skill ${id} v${nextVersionNum}`);
                } else {
                    console.warn(`[VersionCreate] Auto-parse flow failed for skill ${id} v${nextVersionNum}: ${result.error}`);
                }
            })
            .catch(e => console.warn(`[VersionCreate] Auto-parse flow error for skill ${id} v${nextVersionNum}:`, e));

        runStaticEvaluation({
            skillId: id,
            version: nextVersionNum,
            user: username || null,
            trigger: 'auto-upload',
            enableL2: false,
        })
            .then(r => {
                if (r.status === 'skipped') {
                    console.log(`[VersionCreate] Static eval skipped for skill ${id} v${nextVersionNum}: ${r.skipReason}`);
                } else {
                    console.log(`[VersionCreate] Static eval ${r.status} for skill ${id} v${nextVersionNum}: ${r.issuesCount} issues`);
                }
            })
            .catch(e => console.warn(`[VersionCreate] Static eval error for skill ${id} v${nextVersionNum}:`, e));

        return NextResponse.json(newVersion);

    } catch (error: any) {
        console.error('Create Version Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const skill = await db.findSkillById(id);
        if (!skill) {
            return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
        }

        const versions = skill.versions || [];

        // 取近 7d 的 Execution 用于 usage 聚合；近 14d 的 daily count 用于 trend sparkline。
        // Execution.skill 存的是 skill 名字（单字段），与 SkillVersion.version 一起定位某版本的调用。
        const now = Date.now();
        const since14d = new Date(now - 14 * 24 * 3600 * 1000);
        const since7d = new Date(now - 7 * 24 * 3600 * 1000);
        let execs: any[] = [];
        try {
            execs = await prismaRaw.execution.findMany({
                where: { skill: skill.name, timestamp: { gte: since14d } },
                select: {
                    id: true, taskId: true, timestamp: true, latency: true,
                    agentName: true, agentId: true, skillVersion: true,
                    query: true, finalResult: true,
                    isAnswerCorrect: true, isSkillCorrect: true,
                    failures: true,
                },
                orderBy: { timestamp: 'desc' },
                take: 800,
            });
        } catch (e) {
            // Execution 表查询失败不致命，降级返回空集合（例如 OpenGauss 适配器尚未完整支持 prismaRaw.execution）。
            console.warn('[Skill Versions] failed to load executions, falling back to empty:', (e as any)?.message);
        }

        const versionsList = versions.map((v: any) => {
            const versionExecs = execs.filter(e => e.skillVersion === v.version);
            const last7d = versionExecs.filter(e => new Date(e.timestamp).getTime() >= since7d.getTime());

            // 成功率：把 isAnswerCorrect/failures 缺失视为成功，仅 isAnswerCorrect === false 或 failures 非空判定失败。
            const isFailed = (e: any) => {
                if (e.isAnswerCorrect === false) return true;
                if (e.failures && e.failures !== '[]' && e.failures !== 'null') {
                    try { const arr = JSON.parse(e.failures); if (Array.isArray(arr) && arr.length > 0) return true; } catch { /* ignore */ }
                }
                return false;
            };
            const success = last7d.filter(e => !isFailed(e)).length;
            const successRate = last7d.length > 0 ? Number(((success / last7d.length) * 100).toFixed(1)) : null;

            // P95 延迟（毫秒）
            const latencies = last7d.map(e => e.latency).filter((x): x is number => typeof x === 'number');
            latencies.sort((a, b) => a - b);
            const p95 = latencies.length > 0
                ? Math.round(latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))])
                : null;

            const agentSet = new Set<string>();
            last7d.forEach(e => { if (e.agentName) agentSet.add(e.agentName); });

            // 14d daily trend
            const trend: number[] = [];
            for (let i = 13; i >= 0; i--) {
                const dayStart = new Date(now - i * 24 * 3600 * 1000);
                dayStart.setHours(0, 0, 0, 0);
                const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
                const count = versionExecs.filter(e => {
                    const t = new Date(e.timestamp).getTime();
                    return t >= dayStart.getTime() && t < dayEnd.getTime();
                }).length;
                trend.push(count);
            }

            return {
                id: v.id,
                version: v.version,
                semanticVersion: v.semanticVersion,
                changeLog: v.changeLog,
                createdAt: v.createdAt,
                author: skill.author || null,
                usage: {
                    calls7d: last7d.length,
                    agents: agentSet.size,
                    successRate,
                    p95Latency: p95,
                },
                trend,
                executions: versionExecs.slice(0, 30).map(e => ({
                    id: e.id,
                    taskId: e.taskId,
                    time: e.timestamp,
                    agent: e.agentName,
                    agentId: e.agentId,
                    status: isFailed(e) ? 'failure' : 'success',
                    latency: e.latency,
                    input: e.query,
                    output: e.finalResult,
                })),
            };
        });

        return NextResponse.json(versionsList);
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
