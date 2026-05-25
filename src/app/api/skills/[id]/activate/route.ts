
import { canAccessSkill, resolveUser } from '@/lib/auth/auth';
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
            console.error('Activate Error: Version missing in body', body);
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
        return NextResponse.json(updatedSkill);
    } catch (error: any) {
        console.error('Activate Exception:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
