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
import { db } from '@/lib/storage/prisma';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const body = await request.json();
        const { isUploaded, user: explicitUser } = body;

        if (typeof isUploaded !== 'boolean') {
            return NextResponse.json({ error: 'isUploaded must be a boolean' }, { status: 400 });
        }

        const { username } = await resolveUser(request, explicitUser);

        const { allowed, skill } = await canAccessSkill(id, username);
        if (!skill) {
            return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
        }
        if (!allowed) {
            return NextResponse.json({ error: 'Unauthorized: You do not own this skill' }, { status: 403 });
        }

        const updatedSkill = await db.updateSkill(id, { isUploaded });

        return NextResponse.json({ success: true, skill: updatedSkill });
    } catch (error) {
        console.error('Toggle Upload Error:', error);
        return NextResponse.json({ error: 'Failed to update skill status' }, { status: 500 });
    }
}
