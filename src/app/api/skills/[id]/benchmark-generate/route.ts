import { canAccessSkill, resolveUser } from '@/lib/auth/auth';
import { normalizeOptionalSkillVersion } from '@/lib/engine/evaluation/config-target';
import { generateBenchmarksForSkill } from '@/lib/engine/skill-generation/skill-benchmark-generator';
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const explicitUser = typeof body?.user === 'string' ? body.user : null;
    const includeRouting = body?.includeRouting !== false;
    const includeOutcome = body?.includeOutcome !== false;
    const routingCount = typeof body?.routingCount === 'number' ? body.routingCount : undefined;

    const { username } = await resolveUser(request, explicitUser);
    if (!username) {
      return NextResponse.json(
        { error: 'A scoped user with an active evaluation model is required to generate benchmarks' },
        { status: 400 },
      );
    }

    const { allowed, skill } = await canAccessSkill(id, username);
    if (!skill) {
      return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
    }
    if (!allowed) {
      return NextResponse.json({ error: 'Unauthorized: Access denied' }, { status: 403 });
    }

    const requestedVersion = normalizeOptionalSkillVersion(body?.version);
    const version = requestedVersion
      ?? normalizeOptionalSkillVersion(skill.activeVersion)
      ?? skill.versions?.[0]?.version
      ?? null;

    if (version == null) {
      return NextResponse.json({ error: 'Unable to resolve target skill version' }, { status: 400 });
    }

    const result = await generateBenchmarksForSkill({
      skill,
      version,
      user: username,
      includeRouting,
      includeOutcome,
      routingCount,
    });

    return NextResponse.json(result);
  } catch (error: any) {
    console.error('[BenchmarkGenerate] Failed to generate benchmarks:', error);
    return NextResponse.json({ error: error.message || 'Failed to generate benchmarks' }, { status: 500 });
  }
}
