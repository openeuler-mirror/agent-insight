import { resolveUser } from '@/lib/auth/auth';
import { db } from '@/lib/storage/prisma';
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const name = searchParams.get('name');
    const userParam = searchParams.get('user');

    if (!name) {
      return NextResponse.json({ error: 'Name parameter required' }, { status: 400 });
    }

    const { username: user } = await resolveUser(request, userParam);

    const where: any = {
      name: name
    };

    if (user) {
      where.OR = [
        { user: user },
        { user: null },
        { visibility: 'public' }
      ];
    }

    const skills = await db.findSkills(where);
    const skill = skills[0];

    if (!skill) {
      return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
    }

    return NextResponse.json({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      category: skill.category,
      activeVersion: skill.activeVersion || 0
    });
  } catch (error) {
    console.error('Find Skill By Name Error:', error);
    return NextResponse.json({ error: 'Failed to find skill' }, { status: 500 });
  }
}
