import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { getGoalPlusRunTrace } from '@/lib/ingest/goal-plus/query';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  const url = new URL(request.url);
  const { username } = await resolveUser(request, url.searchParams.get('user'));
  if (!username) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const sourceId = url.searchParams.get('sourceId');
  if (!sourceId) return NextResponse.json({ error: 'sourceId is required' }, { status: 400 });
  const { runId } = await context.params;
  const trace = await getGoalPlusRunTrace(username, sourceId, runId);
  if (!trace) return NextResponse.json({ error: 'Goal Plus run not found' }, { status: 404 });
  return NextResponse.json({ trace });
}
