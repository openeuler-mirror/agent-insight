import { NextResponse } from 'next/server'

import type { BenchmarkEvaluationCompletion } from '../../../../../../../../packages/benchmark-protocol/src/evaluator-contracts'
import { benchmarkErrorResponse } from '@/lib/benchmark/api-error'
import { completeBenchmarkEvaluation } from '@/lib/benchmark/evaluation-callback-service'
import { authenticateBenchmarkEvaluator } from '@/lib/benchmark/evaluator-target'

export const dynamic = 'force-dynamic'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ evaluationId: string }> },
) {
  try {
    authenticateBenchmarkEvaluator(req)
    const { evaluationId } = await params
    const completion = await req.json() as BenchmarkEvaluationCompletion
    return NextResponse.json(await completeBenchmarkEvaluation({ evaluationId, completion }))
  } catch (error) {
    return benchmarkErrorResponse(error, 'benchmark/evaluations/complete')
  }
}
