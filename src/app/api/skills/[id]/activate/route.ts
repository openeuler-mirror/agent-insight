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


import { canAccessSkill, resolveUser } from '@/lib/auth/auth';
import { activateVerifiedSkillVersion, SkillVersionVerificationError } from '@/lib/skill-workbench/version-verification-service';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(
    request: NextRequest,
    props: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await props.params;
        const body = await request.json();
        const { version, user: explicitUser } = body;

        if (version === undefined || version === null) {
            console.error('Activate Error: Version missing in body');
            return NextResponse.json({ error: 'Version is required' }, { status: 400 });
        }
        if (!Number.isInteger(Number(version)) || Number(version) < 0) {
            return NextResponse.json({ error: 'Version is invalid' }, { status: 400 });
        }

        const { username } = await resolveUser(request, explicitUser);

        if (!username) {
            return NextResponse.json({ error: '缺少用户信息' }, { status: 401 });
        }

        const { allowed, skill } = await canAccessSkill(id, username);
        if (!skill) {
            return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
        }
        if (!allowed) {
            return NextResponse.json({ error: 'Unauthorized: You do not own this skill' }, { status: 403 });
        }

        const result = await activateVerifiedSkillVersion({
            user: username,
            skillName: skill.name,
            version: Number(version),
        });
        return NextResponse.json(result.skill);
    } catch (error: any) {
        if (error instanceof SkillVersionVerificationError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        console.error('Activate Exception:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
