import { NextResponse } from 'next/server';

import { resolveUser } from '@/lib/auth/auth';
import { resolveCollaboration } from '@/lib/ingest/collaboration/resolve';

export async function POST(request: Request) {
  const { username } = await resolveUser(request);
  if (!username) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const collaborationId = typeof body.collaborationId === 'string' ? body.collaborationId : '';
  if (!collaborationId) return NextResponse.json({ error: 'collaborationId is required' }, { status: 400 });
  await resolveCollaboration(username, collaborationId);
  return NextResponse.json({ status: 'resolved', collaborationId });
}
