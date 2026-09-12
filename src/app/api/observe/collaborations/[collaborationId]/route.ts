import { NextResponse } from 'next/server';

import { resolveUser } from '@/lib/auth/auth';
import { getCollaboration } from '@/lib/ingest/collaboration/query';
import { resolveCollaboration } from '@/lib/ingest/collaboration/resolve';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ collaborationId: string }> },
) {
  const url = new URL(request.url);
  const { username } = await resolveUser(request, url.searchParams.get('user'));
  if (!username) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { collaborationId } = await context.params;
  await resolveCollaboration(username, collaborationId);
  const collaboration = await getCollaboration(username, collaborationId);
  if (!collaboration) return NextResponse.json({ error: 'Collaboration not found' }, { status: 404 });
  return NextResponse.json({ collaboration });
}
