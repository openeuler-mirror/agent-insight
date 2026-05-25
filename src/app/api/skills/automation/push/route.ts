
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
