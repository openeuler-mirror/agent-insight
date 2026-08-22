import { NextRequest, NextResponse } from 'next/server';

import { resolveUser } from '@/lib/auth/auth';
import {
  getWorkbenchStaticEvaluation,
  getWorkbenchEvaluationOverview,
  runWorkbenchStaticEvaluation,
} from '@/lib/skill-workbench/evaluation-service';

function parseVersion(raw: string) {
  const version = Number(raw);
  return Number.isInteger(version) && version >= 0 ? version : null;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ name: string; version: string }> },
) {
  try {
    const { username } = await resolveUser(request, request.nextUrl.searchParams.get('user'));
    if (!username) return NextResponse.json({ error: '缺少用户信息' }, { status: 401 });
    const { name, version: rawVersion } = await context.params;
    const version = parseVersion(rawVersion);
    const sessionId = request.nextUrl.searchParams.get('sessionId');
    if (version === null) return NextResponse.json({ error: '版本不合法' }, { status: 400 });
    const overview = sessionId
      ? await getWorkbenchEvaluationOverview({
          user: username,
          sessionId,
          skillName: decodeURIComponent(name),
          version,
        })
      : await getWorkbenchStaticEvaluation({
          user: username,
          skillName: decodeURIComponent(name),
          version,
        });
    if (!overview) return NextResponse.json({ error: 'Skill 或版本不存在，或无访问权限' }, { status: 404 });
    return NextResponse.json(overview);
  } catch (error) {
    console.error('[skill-workbench evaluations GET] failed:', error);
    return NextResponse.json({ error: '加载静态评估失败' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ name: string; version: string }> },
) {
  try {
    const body = await request.json();
    const { username } = await resolveUser(request, body.user);
    if (!username) return NextResponse.json({ error: '缺少用户信息' }, { status: 401 });
    const { name, version: rawVersion } = await context.params;
    const version = parseVersion(rawVersion);
    const formalAsset = body.formalAsset === true;
    if (version === null || (!formalAsset && typeof body.sessionId !== 'string')) {
      return NextResponse.json({ error: '评估目标或版本不合法' }, { status: 400 });
    }
    const result = await runWorkbenchStaticEvaluation({
      user: username,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
      skillName: decodeURIComponent(name),
      version,
      force: body.force === true,
      formalAsset,
    });
    if (result.kind === 'invalid_context') {
      return NextResponse.json({ error: '工作台会话或工作版本已变化' }, { status: 409 });
    }
    if (result.kind === 'not_found') return NextResponse.json({ error: 'Skill 或版本不存在' }, { status: 404 });
    if (result.kind === 'running') return NextResponse.json(result, { status: 202 });
    return NextResponse.json(result);
  } catch (error) {
    console.error('[skill-workbench evaluations POST] failed:', error);
    return NextResponse.json({ error: '启动静态评估失败' }, { status: 500 });
  }
}
