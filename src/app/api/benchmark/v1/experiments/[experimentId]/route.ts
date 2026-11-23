/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
