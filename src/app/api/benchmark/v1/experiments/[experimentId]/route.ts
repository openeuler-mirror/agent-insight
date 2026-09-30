import { NextResponse } from 'next/server'

import { resolveUser } from '@/lib/auth/auth'
import { benchmarkErrorResponse } from '@/lib/benchmark/api-error'
import { getBenchmarkExperimentResult } from '@/lib/benchmark/experiment-result-service'
import { BenchmarkProtocolError } from '../../../../../../../packages/benchmark-protocol/src/errors'

export const dynamic = 'force-dynamic'

function positiveInteger(value: string | null, fallback: number, maximum: number): number {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new BenchmarkProtocolError('PAGINATION_INVALID', `分页参数必须是 1～${maximum} 的整数`, 400)
  }
  return parsed
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ experimentId: string }> },
) {
  try {
    const { experimentId } = await params
    const url = new URL(req.url)
    const { username } = await resolveUser(req, url.searchParams.get('user'))
    if (!username) {
      throw new BenchmarkProtocolError('USER_REQUIRED', '缺少用户身份', 401)
    }
    const page = positiveInteger(url.searchParams.get('page'), 1, 1_000_000)
    const pageSize = positiveInteger(url.searchParams.get('pageSize'), 20, 100)
    return NextResponse.json(await getBenchmarkExperimentResult({
      experimentId,
      user: username,
      page,
      pageSize,
      status: url.searchParams.get('status') || undefined,
      verdict: url.searchParams.get('verdict') || undefined,
    }))
  } catch (error) {
    return benchmarkErrorResponse(error, 'benchmark/experiments/detail')
  }
}
