import { resolveUser } from '@/lib/auth/auth';
import { parseSkillFlow } from '@/lib/engine/observability/flow-parser';
import { runStaticEvaluation } from '@/lib/engine/skill-issues/static-evaluator';
import { db } from '@/lib/storage/prisma';
import fs from 'fs';
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';

// Helper: Ensure directory exists
function ensureDir(dirPath: string) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

export async function POST(request: NextRequest) {
    try {
        const formData = await request.formData();
        const files = formData.getAll('files') as File[];
        const paths = formData.getAll('paths') as string[];

        if (files.length === 0) {
            return NextResponse.json({ error: 'No files uploaded' }, { status: 400 });
        }

        let skillMdFile: File | null = null;
        let skillMdIndex = -1;

        for (let i = 0; i < files.length; i++) {
            if (paths[i].endsWith('SKILL.md')) {
                skillMdFile = files[i];
                skillMdIndex = i;
                break;
            }
        }

        if (!skillMdFile) {
            return NextResponse.json({ error: 'SKILL.md is missing' }, { status: 400 });
        }

        const skillContent = await skillMdFile.text();

        const folderPath = paths[skillMdIndex];
        const folderName = folderPath.includes('/') ? folderPath.split('/')[0] : 'uploaded-skill';
        
        let extractedName = folderName;
        let extractedDesc = 'Imported via upload';

        const frontmatterRegex = /^---\s*([\s\S]*?)\s*---/;
        const match = skillContent.match(frontmatterRegex);
        
        if (match && match[1]) {
            const frontmatter = match[1];
            const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
            const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
            
            if (nameMatch && nameMatch[1]) {
                extractedName = nameMatch[1].trim();
            }
            if (descMatch && descMatch[1]) {
                extractedDesc = descMatch[1].trim();
            }
        }

        let skill: any = null;

        const targetSkillId = formData.get('targetSkillId') as string;
        const explicitUser = formData.get('user') as string;

        // Resolve user: API Key header > explicit user field
        const authResult = await resolveUser(request, explicitUser || undefined);
        const user = authResult.username;

        if (targetSkillId) {
            skill = await db.findSkillById(targetSkillId);
            if (!skill) {
                return NextResponse.json({ error: 'Target skill not found' }, { status: 404 });
            }
            
            if (user && skill.user && skill.user !== user) {
                return NextResponse.json({ error: 'Unauthorized to update this skill' }, { status: 403 });
            }

            if (extractedName !== skill.name) {
                return NextResponse.json({
                    error: `Folder name mismatch! Expected: "${skill.name}", Found: "${extractedName}". Version updates must use the exact same folder name.`
                }, { status: 400 });
            }
        } else {
            skill = await db.findSkill(extractedName, user || null);

            if (skill) {
                return NextResponse.json({
                    error: `Skill '${extractedName}' 已经存在，请使用 版本管理 -> 上传新版本 功能更新。`
                }, { status: 400 });
            }

            skill = await db.createSkill({
                name: extractedName,
                description: extractedDesc,
                visibility: 'private',
                activeVersion: 0,
                user: user || null
            });
        }

        const lastVersion = await db.findLatestSkillVersion(skill.id);

        const nextVersionNum = lastVersion ? (lastVersion.version + 1) : 0;

        const storageBase = path.join(process.cwd(), 'data', 'storage', 'skills', skill.id, `v${nextVersionNum}`);
        ensureDir(storageBase);

        const savedFilesList: string[] = [];

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const relativePath = paths[i];
            const parts = relativePath.split('/');
            const cleanPath = parts.length > 1 ? parts.slice(1).join('/') : relativePath;

            if (!cleanPath) continue;

            const fullPath = path.join(storageBase, cleanPath);
            ensureDir(path.dirname(fullPath));

            const buffer = Buffer.from(await file.arrayBuffer());
            fs.writeFileSync(fullPath, buffer);
            savedFilesList.push(cleanPath);
        }

        const skillVersion = await db.createSkillVersion({
            skillId: skill.id,
            version: nextVersionNum,
            content: skillContent,
            assetPath: `data/storage/skills/${skill.id}/v${nextVersionNum}`,
            files: JSON.stringify(savedFilesList),
            changeLog: `Uploaded version ${nextVersionNum}`
        });

        await db.updateSkill(skill.id, { activeVersion: nextVersionNum });
        console.log(`[Upload] Set activeVersion to ${nextVersionNum} for skill ${skill.name}`);

        parseSkillFlow(skillContent, skill.id, nextVersionNum, user || null)
            .then(result => {
                if (result.success) {
                    console.log(`[Upload] Auto-parsed flow for skill ${skill.name} v${nextVersionNum}`);
                } else {
                    console.warn(`[Upload] Auto-parse flow failed for skill ${skill.name} v${nextVersionNum}: ${result.error}`);
                }
            })
            .catch(e => console.warn(`[Upload] Auto-parse flow error for skill ${skill.name} v${nextVersionNum}:`, e));

        runStaticEvaluation({
            skillId: skill.id,
            version: nextVersionNum,
            user: user || null,
            trigger: 'auto-upload',
            enableL2: false,
        })
            .then(r => {
                if (r.status === 'skipped') {
                    console.log(`[Upload] Static eval skipped for skill ${skill.name} v${nextVersionNum}: ${r.skipReason}`);
                } else {
                    console.log(`[Upload] Static eval ${r.status} for skill ${skill.name} v${nextVersionNum}: ${r.issuesCount} issues`);
                }
            })
            .catch(e => console.warn(`[Upload] Static eval error for skill ${skill.name} v${nextVersionNum}:`, e));

        return NextResponse.json({ success: true, skill, version: skillVersion });

    } catch (error: any) {
        console.error('Upload Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
