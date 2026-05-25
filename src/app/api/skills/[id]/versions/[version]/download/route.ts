
import { canAccessSkill, resolveUser } from '@/lib/auth/auth';
import { db } from '@/lib/storage/prisma';
import archiver from 'archiver';
import fs from 'fs';
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { Readable } from 'stream';

export async function GET(
    request: NextRequest,
    props: { params: Promise<{ id: string; version: string }> }
) {
    const params = await props.params;
    const { id, version } = params;
    const versionNum = parseInt(version);

    if (isNaN(versionNum)) {
        return NextResponse.json({ error: 'Invalid version' }, { status: 400 });
    }

    try {
        const { username } = await resolveUser(request);

        const { allowed, skill } = await canAccessSkill(id, username);
        if (!skill) {
            return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
        }
        if (!allowed) {
            return NextResponse.json({ error: 'Unauthorized: Access denied' }, { status: 403 });
        }

        console.log(`[Download] Requested ID: ${id}, Version: ${version} (User: ${username || 'anonymous'})`);
        
        const skillWithVersions = await db.findSkillById(id);
        const skillVersion = skillWithVersions?.versions?.find((v: any) => v.version === versionNum);

        if (!skillVersion) {
            console.log('[Download] Version not found in DB');
            return NextResponse.json({ error: 'Version not found' }, { status: 404 });
        }
        console.log(`[Download] Found version. AssetPath: ${skillVersion.assetPath}`);

        const assetPath = skillVersion.assetPath;
        let storageRoot = '';
        if (assetPath && typeof assetPath === 'string') {
            const m = assetPath.match(/^data\/storage\/skills\/([^/]+)\/v(\d+)$/);
            if (m) {
                storageRoot = path.join(process.cwd(), 'data', 'storage', 'skills', m[1], `v${m[2]}`);
            }
        }
        if (!storageRoot) {
            storageRoot = path.join(process.cwd(), 'data', 'storage', 'skills', id, `v${versionNum}`);
        }

        const archive = archiver('zip', {
            zlib: { level: 9 }
        });

        const stream = new Readable({
            read() { }
        });

        archive.on('data', (chunk) => stream.push(chunk));
        archive.on('end', () => stream.push(null));
        archive.on('error', (err) => {
            console.error('Archive error:', err);
            stream.destroy(err);
        });

        if (storageRoot && fs.existsSync(storageRoot)) {
            const addDirectory = (dir: string, base: string) => {
                const files = fs.readdirSync(dir);
                for (const file of files) {
                    const fullPath = path.join(dir, file);
                    const relativePath = path.join(base, file);

                    if (fs.statSync(fullPath).isDirectory()) {
                        addDirectory(fullPath, relativePath);
                    } else {
                        if (file.toLowerCase() !== 'skill.md') {
                            archive.file(fullPath, { name: relativePath });
                        }
                    }
                }
            };
            addDirectory(storageRoot, '');
        }

        archive.append(skillVersion.content, { name: 'SKILL.md' });

        archive.finalize();

        const webStream = new ReadableStream({
            start(controller) {
                stream.on('data', chunk => controller.enqueue(chunk));
                stream.on('end', () => controller.close());
                stream.on('error', err => controller.error(err));
            }
        });

        return new Response(webStream, {
            headers: {
                'Content-Type': 'application/zip',
                'Content-Disposition': `attachment; filename="${skill.name}-v${versionNum}.zip"`
            }
        });

    } catch (error) {
        console.error('Download error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
