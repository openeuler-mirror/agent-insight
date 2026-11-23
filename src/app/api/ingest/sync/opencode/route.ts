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
import { resolveRuntimeAssetPath } from '@/lib/env';
import { db } from '@/lib/storage/prisma';
import fs from 'fs';
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';

function copyRecursiveSync(src: string, dest: string) {
    const exists = fs.existsSync(src);
    const stats = exists && fs.statSync(src);
    const isDirectory = exists && stats && stats.isDirectory();

    if (isDirectory) {
        if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, { recursive: true });
        }
        fs.readdirSync(src).forEach((childItemName) => {
            copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
        });
    } else {
        if (!fs.existsSync(path.dirname(dest))) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
        }
        fs.copyFileSync(src, dest);
    }
}

export async function POST(request: NextRequest) {
    try {
        const { skillId, version, user: explicitUser } = await request.json();

        if (!skillId || !version) {
            return NextResponse.json({ error: 'Missing skillId or version' }, { status: 400 });
        }

        const { username } = await resolveUser(request, explicitUser);

        const { allowed, skill: skillCheck } = await canAccessSkill(skillId, username);
        if (!skillCheck) {
            return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
        }
        if (!allowed) {
            return NextResponse.json({ error: 'Unauthorized: Access denied' }, { status: 403 });
        }

        const skill = await db.findSkillById(skillId);
        const skillVersion = skill?.versions?.find((v: any) => v.version === parseInt(version));

        if (!skillVersion) {
            return NextResponse.json({ error: 'Version not found' }, { status: 404 });
        }

        const opencodeRoot = path.join(process.cwd(), 'opencode', 'skills');
        const skillName = skill.name;
        const targetDir = path.join(opencodeRoot, skillName);

        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        fs.writeFileSync(path.join(targetDir, 'SKILL.md'), skillVersion.content);

        if (skillVersion.assetPath) {
            const sourcePath = resolveRuntimeAssetPath(skillVersion.assetPath);

            if (fs.existsSync(sourcePath)) {
                const files = fs.readdirSync(sourcePath);
                for (const file of files) {
                    copyRecursiveSync(path.join(sourcePath, file), path.join(targetDir, file));
                }
            }
        }

        return NextResponse.json({ success: true, targetDir });

    } catch (error: any) {
        console.error('Sync Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
