import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { prisma } from '@/lib/storage/prisma';

export async function GET(req: Request) {
  const { username } = await resolveUser(req, new URL(req.url).searchParams.get('user'));
  if (!username) return NextResponse.json({ error: 'user is required' }, { status: 400 });
  const cancellations = await prisma.experimentCancellation.findMany({
    where: { user: username, status: 'pending' }, orderBy: { updatedAt: 'desc' }, take: 100,
    select: { id: true, experimentId: true, caseKey: true, status: true, error: true, updatedAt: true },
  });
  return NextResponse.json({ cancellations });
}
