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
    const sessionId = request.nextUrl.searchParams.get('sessionId') || undefined;
    const versionParam = request.nextUrl.searchParams.get('version');
    const baseVersion = versionParam == null ? undefined : Number(versionParam);
    if (versionParam !== null && (!Number.isInteger(baseVersion) || (baseVersion as number) < 0)) {
      return NextResponse.json({ error: 'Skill 版本不合法' }, { status: 400 });
    }
    const records = await listSkillOptimizationRecords({
      user: username,
      skillName: decodeURIComponent(name),
      baseVersion,
      sessionId,
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
