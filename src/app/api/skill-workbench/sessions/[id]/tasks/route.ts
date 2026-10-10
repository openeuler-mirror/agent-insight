import { NextRequest, NextResponse } from 'next/server';

import { resolveUser } from '@/lib/auth/auth';
import { isWorkbenchTaskType } from '@/lib/skill-workbench/domain';
import {
  createOrReuseSkillWorkbenchTask,
  listSkillWorkbenchTasks,
} from '@/lib/skill-workbench/task-service';

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
    const tasks = await listSkillWorkbenchTasks(username, id);
    if (!tasks) {
      return NextResponse.json({ error: 'session not found' }, { status: 404 });
    }
    return NextResponse.json({ tasks });
  } catch (error) {
    console.error('[skill-workbench tasks GET] failed:', error);
    return NextResponse.json({ error: 'Failed to load workbench tasks' }, { status: 500 });
  }
}

export async function POST(
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
    if (!isWorkbenchTaskType(body.type)) {
      return NextResponse.json({ error: 'invalid task type' }, { status: 400 });
    }
    const version = body.version == null ? null : Number(body.version);
    if (version != null && (!Number.isInteger(version) || version < 0)) {
      return NextResponse.json({ error: 'invalid version' }, { status: 400 });
    }
    const result = await createOrReuseSkillWorkbenchTask({
      user: username,
      sessionId: id,
      type: body.type,
      skillName: typeof body.skillName === 'string' ? body.skillName : null,
      version,
      targetRef: typeof body.targetRef === 'string' ? body.targetRef : null,
    });
    if (!result) {
      return NextResponse.json({ error: 'session not found' }, { status: 404 });
    }
    return NextResponse.json(result, { status: result.reused ? 200 : 201 });
  } catch (error) {
    console.error('[skill-workbench tasks POST] failed:', error);
    return NextResponse.json({ error: 'Failed to create workbench task' }, { status: 500 });
  }
}
