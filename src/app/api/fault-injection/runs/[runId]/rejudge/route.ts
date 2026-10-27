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
import { prisma } from '@/lib/storage/prisma'
import { finishFiJudgeFromDb } from '@/lib/fault-injection/store'

export const dynamic = 'force-dynamic'

export async function POST(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { username } = await resolveUser(req)
  const { runId } = await ctx.params
  const run = await prisma.faultInjectionRun.findUnique({ where: { runId } })
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!run.sessionTaskId) {
    return NextResponse.json({ error: 'no session to rejudge' }, { status: 400 })
  }
  const updated = await finishFiJudgeFromDb({
    runId,
    user: username || run.user,
  })
  return NextResponse.json({
    run_id: updated.runId,
    status: updated.status,
    outcome: updated.outcome,
    fault_containment_status: updated.faultContainmentStatus,
    judge_reason: updated.judgeReason,
  })
}
