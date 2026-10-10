import { NextRequest, NextResponse } from 'next/server';

import { resolveUser } from '@/lib/auth/auth';
import { isWorkbenchActiveView } from '@/lib/skill-workbench/domain';
import {
  getSkillWorkbenchSession,
  updateSkillWorkbenchSessionView,
} from '@/lib/skill-workbench/session-service';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { username } = await resolveUser(request, request.nextUrl.searchParams.get('user'));
    if (!username) {
      return NextResponse.json({ error: 'user is required' }, { status: 400 });
    }
    const session = await getSkillWorkbenchSession(username, id);
    if (!session) {
      return NextResponse.json({ error: 'session not found' }, { status: 404 });
    }
    return NextResponse.json({ session });
  } catch (error) {
    console.error('[skill-workbench session GET] failed:', error);
    return NextResponse.json({ error: 'Failed to load workbench session' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const { username } = await resolveUser(request, body.user);
    if (!username) {
      return NextResponse.json({ error: 'user is required' }, { status: 400 });
    }
    if (!isWorkbenchActiveView(body.activeView)) {
      return NextResponse.json({ error: 'invalid activeView' }, { status: 400 });
    }
    const session = await updateSkillWorkbenchSessionView({
      user: username,
      id,
      activeView: body.activeView,
    });
    if (!session) {
      return NextResponse.json({ error: 'session not found' }, { status: 404 });
    }
    return NextResponse.json({ session });
  } catch (error) {
    console.error('[skill-workbench session PATCH] failed:', error);
    return NextResponse.json({ error: 'Failed to update workbench session' }, { status: 500 });
  }
}
