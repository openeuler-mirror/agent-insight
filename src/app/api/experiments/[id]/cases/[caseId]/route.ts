import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { deleteExperimentExecution } from '@/lib/engine/experiment/cancellation-service';
import { prisma } from '@/lib/storage/prisma';

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string; caseId: string }> }) {
  try {
    const { username } = await resolveUser(req, new URL(req.url).searchParams.get('user'));
    if (!username) return NextResponse.json({ error: 'user is required' }, { status: 400 });
    const { id, caseId } = await params;
    const cancellation = await deleteExperimentExecution(username, id, caseId);
    const experiment = await prisma.experiment.findUnique({ where: { id }, select: { deletedAt: true } });
    return NextResponse.json({ deleted: true, experimentDeleted: Boolean(experiment?.deletedAt), cancellation },
      { status: cancellation.status === 'completed' ? 200 : 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '删除失败' },
      { status: Number((error as { status?: number }).status) || 500 });
  }
}
