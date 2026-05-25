import { canAccessSkill, resolveUser } from '@/lib/auth/auth';
import { db } from '@/lib/storage/prisma';
import fs from 'fs';
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';

const MAX_TEXT_BYTES = 512 * 1024; // 512KB
const TEXT_EXT = new Set([
    '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.ini', '.csv', '.tsv',
    '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.sh', '.bash', '.zsh',
    '.go', '.rs', '.java', '.kt', '.rb', '.php', '.c', '.h', '.cc', '.cpp', '.hpp',
    '.html', '.htm', '.xml', '.css', '.scss', '.sql', '.env', '.dockerfile', '.lock',
    '.gitignore',
]);

function isLikelyText(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    if (TEXT_EXT.has(ext)) return true;
    if (path.basename(filePath).toUpperCase() === 'SKILL.MD') return true;
    return false;
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string; version: string; path: string[] }> }
) {
    try {
        const { id, version: versionStr, path: pathParts } = await params;
        const version = parseInt(versionStr, 10);
        if (isNaN(version)) {
            return NextResponse.json({ error: 'Invalid version' }, { status: 400 });
        }

        const { username } = await resolveUser(request);
        const { allowed, skill } = await canAccessSkill(id, username);
        if (!skill) return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
        if (!allowed) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

        const relPath = (pathParts || []).join('/');
        if (!relPath || relPath.includes('..') || relPath.startsWith('/')) {
            return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
        }

        // SKILL.md is stored in DB, not on disk.
        if (relPath.toUpperCase() === 'SKILL.MD') {
            const sv = await db.findSkillVersion(id, version);
            if (!sv) return NextResponse.json({ error: 'Version not found' }, { status: 404 });
            return NextResponse.json({
                path: 'SKILL.md',
                size: (sv.content || '').length,
                isText: true,
                content: sv.content || '',
            });
        }

        const sv = await db.findSkillVersion(id, version);
        if (!sv) return NextResponse.json({ error: 'Version not found' }, { status: 404 });

        let storageRoot = '';
        const assetPath = (sv as any).assetPath as string | undefined;
        if (assetPath) {
            const m = assetPath.match(/^data\/storage\/skills\/([^/]+)\/v(\d+)$/);
            if (m) {
                storageRoot = path.join(process.cwd(), 'data', 'storage', 'skills', m[1], `v${m[2]}`);
            }
        }
        if (!storageRoot) {
            storageRoot = path.join(process.cwd(), 'data', 'storage', 'skills', id, `v${version}`);
        }

        const fullPath = path.resolve(storageRoot, relPath);
        if (!fullPath.startsWith(path.resolve(storageRoot) + path.sep)) {
            return NextResponse.json({ error: 'Path traversal' }, { status: 400 });
        }
        if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
            return NextResponse.json({ error: 'File not found' }, { status: 404 });
        }

        const stat = fs.statSync(fullPath);
        const text = isLikelyText(relPath);

        if (!text) {
            return NextResponse.json({ path: relPath, size: stat.size, isText: false });
        }
        if (stat.size > MAX_TEXT_BYTES) {
            return NextResponse.json({ path: relPath, size: stat.size, isText: true, content: '', truncated: true });
        }
        const content = fs.readFileSync(fullPath, 'utf8');
        return NextResponse.json({ path: relPath, size: stat.size, isText: true, content });
    } catch (error: any) {
        console.error('[Skill file] error:', error);
        return NextResponse.json({ error: error?.message || 'Internal error' }, { status: 500 });
    }
}
