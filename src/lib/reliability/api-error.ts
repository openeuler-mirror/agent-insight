import { NextResponse } from 'next/server'

import { ReliabilityError } from '@/lib/reliability/client-registry'

/** 统一错误响应形状（需求文档 §10.1）。 */
export function reliabilityErrorResponse(error: unknown, scope: string) {
  if (error instanceof ReliabilityError) {
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      },
      { status: error.status },
    )
  }
  console.error(`[${scope}]`, error)
  return NextResponse.json(
    { error: { code: 'INTERNAL_ERROR', message: 'internal error' } },
    { status: 500 },
  )
}
