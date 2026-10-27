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
import { readSkillMarkdown } from '@/lib/fault-injection/engine'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
) {
  try {
    await resolveUser(req)
    const { name } = await ctx.params
    const skill = await readSkillMarkdown(decodeURIComponent(name))
    return NextResponse.json({
      name: skill.name,
      fault: skill.name,
      skill_name: skill.skillName,
      skillName: skill.skillName,
      injection_method: skill.injectionMethod,
      injectionMethod: skill.injectionMethod,
      path: skill.path,
      filename: skill.filename,
      content: skill.content,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 404 })
  }
}
