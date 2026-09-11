import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { relinkGoalPlusSource } from '@/lib/ingest/goal-plus/correlate';
import { prismaRaw } from '@/lib/storage/prisma';

export async function POST(request: Request) {
  const { username } = await resolveUser(request);
  if (!username) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const sourceId = typeof body.sourceId === 'string' ? body.sourceId : '';
  if (!sourceId) return NextResponse.json({ error: 'sourceId is required' }, { status: 400 });
  const source = await prismaRaw.goalPlusSource.findUnique({
    where: { user_sourceId: { user: username, sourceId } },
    select: { id: true },
  });
  if (!source) return NextResponse.json({ error: 'Goal Plus source not found' }, { status: 404 });
  return NextResponse.json({ correlation: await relinkGoalPlusSource(source.id) });
}
