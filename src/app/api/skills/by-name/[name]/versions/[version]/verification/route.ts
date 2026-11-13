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
  EXTERNAL_VERIFICATION_RESULTS,
  recordExternalSkillVersionVerification,
  SkillVersionVerificationError,
} from '@/lib/skill-workbench/version-verification-service';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ name: string; version: string }> },
) {
  try {
    const body = await request.json();
    const { username } = await resolveUser(request, body.user);
    if (!username) return NextResponse.json({ error: '缺少用户信息' }, { status: 401 });
    const { name, version: rawVersion } = await context.params;
    const version = Number(rawVersion);
    if (!Number.isInteger(version) || version < 0) {
      return NextResponse.json({ error: 'Skill 版本不合法' }, { status: 400 });
    }
    if (!EXTERNAL_VERIFICATION_RESULTS.includes(body.result)) {
      return NextResponse.json({ error: '验证结果必须为 passed 或 failed' }, { status: 400 });
    }
    if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 2_000)) {
      return NextResponse.json({ error: '验证说明不能超过 2000 个字符' }, { status: 400 });
    }
    const result = await recordExternalSkillVersionVerification({
      user: username,
      skillName: decodeURIComponent(name),
      version,
      result: body.result,
      note: body.note,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof SkillVersionVerificationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[skill external verification POST] failed:', error);
    return NextResponse.json({ error: '登记外部验证结果失败' }, { status: 500 });
  }
}
