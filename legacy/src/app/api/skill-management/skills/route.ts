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
  getManagedSkillVersionAsset,
  listManagedSkills,
  parseSkillManagementQuery,
} from '@/lib/skill-workbench/skill-management';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const { username } = await resolveUser(request, request.nextUrl.searchParams.get('user'));
    if (!username) return NextResponse.json({ error: '缺少用户信息' }, { status: 401 });

    const skillName = request.nextUrl.searchParams.get('name')?.trim();
    const versionParam = request.nextUrl.searchParams.get('version');
    if (skillName && versionParam != null) {
      const version = Number(versionParam);
      if (!Number.isInteger(version) || version < 0) {
        return NextResponse.json({ error: 'Skill 版本不合法' }, { status: 400 });
      }
      const asset = await getManagedSkillVersionAsset(username, skillName, version);
      if (!asset) return NextResponse.json({ error: 'Skill 或版本不存在，或无访问权限' }, { status: 404 });
      return NextResponse.json({ asset });
    }

    const query = parseSkillManagementQuery(request.nextUrl.searchParams);
    const result = await listManagedSkills(username, query);
    return NextResponse.json(result);
  } catch (error) {
    console.error('[skill-management skills GET] failed:', error);
    return NextResponse.json({ error: '加载 Skill 管理列表失败' }, { status: 500 });
  }
}
