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
import { getRasCapabilityCatalog } from '@/lib/ingest/ras/catalog-engine'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    await resolveUser(req)
    const force = new URL(req.url).searchParams.get('force') === '1'
    const catalog = await getRasCapabilityCatalog({ force })
    if (catalog.kindLabels) {
      const { setAnomalyKindLabelOverrides } = await import('@/lib/ingest/ras/normalize')
      setAnomalyKindLabelOverrides(catalog.kindLabels)
    }
    return NextResponse.json({ status: 'ok', catalog })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[agent-ras/catalog] GET error:', message)
    return NextResponse.json({ error: 'server_error', message }, { status: 500 })
  }
}
