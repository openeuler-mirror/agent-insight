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
