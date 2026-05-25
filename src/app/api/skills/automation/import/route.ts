import { resolveUser } from '@/lib/auth/auth';
import { parseSkillFlow } from '@/lib/engine/observability/flow-parser';
import { db } from '@/lib/storage/prisma';
import fs from 'fs';
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';

function ensureDir(dirPath: string) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function copyFolderSync(from: string, to: string, filesList: string[], rootTo: string) {
    if (!fs.existsSync(to)) {
        fs.mkdirSync(to, { recursive: true });
    }

    const entries = fs.readdirSync(from, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(from, entry.name);
        const destPath = path.join(to, entry.name);

        if (entry.isDirectory()) {
            copyFolderSync(srcPath, destPath, filesList, rootTo);
        } else {
            fs.copyFileSync(srcPath, destPath);
            filesList.push(path.relative(rootTo, destPath));
        }
    }
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { path: localPath, user: explicitUser } = body;

        if (!localPath) {
            return NextResponse.json({ error: 'Missing path' }, { status: 400 });
        }

        // Resolve user: API Key header > explicit user field
        const authResult = await resolveUser(request, explicitUser || undefined);
        const user = authResult.username;

        if (!fs.existsSync(localPath)) {
            return NextResponse.json({ error: 'Path does not exist' }, { status: 404 });
        }

        const skillMdPath = path.join(localPath, 'SKILL.md');
        if (!fs.existsSync(skillMdPath)) {
            return NextResponse.json({ error: 'SKILL.md not found in path' }, { status: 400 });
        }

        const skillContent = fs.readFileSync(skillMdPath, 'utf8');
        let extractedName = path.basename(localPath);
        let extractedDesc = 'Imported via automation';

        const frontmatterRegex = /^---\s*([\s\S]*?)\s*---/;
        const match = skillContent.match(frontmatterRegex);

        if (match && match[1]) {
            const frontmatter = match[1];
            const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
            const descMatch = frontmatter.match(/^description:\s*(.+)$/m);

            if (nameMatch && nameMatch[1]) extractedName = nameMatch[1].trim();
            if (descMatch && descMatch[1]) extractedDesc = descMatch[1].trim();
        }

        let skill = await db.findSkill(extractedName, user);
        let nextVersionNum = 0;

        if (!skill) {
            skill = await db.createSkill({
                name: extractedName,
                user: user,
                description: extractedDesc,
                visibility: 'private',
                activeVersion: 0,
                isUploaded: false
            });
            nextVersionNum = 0;
        } else {
            const lastVersion = await db.findLatestSkillVersion(skill.id);
            nextVersionNum = lastVersion ? (lastVersion.version + 1) : 0;
        }

        const storageBase = path.join(process.cwd(), 'data', 'storage', 'skills', skill.id, `v${nextVersionNum}`);
        ensureDir(storageBase);

        const savedFilesList: string[] = [];
        copyFolderSync(localPath, storageBase, savedFilesList, storageBase);

        const skillVersion = await db.createSkillVersion({
            skillId: skill.id,
            version: nextVersionNum,
            content: skillContent,
            assetPath: `data/storage/skills/${skill.id}/v${nextVersionNum}`,
            files: JSON.stringify(savedFilesList),
            changeLog: `Auto-imported version ${nextVersionNum}`
        });

        await db.updateSkill(skill.id, { activeVersion: nextVersionNum });

        parseSkillFlow(skillContent, skill.id, nextVersionNum, user || null)
            .then(result => {
                if (result.success) {
                    console.log(`[AutoImport] Auto-parsed flow for skill ${skill.name} v${nextVersionNum}`);
                } else {
                    console.warn(`[AutoImport] Auto-parse flow failed for skill ${skill.name} v${nextVersionNum}: ${result.error}`);
                }
            })
            .catch(e => console.warn(`[AutoImport] Auto-parse flow error for skill ${skill.name} v${nextVersionNum}:`, e));

        return NextResponse.json({
            success: true,
            skill: { id: skill.id, name: skill.name },
            version: nextVersionNum,
            status: nextVersionNum === 0 ? 'created' : 'updated'
        });

    } catch (error: any) {
        console.error('Auto Import Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
