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
import { createEnvironmentPreparation, createReuseEnvironmentPreparation } from '@/lib/engine/experiment/environment-preparation'
import { reliabilityErrorResponse } from '@/lib/reliability/api-error'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const { username } = await resolveUser(req, new URL(req.url).searchParams.get('user'))
    if (!username) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    if (Number(req.headers.get('content-length') || 0) > 256 * 1024) return NextResponse.json({ error: '请求过大' }, { status: 413 })
    const body = await req.json()
    if (body && typeof body === 'object' && 'sourceExperimentId' in body) {
      return NextResponse.json(await createReuseEnvironmentPreparation(username, body), { status: 202 })
    }
    return NextResponse.json(await createEnvironmentPreparation(username, body), { status: 202 })
  } catch (error) { return reliabilityErrorResponse(error, 'experiments/environment-preparations') }
}
