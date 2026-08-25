import { NextRequest, NextResponse } from 'next/server';

import { resolveUser } from '@/lib/auth/auth';
import { generateWorkbenchTriggerDataset } from '@/lib/skill-workbench/experiment-service';

export async function POST(request: NextRequest, context: { params: Promise<{ name: string }> }) {
  try {
    const body = await request.json().catch(() => ({}));
    const { username } = await resolveUser(request, body.user);
    if (!username) return NextResponse.json({ error: '缺少用户信息' }, { status: 401 });
    const { name } = await context.params;
    const dataset = await generateWorkbenchTriggerDataset({
      user: username,
      skillName: decodeURIComponent(name),
      modelConfigId: typeof body.modelConfigId === 'string' ? body.modelConfigId : undefined,
    });
    if (!dataset) return NextResponse.json({ error: 'Skill 不存在或无访问权限' }, { status: 404 });
    return NextResponse.json({ dataset }, { status: 201 });
  } catch (error) {
    console.error('[skill-workbench trigger dataset POST] failed:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '生成触发数据集失败' }, { status: 500 });
  }
}
