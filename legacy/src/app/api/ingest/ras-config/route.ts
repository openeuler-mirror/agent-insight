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
import {
  isRasCapabilityPlatformId,
  toIngestPayload,
} from '@/lib/ingest/ras/capability-config'
import { getCapabilityEnvelope } from '@/lib/ingest/ras/capability-config-store'
import { noteCapabilityIngestPull } from '@/lib/reliability/client-config-service'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const { username, apiKey } = await resolveUser(req)
    if (apiKey && !username) {
      return NextResponse.json({ error: 'unauthorized', detail: 'invalid API key' }, { status: 401 })
    }
    if (!username && !process.env.AGENT_INSIGHT_DEFAULT_INGEST_USER) {
      return NextResponse.json(
        {
          error: 'unauthorized',
          detail: 'x-witty-api-key required (or set AGENT_INSIGHT_DEFAULT_INGEST_USER for local demo)',
        },
        { status: 401 },
      )
    }
    const effectiveUser = username || process.env.AGENT_INSIGHT_DEFAULT_INGEST_USER || null
    if (!effectiveUser) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }

    const url = new URL(req.url)
    const platform = url.searchParams.get('platform') || 'opencode'
    if (!isRasCapabilityPlatformId(platform)) {
      return NextResponse.json({ error: 'invalid_platform' }, { status: 400 })
    }

    const envelope = getCapabilityEnvelope(effectiveUser, platform)
    // 仅推进该 platform 的 delivery，避免多平台串扰。
    noteCapabilityIngestPull(effectiveUser, platform)
    return NextResponse.json({
      status: 'ok',
      ...toIngestPayload(envelope),
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[RAS ras-config] GET error:', message)
    return NextResponse.json({ status: 'error', message }, { status: 500 })
  }
}
