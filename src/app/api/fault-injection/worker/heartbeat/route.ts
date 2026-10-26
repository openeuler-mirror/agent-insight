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
import { resolveWorkerCaller } from '@/lib/reliability/worker-dual-auth'
import {
  sweepStaleClaims,
  upsertWorkerHeartbeat,
} from '@/lib/fault-injection/worker-protocol'
import { clientIpFromRequest } from '@/lib/reliability/client-ip'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const caller = await resolveWorkerCaller(req)
    if (!caller) {
      return NextResponse.json({ error: 'API key or device credential required' }, { status: 401 })
    }
    const username = caller.username
    const body = await req.json()
    const workerId = caller.clientId || body.workerId
    if (!workerId || typeof workerId !== 'string') {
      return NextResponse.json({ error: 'workerId required' }, { status: 400 })
    }
    await sweepStaleClaims(username)
    const observedIp = clientIpFromRequest(req)
    const baseInventory =
      body.inventory && typeof body.inventory === 'object' && !Array.isArray(body.inventory)
        ? (body.inventory as Record<string, unknown>)
        : {}
    const inventory = {
      ...baseInventory,
      ...(typeof body.clientId === "string" ? { clientId: body.clientId } : {}),
      ...(observedIp ? { observedIp } : {}),
    }
    const worker = await upsertWorkerHeartbeat({
      user: username,
      workerId,
      hostname: body.hostname || null,
      version: body.version || null,
      inventory,
      busySlots: typeof body.busySlots === 'number' ? body.busySlots : 0,
    })
    return NextResponse.json({
      ok: true,
      workerId: worker.workerId,
      lastSeenAt: worker.lastSeenAt.toISOString(),
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
