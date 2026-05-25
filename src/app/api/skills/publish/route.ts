import { resolveUser } from '@/lib/auth/auth';
import { parseSkillFlow } from '@/lib/engine/observability/flow-parser';
import { findSkillMd, fileContentToString } from '@/lib/skill-generator/skill-files';
import { db } from '@/lib/storage/prisma';
import { prismaRaw } from '@/lib/storage/prisma';
import fs from 'fs';
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';

function ensureDir(dirPath: string) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

/**
 * POST /api/skills/publish
 *
 * Publish the current skill-generator session as a skill (or new version of an existing skill).
 *
 * Body: { sessionId: string, user?: string }
 *
 * Rules:
 * - If skill name doesn't exist for the user → create new skill at version 0.
 * - If skill exists → auto-increment version (no error for existing skill).
 * - If the latest saved version has identical SKILL.md content → reject with 409
 *   ("already saved" — nothing changed).
 */
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { sessionId } = body;

        if (!sessionId) {
            return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
        }

        const authResult = await resolveUser(request, body.user || undefined);
        const user = authResult.username;

        // Load session files from DB
        const session = await (prismaRaw as any).skillGeneratorSession.findUnique({
            where: { id: sessionId },
        });
        if (!session) {
            return NextResponse.json({ error: 'Session not found' }, { status: 404 });
        }

        let files: Record<string, any> = {};
        try {
            const raw = session.files;
            files = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
        } catch {
            files = {};
        }

        const entries = Object.entries(files);
        if (entries.length === 0) {
            return NextResponse.json({ error: 'Session has no files' }, { status: 400 });
        }

        // 走共享工具找 SKILL.md：兼容 /workspace/SKILL.md 和 /workspace/<skill>/SKILL.md 两种布局。
        const skillMd = findSkillMd(files);
        if (!skillMd) {
            return NextResponse.json({ error: 'SKILL.md not found in session' }, { status: 400 });
        }
        const skillContent = skillMd.content;
        const extractedName = skillMd.name || 'untitled-skill';
        const extractedDesc = skillMd.description || 'Published from Playground';

        // Look up existing skill
        let skill = await db.findSkill(extractedName, user || null);

        if (skill) {
            // Check for duplicate: compare SKILL.md content with latest version
            const latestVersion = await db.findLatestSkillVersion(skill.id);
            if (latestVersion && latestVersion.content === skillContent) {
                return NextResponse.json(
                    { error: `Skill "${extractedName}" 当前版本内容未发生变化，无需重复保存。` },
                    { status: 409 }
                );
            }
        } else {
            // Create new skill
            skill = await db.createSkill({
                name: extractedName,
                description: extractedDesc,
                visibility: 'private',
                activeVersion: 0,
                user: user || null,
            });
        }

        // Determine next version number
        const lastVersion = await db.findLatestSkillVersion(skill.id);
        const nextVersionNum = lastVersion ? lastVersion.version + 1 : 0;

        const storageBase = path.join(
            process.cwd(),
            'data', 'storage', 'skills', skill.id, `v${nextVersionNum}`
        );
        ensureDir(storageBase);

        const savedFilesList: string[] = [];

        // 落盘要扁平化：deployer 期望 assetPath/SKILL.md、assetPath/scripts/...，
        // 不要再嵌一层 skill 文件夹。所以同时剥 /workspace/ 和 skillMd.folder。
        // skill 文件夹之外的散文件不算 skill 的一部分，跳过——避免污染发布产物。
        const skillFolderPrefix = skillMd.folder ? `/workspace/${skillMd.folder}/` : '/workspace/';
        for (const [filePath, fileData] of entries) {
            if (!filePath.startsWith(skillFolderPrefix)) continue;
            const relPath = filePath.slice(skillFolderPrefix.length);
            if (!relPath) continue;

            const content = fileContentToString(fileData);
            const fullPath = path.join(storageBase, relPath);
            ensureDir(path.dirname(fullPath));
            fs.writeFileSync(fullPath, content, 'utf-8');
            savedFilesList.push(relPath);
        }

        const skillVersion = await db.createSkillVersion({
            skillId: skill.id,
            version: nextVersionNum,
            content: skillContent,
            assetPath: `data/storage/skills/${skill.id}/v${nextVersionNum}`,
            files: JSON.stringify(savedFilesList),
            changeLog: `Published from Playground (v${nextVersionNum})`,
        });

        await db.updateSkill(skill.id, { activeVersion: nextVersionNum });

        parseSkillFlow(skillContent, skill.id, nextVersionNum, user || null)
            .then(result => {
                if (!result.success) {
                    console.warn(`[Publish] Flow parse failed for ${skill.name} v${nextVersionNum}: ${result.error}`);
                }
            })
            .catch(e => console.warn(`[Publish] Flow parse error:`, e));

        return NextResponse.json({
            success: true,
            skill,
            version: skillVersion,
            isNewSkill: lastVersion === null,
        });

    } catch (error: any) {
        console.error('[Publish] Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
