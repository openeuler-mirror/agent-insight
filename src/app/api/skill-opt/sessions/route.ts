import { NextRequest, NextResponse } from 'next/server';
import { prismaRaw } from '@/lib/storage/prisma';

export const dynamic = 'force-dynamic';

/**
 * GET /api/skill-opt/sessions?user=&skillName=&baseVersion=
 *
 * 列出当前 (user, skillName, baseVersion) 维度下的所有会话，按 updatedAt 倒序。
 * 包含嵌套的 messages 和 iterations 让前端切回时一次拿完（skill-generator 同款）。
 *
 * skillName / baseVersion 是可选过滤——不传时按 user 列全部（用于"跨 skill 看历史"
 * 这种暂不做的功能预留参数；本期前端永远会带上）。
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const user = searchParams.get('user');
    const skillName = searchParams.get('skillName');
    const baseVersionStr = searchParams.get('baseVersion');

    if (!user) {
      return NextResponse.json({ error: 'user is required' }, { status: 400 });
    }

    const where: any = { user };
    if (skillName) where.skillName = skillName;
    if (baseVersionStr) where.baseVersion = parseInt(baseVersionStr, 10);

    const sessions = await (prismaRaw as any).skillOptSession.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        iterations: { orderBy: { draftNumber: 'asc' } },
      },
    });

    return NextResponse.json({ sessions });
  } catch (error: any) {
    console.error('[skill-opt sessions GET] failed:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * POST /api/skill-opt/sessions
 *
 * 创建新会话。skillName / baseVersion 必填——会话与某个 skill 的具体版本绑定。
 * 可选 initial messages（前端"新对话"时不传，让 chat 路由跑首条 message 时再插入）。
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { user, skillName, baseVersion, title, files, messages } = body;

    if (!user) return NextResponse.json({ error: 'user is required' }, { status: 400 });
    if (!skillName) return NextResponse.json({ error: 'skillName is required' }, { status: 400 });
    if (typeof baseVersion !== 'number') {
      return NextResponse.json({ error: 'baseVersion must be a number' }, { status: 400 });
    }

    const session = await (prismaRaw as any).skillOptSession.create({
      data: {
        user,
        skillName,
        baseVersion,
        title: title || '新对话',
        files: files ? JSON.stringify(files) : '{}',
        messages: {
          create: (messages || []).map((m: any) => ({
            role: m.role,
            content: m.content || '',
            blocks: m.blocks ? JSON.stringify(m.blocks) : '[]',
          })),
        },
      },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        iterations: { orderBy: { draftNumber: 'asc' } },
      },
    });

    return NextResponse.json({ session });
  } catch (error: any) {
    console.error('[skill-opt sessions POST] failed:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
