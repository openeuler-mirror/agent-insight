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
import { getLatestWorkerInventory } from '@/lib/fault-injection/worker-protocol'
import type { PlatformOption } from '@/lib/fault-injection/types'

export const dynamic = 'force-dynamic'

function asOptions(rows: unknown[]): PlatformOption[] {
  const out: PlatformOption[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const rec = row as Record<string, unknown>
    const id = String(rec.id || rec.name || '').trim()
    if (!id) continue
    out.push({ id, label: String(rec.label || rec.name || id) })
  }
  return out
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ platform: string }> },
) {
  const { username } = await resolveUser(req)
  const { platform } = await ctx.params
  const inv = await getLatestWorkerInventory(username, platform)
  if (!inv?.platformInventory) {
    return NextResponse.json(
      {
        error:
          'No online FI Worker inventory. Open「新建注入任务」and run the account-bound setup command on this machine.',
        platform,
        agents: [],
        default: null,
        source: 'worker_missing',
      },
      { status: 503 },
    )
  }
  const agents = asOptions(
    Array.isArray(inv.platformInventory.agents) ? inv.platformInventory.agents : [],
  )
  if (!agents.length) {
    return NextResponse.json(
      {
        error: `Worker online but no agents for ${platform}`,
        platform,
        agents: [],
        default: null,
        source: 'worker',
        workerId: inv.workerId,
      },
      { status: 502 },
    )
  }
  return NextResponse.json({
    platform,
    agents,
    default: agents[0]?.id || null,
    source: 'worker',
    workerId: inv.workerId,
    lastSeenAt: inv.lastSeenAt.toISOString(),
  })
}
