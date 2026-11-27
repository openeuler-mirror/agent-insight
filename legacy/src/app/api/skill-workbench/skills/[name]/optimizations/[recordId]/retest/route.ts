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
import { retestOptimizationCandidate, RetestError } from '@/lib/skill-workbench/retest-service';

export async function POST(request: NextRequest, context: { params: Promise<{ name: string; recordId: string }> }) {
  try {
    const body = await request.json();
    const { username } = await resolveUser(request, body.user);
    if (!username) return NextResponse.json({ error: '缺少用户信息' }, { status: 401 });
    const { name, recordId } = await context.params;
    const result = await retestOptimizationCandidate({ user: username, skillName: decodeURIComponent(name), recordId });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RetestError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('[skill-workbench retest POST] failed:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '候选复测失败' }, { status: 500 });
  }
}
