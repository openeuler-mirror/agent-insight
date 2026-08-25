import { NextRequest, NextResponse } from 'next/server';

import { resolveUser } from '@/lib/auth/auth';
import {
  createSkillWorkbenchSession,
  listSkillWorkbenchSessions,
} from '@/lib/skill-workbench/session-service';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const { username } = await resolveUser(request, request.nextUrl.searchParams.get('user'));
    if (!username) {
      return NextResponse.json({ error: 'user is required' }, { status: 400 });
    }
    return NextResponse.json({ sessions: await listSkillWorkbenchSessions(username) });
  } catch (error) {
    console.error('[skill-workbench sessions GET] failed:', error);
    return NextResponse.json({ error: 'Failed to load workbench sessions' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { username } = await resolveUser(request, body.user);
    if (!username) {
      return NextResponse.json({ error: 'user is required' }, { status: 400 });
    }
    const session = await createSkillWorkbenchSession({
      user: username,
      title: typeof body.title === 'string' ? body.title : undefined,
    });
    return NextResponse.json({ session }, { status: 201 });
  } catch (error) {
    console.error('[skill-workbench sessions POST] failed:', error);
    return NextResponse.json({ error: 'Failed to create workbench session' }, { status: 500 });
  }
}
