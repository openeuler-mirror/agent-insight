import { NextResponse } from 'next/server'

import type { BenchmarkExecutionProgress } from '../../../../../../../../packages/benchmark-protocol/src/executor-contracts'
import { BenchmarkProtocolError } from '../../../../../../../../packages/benchmark-protocol/src/errors'
import { benchmarkErrorResponse } from '@/lib/benchmark/api-error'
import { recordBenchmarkRunProgress } from '@/lib/benchmark/run-callback-service'
import { authenticateDevice, ReliabilityError } from '@/lib/reliability/client-registry'

export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params
    let identity
    try {
      identity = await authenticateDevice(req)
    } catch (error) {
      if (error instanceof ReliabilityError) {
        throw new BenchmarkProtocolError(error.code, error.message, error.status)
      }
      throw error
    }
    let progress: BenchmarkExecutionProgress
    try {
      progress = await req.json() as BenchmarkExecutionProgress
    } catch {
      throw new BenchmarkProtocolError('PROGRESS_JSON_INVALID', '执行进度不是合法 JSON', 400)
    }
    return NextResponse.json(await recordBenchmarkRunProgress({
      runId,
      clientId: identity.clientId,
      progress,
    }))
  } catch (error) {
    return benchmarkErrorResponse(error, 'benchmark/runs/progress')
  }
}
