import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { EvaluatorSkillError } from './evaluator-skill-store';

export async function evaluatorSkillUser(request: Request, explicitUser?: string | null) {
  const { username } = await resolveUser(request, explicitUser || new URL(request.url).searchParams.get('user'));
  if (!username) throw new EvaluatorSkillError('user is required', 401);
  return username;
}

export function skillSourceOwner(request: Request) {
  const params = new URL(request.url).searchParams;
  if (!params.has('sourceOwner')) throw new EvaluatorSkillError('必须明确指定 Skill 来源');
  return params.get('sourceOwner') || null;
}

export function evaluatorSkillApi(operation: () => Promise<unknown>) {
  return operation().then(value => NextResponse.json(value, { headers: { 'Cache-Control': 'no-store' } })).catch((error: unknown) => {
    if (error instanceof EvaluatorSkillError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('[evaluator-skills]', error);
    return NextResponse.json({ error: 'Skill 文件处理失败，请检查文件或存储权限' }, { status: 500 });
  });
}
