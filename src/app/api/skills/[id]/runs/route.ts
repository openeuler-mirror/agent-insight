import { canAccessSkill, resolveUser } from '@/lib/auth/auth';
import {
    readRecords,
    type ExecutionRecord,
    type OutcomeSkillBreakdown,
    type RoutingSkillBreakdown,
} from '@/lib/storage/data-service';
import { NextRequest, NextResponse } from 'next/server';

type RunStatus = 'success' | 'failed' | 'pending' | 'unknown';

interface RunItem {
    trace_id: string;
    agent: string | null;
    started_at: string | null;
    duration_ms: number | null;
    status: RunStatus;
    version: number | null;
    query: string | null;
}

function deriveStatus(r: ExecutionRecord): RunStatus {
    if (r.judgment_reason === '结果评估中...') return 'pending';
    if (r.is_answer_correct === false) return 'failed';
    if ((r.failures?.length ?? 0) > 0) return 'failed';
    if (r.is_answer_correct === true) return 'success';
    if (typeof r.answer_score === 'number') return r.answer_score >= 60 ? 'success' : 'failed';
    return 'unknown';
}

function pickInvokedVersion(r: ExecutionRecord, skillName: string): number | null {
    const fromInvoked = r.invokedSkills?.find(s => s.name === skillName)?.version;
    if (typeof fromInvoked === 'number') return fromInvoked;
    const fromInvoked2 = r.invoked_skills?.find(s => s.name === skillName)?.version;
    if (typeof fromInvoked2 === 'number') return fromInvoked2;
    const fromRouting = r.routing_evaluation?.skill_breakdown
        ?.find((item: RoutingSkillBreakdown) => item.skill === skillName)?.invoked_version;
    if (typeof fromRouting === 'number') return fromRouting;
    const fromOutcome = r.outcome_evaluation?.skill_breakdown
        ?.find((item: OutcomeSkillBreakdown) => item.skill === skillName)?.version;
    if (typeof fromOutcome === 'number') return fromOutcome;
    if (r.skill === skillName && typeof r.skill_version === 'number') return r.skill_version;
    return null;
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const { searchParams } = new URL(request.url);
        const versionParam = searchParams.get('version');
        const limitParam = searchParams.get('limit');
        const offsetParam = searchParams.get('offset');

        const { username } = await resolveUser(request);
        const { allowed, skill } = await canAccessSkill(id, username);
        if (!skill) {
            return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
        }
        if (!allowed) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
        }

        const skillName: string = skill.name;
        let targetVersion: number | undefined;
        if (versionParam) {
            const v = parseInt(versionParam.replace(/^v/, ''), 10);
            if (isNaN(v)) {
                return NextResponse.json({ error: 'Invalid version' }, { status: 400 });
            }
            targetVersion = v;
        }
        const limit = Math.max(1, Math.min(500, parseInt(limitParam || '50', 10) || 50));
        const offset = Math.max(0, parseInt(offsetParam || '0', 10) || 0);

        const records = await readRecords(username || undefined);

        const filtered = records.filter(r => {
            const inList = r.skills?.includes(skillName);
            const inSingle = r.skill === skillName;
            const inInvoked = r.invokedSkills?.some(s => s.name === skillName)
                || r.invoked_skills?.some(s => s.name === skillName);
            const inRouting = r.routing_evaluation?.skill_breakdown
                ?.some((item: RoutingSkillBreakdown) => item.skill === skillName);
            const inOutcome = r.outcome_evaluation?.skill_breakdown
                ?.some((item: OutcomeSkillBreakdown) => item.skill === skillName);
            if (!(inList || inSingle || inInvoked || inRouting || inOutcome)) return false;

            if (targetVersion !== undefined) {
                return pickInvokedVersion(r, skillName) === targetVersion;
            }
            return true;
        });

        filtered.sort((a, b) => {
            const tA = new Date(a.timestamp || 0).getTime();
            const tB = new Date(b.timestamp || 0).getTime();
            return tB - tA;
        });

        const total = filtered.length;
        const page = filtered.slice(offset, offset + limit);

        const items: RunItem[] = page.map(r => ({
            trace_id: (r.task_id || r.upload_id || '') as string,
            agent: r.agentName || r.agent || null,
            started_at: r.timestamp ? new Date(r.timestamp).toISOString() : null,
            duration_ms: typeof r.latency === 'number' ? r.latency : null,
            status: deriveStatus(r),
            version: pickInvokedVersion(r, skillName),
            query: r.query || null,
        }));

        return NextResponse.json({ total, items });
    } catch (error) {
        console.error('Skill runs fetch error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
