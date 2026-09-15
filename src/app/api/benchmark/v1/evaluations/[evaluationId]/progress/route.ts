import { NextResponse } from 'next/server'

import type { BenchmarkEvaluationProgress } from '../../../../../../../../packages/benchmark-protocol/src/evaluator-contracts'
import { benchmarkErrorResponse } from '@/lib/benchmark/api-error'
import { recordBenchmarkEvaluationProgress } from '@/lib/benchmark/evaluation-callback-service'
import { authenticateBenchmarkEvaluator } from '@/lib/benchmark/evaluator-target'

export const dynamic = 'force-dynamic'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ evaluationId: string }> },
) {
  try {
    authenticateBenchmarkEvaluator(req)
    const { evaluationId } = await params
    const progress = await req.json() as BenchmarkEvaluationProgress
    return NextResponse.json(await recordBenchmarkEvaluationProgress({ evaluationId, progress }))
  } catch (error) {
    return benchmarkErrorResponse(error, 'benchmark/evaluations/progress')
  }
}
