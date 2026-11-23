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

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const { username } = await resolveUser(req)
    const body = await req.json()
    const taskIds: string[] = Array.isArray(body.taskIds) ? body.taskIds : []
    if (!taskIds.length) {
      return NextResponse.json({ error: 'taskIds required' }, { status: 400 })
    }

    const tasks = await prisma.faultInjectionTask.findMany({
      where: {
        OR: [{ taskKey: { in: taskIds } }, { id: { in: taskIds } }],
        ...(username ? { user: username } : {}),
      },
    })

    let deleted = 0
    for (const task of tasks) {
      if (task.status === 'running') continue
      await prisma.faultInjectionRun.deleteMany({ where: { fiTaskId: task.id } })
      await prisma.faultInjectionTask.delete({ where: { id: task.id } })
      deleted += 1
    }

    return NextResponse.json({ ok: true, deleted })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
