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
import { createTaskWithRuns, refreshTaskProgress } from '@/lib/fault-injection/store'
import { normalizeFiWorkspaceInput } from '@/lib/fault-injection/workspace'

export const dynamic = 'force-dynamic'

export async function POST(
  req: Request,
  ctx: { params: Promise<{ taskId: string }> },
) {
  try {
    const { username } = await resolveUser(req)
    const { taskId } = await ctx.params
    const decoded = decodeURIComponent(taskId)
    const body = await req.json().catch(() => ({}))

    const source = await prisma.faultInjectionTask.findFirst({
      where: {
        OR: [{ taskKey: decoded }, { id: decoded }],
        ...(username ? { user: username } : {}),
      },
    })
    if (!source) return NextResponse.json({ error: 'not found' }, { status: 404 })

    const items = JSON.parse(source.itemsJson || '[]') as Array<{
      fault: string
      submode?: string | null
    }>
    const workspace = normalizeFiWorkspaceInput(source.workspace)
    const timeoutSeconds =
      typeof body.timeout_seconds === 'number'
        ? body.timeout_seconds
        : ((JSON.parse(source.requestJson || '{}') as { timeoutSeconds?: number })
            .timeoutSeconds ?? 180)

    const { task } = await createTaskWithRuns({
      user: source.user,
      name: `${source.name.replace(/\s*\(再次\)\s*$/, '')} (再次)`,
      platform: source.platform,
      agent: source.agent,
      prompt: source.prompt,
      workspace,
      model: source.model,
      timeoutSeconds,
      initialStatus: 'queued',
      items: items.map((item) => ({ fault: item.fault, submode: item.submode })),
    })

    const updated = await refreshTaskProgress(task.id)
    return NextResponse.json({
      task: {
        task_id: (updated || task).taskKey,
        id: (updated || task).id,
        name: (updated || task).name,
        status: (updated || task).status,
      },
      needsWorker: true,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
