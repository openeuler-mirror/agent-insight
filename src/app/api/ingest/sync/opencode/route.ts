import { canAccessSkill, resolveUser } from '@/lib/auth/auth';
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
            const sourcePath = path.resolve(skillVersion.assetPath);

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
