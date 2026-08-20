import { NextRequest, NextResponse } from 'next/server';

import { resolveUser } from '@/lib/auth/auth';
import {
  OPTIMIZATION_SOURCE_KINDS,
  createSkillOptimizationCandidate,
  listSkillOptimizationRecords,
  type OptimizationSourceKind,
} from '@/lib/skill-workbench/optimization-service';

function stringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((item) => typeof item === 'string');
}

export async function GET(request: NextRequest, context: { params: Promise<{ name: string }> }) {
  try {
    const { username } = await resolveUser(request, request.nextUrl.searchParams.get('user'));
    if (!username) return NextResponse.json({ error: '缺少用户信息' }, { status: 401 });
    const { name } = await context.params;
    const records = await listSkillOptimizationRecords({
      user: username,
      skillName: decodeURIComponent(name),
      sessionId: request.nextUrl.searchParams.get('sessionId') || undefined,
    });
    return NextResponse.json({ records });
  } catch (error) {
    console.error('[skill-workbench optimizations GET] failed:', error);
    return NextResponse.json({ error: '加载优化记录失败' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ name: string }> }) {
  try {
    const body = await request.json();
    const { username } = await resolveUser(request, body.user);
    if (!username) return NextResponse.json({ error: '缺少用户信息' }, { status: 401 });
    const { name } = await context.params;
    const skillName = decodeURIComponent(name);
    const sourceKind = body.sourceKind as OptimizationSourceKind;
    const baseVersion = Number(body.baseVersion);
    if (
      typeof body.sessionId !== 'string'
      || !Number.isInteger(baseVersion)
      || baseVersion < 0
      || !stringRecord(body.candidateFiles)
      || Object.keys(body.candidateFiles).length === 0
      || typeof body.summary !== 'string'
      || !OPTIMIZATION_SOURCE_KINDS.includes(sourceKind)
      || (body.diff !== undefined && !Array.isArray(body.diff))
      || (body.sourceRefs !== undefined && !Array.isArray(body.sourceRefs))
    ) {
      return NextResponse.json({ error: '候选参数不合法' }, { status: 400 });
    }

    const record = await createSkillOptimizationCandidate({
      user: username,
      sessionId: body.sessionId,
      skillName,
      baseVersion,
      candidateFiles: body.candidateFiles,
      summary: body.summary.trim().slice(0, 20_000),
      diff: body.diff,
      sourceKind,
      sourceRefs: body.sourceRefs,
      staticEvaluationId: typeof body.staticEvaluationId === 'string' ? body.staticEvaluationId : undefined,
      sourceExperimentId: typeof body.sourceExperimentId === 'string' ? body.sourceExperimentId : undefined,
    });
    if (!record) return NextResponse.json({ error: '会话工作版本已变化或无访问权限' }, { status: 409 });
    return NextResponse.json({ record }, { status: 201 });
  } catch (error) {
    console.error('[skill-workbench optimizations POST] failed:', error);
    return NextResponse.json({ error: '保存优化候选失败' }, { status: 500 });
  }
}
