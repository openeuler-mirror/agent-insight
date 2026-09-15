// 单项重评：重置该行 pending 并同步单行执行，返回该行终态。
import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import { retryResultRow } from '@/lib/engine/experiment/run-experiment';
import { retryBenchmarkEvaluation } from '@/lib/benchmark/evaluation-preparation-service';
import { benchmarkErrorResponse } from '@/lib/benchmark/api-error';
import { prisma } from '@/lib/storage/prisma';

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

    const result = await prisma.experimentEvalResult.findFirst({
      where: { id: resultId, experimentId: id, case: { experiment: { user: username } } },
      select: { evaluatorId: true },
    });
    if (result?.evaluatorId.startsWith('benchmark:')) {
      const retry = await retryBenchmarkEvaluation({ experimentId: id, resultId, user: username });
      recordUsageEvent({ user: username, featureKey: 'experiments', eventKey: 'experiment.retry' });
      return NextResponse.json(retry, { status: 202 });
    }

    const status = await retryResultRow(id, resultId, username);
    if (!status) {
      return NextResponse.json({ error: 'result not found' }, { status: 404 });
    }
    recordUsageEvent({ user: username, featureKey: 'experiments', eventKey: 'experiment.retry' });

    return NextResponse.json({ status });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      return benchmarkErrorResponse(error, 'benchmark/evaluations/retry');
    }
    console.error('[Experiment Retry Error]', error);
    return NextResponse.json({ error: 'Failed to retry evaluation' }, { status: 500 });
  }
}
