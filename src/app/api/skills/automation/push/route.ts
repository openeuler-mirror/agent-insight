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


import { db } from '@/lib/storage/prisma';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { name, version, user } = body;

        if (!name) {
            return NextResponse.json({ error: 'Missing skill name' }, { status: 400 });
        }

        if (!user) {
            return NextResponse.json({ error: 'Missing user' }, { status: 400 });
        }

        const skill = await db.findSkill(name, user);

        if (!skill) {
            return NextResponse.json({ error: `Skill '${name}' for user '${user}' not found` }, { status: 404 });
        }

        let targetVersion = version;

        if (targetVersion === undefined || targetVersion === null) {
            const sortedVersions = (skill.versions || []).sort((a: any, b: any) => b.version - a.version);
            if (sortedVersions.length > 0) {
                targetVersion = sortedVersions[0].version;
            } else {
                return NextResponse.json({ error: 'No versions available for this skill' }, { status: 400 });
            }
        }

        const versionRecord = (skill.versions || []).find((v: any) => v.version === targetVersion);
        if (!versionRecord) {
            return NextResponse.json({ error: `Version ${targetVersion} not found for skill '${name}'` }, { status: 404 });
        }

        const updated = await db.updateSkill(skill.id, {
            activeVersion: targetVersion,
            isUploaded: true
        });

        return NextResponse.json({
            success: true,
            activeVersion: updated.activeVersion,
            isUploaded: updated.isUploaded,
            message: `Skill '${name}' v${updated.activeVersion} activated and marked for sync.`
        });

    } catch (error: any) {
        console.error('Auto Push Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
