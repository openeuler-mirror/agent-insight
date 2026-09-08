// 单项重评：重置该行 pending 并同步单行执行，返回该行终态。
import { prisma } from '@/lib/storage/prisma';
import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import { retryResultRow } from '@/lib/engine/experiment/run-experiment';

export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; resultId: string }> },
) {
  try {
    const { id, resultId } = await params;
    const url = new URL(req.url);
    const { username } = await resolveUser(req, url.searchParams.get('user'));
    if (!username) {
      return NextResponse.json({ error: 'user is required' }, { status: 400 });
    }

    const experiment = await prisma.experiment.findFirst({where:{id,user:username},select:{scope:true}});
    if(experiment?.scope==='evaluation-harness') return NextResponse.json({error:'请创建新实验执行评估，保留历史结果'}, {status:409});
    const status = await retryResultRow(id, resultId, username);
    if (!status) {
      return NextResponse.json({ error: 'result not found' }, { status: 404 });
    }
    recordUsageEvent({ user: username, featureKey: 'experiments', eventKey: 'experiment.retry' });

    return NextResponse.json({ status });
  } catch (error) {
    console.error('[Experiment Retry Error]', error);
    return NextResponse.json({ error: 'Failed to retry evaluation' }, { status: 500 });
  }
}
