import { NextResponse } from 'next/server'

import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'

export function benchmarkErrorResponse(error: unknown, source: string): NextResponse {
  if (error instanceof BenchmarkProtocolError) {
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          ...(error.details ? { details: error.details } : {}),
        },
      },
      { status: error.httpStatus },
    )
  }
  console.error(`[${source}]`, error)
  return NextResponse.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Benchmark 服务内部错误', retryable: false } },
    { status: 500 },
  )
}
