import { readRecords, type OutcomeSkillBreakdown, type RoutingSkillBreakdown } from '@/lib/storage/data-service';
import { db } from '@/lib/storage/prisma';
import { resolveUser } from '@/lib/auth/auth';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const skillName = searchParams.get('skill');
    const skillVersionParam = searchParams.get('skill_version'); // e.g., "v1"
    const limitStr = searchParams.get('limit');
    let limit = 10;

    const { username } = await resolveUser(request as any);

    // 如果提供了API key但找不到用户，返回空数组
    if (username === null && (request.headers.get('x-witty-api-key') || searchParams.get('apiKey'))) {
        return NextResponse.json([]);
    }

    if (!skillName) {
      return NextResponse.json({ error: 'Skill name is required' }, { status: 400 });
    }

    if (limitStr) {
        const parsed = parseInt(limitStr, 10);
        if (!isNaN(parsed) && parsed > 0) {
            limit = parsed;
        }
    }

    let targetVersion: number | undefined = undefined;
    
    if (skillVersionParam) {
        targetVersion = parseInt(skillVersionParam.replace(/^v/, ''), 10);
        if (isNaN(targetVersion)) {
            return NextResponse.json({ error: 'Invalid skill_version format' }, { status: 400 });
        }
    }

    const records = await readRecords(username || undefined);
    
    // Filter records
    const filtered = records.filter(r => {
        const focusedRouting = r.routing_evaluation?.skill_breakdown?.find((item: RoutingSkillBreakdown) => item.skill === skillName) || null;
        const focusedOutcome = r.outcome_evaluation?.skill_breakdown?.find((item: OutcomeSkillBreakdown) => item.skill === skillName) || null;
        const inList = r.skills?.some(s => s === skillName);
        const inSingle = r.skill === skillName;
        const relatedToSkill = Boolean(inList || inSingle || focusedRouting || focusedOutcome);
        if (!relatedToSkill) return false;

        // Skill Version Filter
        if (targetVersion !== undefined) {
            const candidateVersions = [
                focusedOutcome?.version,
                focusedRouting?.invoked_version,
                focusedRouting?.expected_version,
                r.skill === skillName ? r.skill_version : null,
            ].filter((value): value is number => typeof value === 'number');

            return candidateVersions.includes(targetVersion);
        }

        return true;
    });

    // Sort by timestamp descending (newest first)
    filtered.sort((a, b) => {
        const tA = new Date(a.timestamp || 0).getTime();
        const tB = new Date(b.timestamp || 0).getTime();
        return tB - tA;
    });

    const result = filtered.slice(0, limit).map(r => {
        // Construct display label
        const verStr = r.skill_version !== undefined ? `v${r.skill_version}` : '';
        const displayLabel = r.label || verStr;
        const routingFocus = r.routing_evaluation?.skill_breakdown?.find((item: RoutingSkillBreakdown) => item.skill === skillName) || null;
        const outcomeFocus = r.outcome_evaluation?.skill_breakdown?.find((item: OutcomeSkillBreakdown) => item.skill === skillName) || null;

        return {
            task_id: r.task_id,
            upload_id: r.upload_id,
            timestamp: r.timestamp,
            query: r.query,
            final_result: r.final_result,
            answer_score: r.answer_score,
            judgment_reason: r.judgment_reason,
            failures: r.failures || [],
            skill_issues: r.skill_issues || [],
            label: displayLabel || null,
            skill_version: r.skill_version,
            invoked_skills: r.invokedSkills || [],
            routing_evaluation: r.routing_evaluation || null,
            outcome_evaluation: r.outcome_evaluation || null,
            focused_routing: routingFocus,
            focused_outcome: outcomeFocus,
        };
    });

    return NextResponse.json(result);

  } catch (error) {
    console.error('Skill logs fetch error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
