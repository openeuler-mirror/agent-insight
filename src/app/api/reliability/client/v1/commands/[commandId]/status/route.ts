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

import { reliabilityErrorResponse } from '@/lib/reliability/api-error'
import { authenticateDevice } from '@/lib/reliability/client-registry'
import { handleCommandStatus } from '@/lib/reliability/command-receipt'

export const dynamic = 'force-dynamic'

/** IF-N08：指令 ACK、进度与结果。请求体与 WSS COMMAND_STATUS 帧一致。 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ commandId: string }> },
) {
  try {
    const { clientId } = await authenticateDevice(req)
    const { commandId } = await ctx.params
    const body = await req.json().catch(() => ({}))

    await handleCommandStatus({
      clientId,
      commandId,
      status: body.status,
      occurredAt: body.occurredAt ? String(body.occurredAt) : undefined,
      result: body.result,
      error: body.error,
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    return reliabilityErrorResponse(error, 'reliability/commands/status')
  }
}
