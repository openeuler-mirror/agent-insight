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
