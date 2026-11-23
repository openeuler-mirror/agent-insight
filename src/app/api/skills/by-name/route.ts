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

import { resolveUser } from '@/lib/auth/auth';
import { db } from '@/lib/storage/prisma';
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const name = searchParams.get('name');
    const userParam = searchParams.get('user');

    if (!name) {
      return NextResponse.json({ error: 'Name parameter required' }, { status: 400 });
    }

    const { username: user } = await resolveUser(request, userParam);

    const where: any = {
      name: name
    };

    if (user) {
      where.OR = [
        { user: user },
        { user: null },
        { visibility: 'public' }
      ];
    }

    const skills = await db.findSkills(where);
    const skill = skills[0];

    if (!skill) {
      return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
    }

    return NextResponse.json({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      category: skill.category,
      activeVersion: skill.activeVersion || 0
    });
  } catch (error) {
    console.error('Find Skill By Name Error:', error);
    return NextResponse.json({ error: 'Failed to find skill' }, { status: 500 });
  }
}
