
import { resolveUser } from '@/lib/auth/auth';
import { db } from '@/lib/storage/prisma';
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
    try {
        const userParam = request.nextUrl.searchParams.get('user');
        const { username } = await resolveUser(request, userParam);
        const urlPrefix = process.env.NEXT_PUBLIC_URL_PREFIX || '';

        const where: any = { isUploaded: true };

        if (username) {
            where.OR = [
                { user: username },
                { user: null },
                { visibility: 'public' }
            ];
        }

        const skills = await db.findSkills(where);

        const manifest = [];

        for (const s of skills) {
            const activeVerNum = s.activeVersion || 0;
            const activeVersionInfo = s.versions?.find((v: any) => v.version === activeVerNum);

            if (activeVersionInfo) {
                manifest.push({
                    id: s.id,
                    name: s.name,
                    version: activeVerNum,
                    updatedAt: activeVersionInfo.createdAt?.toISOString?.() || activeVersionInfo.createdAt,
                    downloadUrl: `${urlPrefix}/api/skills/${s.id}/versions/${activeVerNum}/download`
                });
            }
        }

        console.log(`[Manifest] User: ${username || 'anonymous'}, Returning ${manifest.length} skills: ${manifest.map(m => m.name).join(', ')}`);
        return NextResponse.json({ skills: manifest });
    } catch (error) {
        console.error('[Manifest] Error:', error);
        return NextResponse.json({ error: 'Failed to generate manifest' }, { status: 500 });
    }
}
