import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { listGoalPlusSources } from '@/lib/ingest/goal-plus/query';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const { username } = await resolveUser(request, url.searchParams.get('user'));
  if (!username) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ sources: await listGoalPlusSources(username) });
}
