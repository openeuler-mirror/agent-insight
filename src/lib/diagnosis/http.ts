import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { resolveUser } from '@/lib/auth/auth';
import { DiagnosisError } from './contracts';
import { prismaRaw } from '@/lib/storage/prisma';

export async function canAccessDiagnosisSession(request: Request, id: string) {
  if (!id.startsWith('diagnosis-')) return true;
  const { username } = await resolveUser(request);
  return Boolean(username && await prismaRaw.skillOptSession.findFirst({ where: { id, user: username }, select: { id: true } }));
}

export async function diagnosisUser(request: Request) {
  const { username } = await resolveUser(request);
  if (!username) throw new DiagnosisError('请登录后重试（需要有效 API Key）', 401);
  return username;
}
export async function diagnosisResponse(operation: () => Promise<unknown>, status = 200) {
  try { return NextResponse.json(await operation(), { status }); }
  catch (error) {
    if (error instanceof DiagnosisError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof ZodError || error instanceof SyntaxError) return NextResponse.json({ error: '请求参数不合法' }, { status: 400 });
    console.error('[diagnosis]', error);
    return NextResponse.json({ error: '诊断操作失败，请检查服务日志和数据库迁移状态' }, { status: 500 });
  }
}
