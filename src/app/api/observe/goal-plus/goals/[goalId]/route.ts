import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { getGoalPlusGoal } from '@/lib/ingest/goal-plus/query';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ goalId: string }> }) {
  const url = new URL(request.url);
  const { username } = await resolveUser(request, url.searchParams.get('user'));
  if (!username) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const sourceId = url.searchParams.get('sourceId');
  if (!sourceId) return NextResponse.json({ error: 'sourceId is required' }, { status: 400 });
  const { goalId } = await context.params;
  const goal = await getGoalPlusGoal(username, sourceId, goalId);
  if (!goal) return NextResponse.json({ error: 'Goal Plus goal not found' }, { status: 404 });
  return NextResponse.json({ goal });
}
