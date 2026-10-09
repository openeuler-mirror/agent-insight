import { NextResponse } from 'next/server'

import type { BenchmarkExecutionCompletion } from '../../../../../../../../packages/benchmark-protocol/src/executor-contracts'
import { BenchmarkProtocolError } from '../../../../../../../../packages/benchmark-protocol/src/errors'
import { benchmarkErrorResponse } from '@/lib/benchmark/api-error'
import { completeBenchmarkRun } from '@/lib/benchmark/run-callback-service'
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
    let completion: BenchmarkExecutionCompletion
    try {
      completion = await req.json() as BenchmarkExecutionCompletion
    } catch {
      throw new BenchmarkProtocolError('RUN_COMPLETION_JSON_INVALID', 'Run 终态不是合法 JSON', 400)
    }
    return NextResponse.json(await completeBenchmarkRun({
      runId,
      clientId: identity.clientId,
      completion,
    }))
  } catch (error) {
    return benchmarkErrorResponse(error, 'benchmark/runs/complete')
  }
}
