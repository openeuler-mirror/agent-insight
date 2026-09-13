import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { listGoalPlusGoals } from '@/lib/ingest/goal-plus/query';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const { username } = await resolveUser(request, url.searchParams.get('user'));
  if (!username) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ goals: await listGoalPlusGoals(username, url.searchParams.get('sourceId')) });
}
