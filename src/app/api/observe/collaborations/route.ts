import { NextResponse } from 'next/server';

import { resolveUser } from '@/lib/auth/auth';
import { listCollaborations } from '@/lib/ingest/collaboration/query';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const { username } = await resolveUser(request, url.searchParams.get('user'));
  if (!username) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const limit = Number(url.searchParams.get('limit') || 50);
  const result = await listCollaborations(username, {
    limit: Number.isFinite(limit) ? limit : 50,
    cursor: url.searchParams.get('cursor') || undefined,
  });
  return NextResponse.json(result);
}
