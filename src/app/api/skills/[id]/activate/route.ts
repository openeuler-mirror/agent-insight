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
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import { db } from '@/lib/storage/prisma';
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

        const { username } = await resolveUser(request, explicitUser);

        const { allowed, skill } = await canAccessSkill(id, username);
        if (!skill) {
            return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
        }
        if (!allowed) {
            return NextResponse.json({ error: 'Unauthorized: You do not own this skill' }, { status: 403 });
        }

        console.log(`Activating skill ${id} to version ${version} (user: ${username || 'anonymous'})`);

        const skillWithVersions = await db.findSkillById(id);
        const sv = skillWithVersions?.versions?.find((v: any) => v.version === Number(version));

        if (!sv) {
            console.error(`Activate Error: Version ${version} not found for skill ${id}`);
            return NextResponse.json({ error: 'Version does not exist' }, { status: 404 });
        }

        const updatedSkill = await db.updateSkill(id, { activeVersion: Number(version) });

        console.log(`Success: Skill ${id} activeVersion set to ${updatedSkill.activeVersion}`);

        recordUsageEvent({ user: username, featureKey: 'skill', eventKey: 'skill.activate' });

        return NextResponse.json(updatedSkill);
    } catch (error: any) {
        console.error('Activate Exception:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
