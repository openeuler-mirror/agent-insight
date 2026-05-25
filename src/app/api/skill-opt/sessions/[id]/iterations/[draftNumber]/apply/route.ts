import { canAccessSkill, resolveUser } from '@/lib/auth/auth';
import { parseSkillFlow } from '@/lib/engine/observability/flow-parser';
import { runStaticEvaluation } from '@/lib/engine/skill-issues/static-evaluator';
import { findSkillMd } from '@/lib/skill-generator/skill-files';
import { db, prismaRaw } from '@/lib/storage/prisma';
import fs from 'fs';
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';

export const dynamic = 'force-dynamic';

function ensureDir(dirPath: string) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

/**
 * POST /api/skill-opt/sessions/[id]/iterations/[draftNumber]/apply
 *
 * 把一份草稿采纳为 skill 的新版本：
 *   1. 加载 session + 指定 iteration（按 draftNumber）
 *   2. 用 session.skillName + 当前 user 找 skill；写入 v{latest+1} 落盘 + DB
 *   3. 更新 skill.activeVersion 指向新版本
 *   4. 后台触发 flow parse + 静态评估（异步，不阻塞返回）
 *   5. 删掉本 session 所有 iterations（草稿历史清空）
 *
 * Body: { user?: string }
 */
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string; draftNumber: string }> }
) {
    try {
        const { id: sessionId, draftNumber: draftNumberStr } = await params;
        const draftNumber = Number(draftNumberStr);
        if (!Number.isInteger(draftNumber) || draftNumber <= 0) {
            return NextResponse.json({ error: 'Invalid draftNumber' }, { status: 400 });
        }

        const body = await request.json().catch(() => ({}));
        const authResult = await resolveUser(request, body.user || undefined);
        const user = authResult.username;

        const session = await (prismaRaw as any).skillOptSession.findUnique({
            where: { id: sessionId },
        });
        if (!session) {
            return NextResponse.json({ error: 'Session not found' }, { status: 404 });
        }

        const iteration = await (prismaRaw as any).skillOptIteration.findUnique({
            where: { sessionId_draftNumber: { sessionId, draftNumber } },
        });
        if (!iteration) {
            return NextResponse.json({ error: `Draft #${draftNumber} not found` }, { status: 404 });
        }

        // iteration.files 是相对路径 → 字符串的 map。findSkillMd 需要 /workspace/<rel>
        // 的 vfs 形态，所以包一层；落盘时再剥掉。
        let relFiles: Record<string, string> = {};
        try {
            const parsed = JSON.parse(iteration.files || '{}');
            if (parsed && typeof parsed === 'object') relFiles = parsed;
        } catch {
            return NextResponse.json({ error: 'Iteration files corrupted' }, { status: 500 });
        }
        const relPaths = Object.keys(relFiles);
        if (relPaths.length === 0) {
            return NextResponse.json({ error: 'Iteration has no files' }, { status: 400 });
        }

        const vfs: Record<string, { content: string }> = {};
        for (const [rel, content] of Object.entries(relFiles)) {
            vfs[`/workspace/${rel}`] = { content };
        }
        const skillMd = findSkillMd(vfs);
        if (!skillMd) {
            return NextResponse.json({ error: 'SKILL.md not found in iteration' }, { status: 400 });
        }

        const skill = await db.findSkill(session.skillName, user || null);
        if (!skill) {
            return NextResponse.json({ error: `Skill "${session.skillName}" not found` }, { status: 404 });
        }

        const { allowed } = await canAccessSkill(skill.id, user);
        if (!allowed) {
            return NextResponse.json({ error: 'Unauthorized: You do not own this skill' }, { status: 403 });
        }

        const lastVersion = await db.findLatestSkillVersion(skill.id);
        const nextVersionNum = lastVersion ? lastVersion.version + 1 : 0;

        const storageBase = path.join(
            process.cwd(),
            'data', 'storage', 'skills', skill.id, `v${nextVersionNum}`
        );
        ensureDir(storageBase);

        // skill 文件夹之外的散文件不算 skill 的一部分，跳过——避免污染发布产物。
        // skillMd.folder 是从 /workspace/<folder>/SKILL.md 抠的 folder 段，
        // 若 SKILL.md 直接在根（/workspace/SKILL.md）则为 null。
        const folderPrefix = skillMd.folder ? `${skillMd.folder}/` : '';
        const savedFilesList: string[] = [];
        for (const [rel, content] of Object.entries(relFiles)) {
            if (folderPrefix && !rel.startsWith(folderPrefix)) continue;
            const stripped = folderPrefix ? rel.slice(folderPrefix.length) : rel;
            if (!stripped) continue;
            const fullPath = path.join(storageBase, stripped);
            ensureDir(path.dirname(fullPath));
            fs.writeFileSync(fullPath, content, 'utf-8');
            savedFilesList.push(stripped);
        }

        const skillVersion = await db.createSkillVersion({
            skillId: skill.id,
            version: nextVersionNum,
            content: skillMd.content,
            assetPath: `data/storage/skills/${skill.id}/v${nextVersionNum}`,
            files: JSON.stringify(savedFilesList),
            changeLog: iteration.summary
                ? `Adopted from skill-opt draft #${draftNumber}`
                : `Adopted from skill-opt draft #${draftNumber} (no summary)`,
        });

        await db.updateSkill(skill.id, { activeVersion: nextVersionNum });

        parseSkillFlow(skillMd.content, skill.id, nextVersionNum, user || null)
            .then(result => {
                if (!result.success) {
                    console.warn(`[skill-opt apply] Flow parse failed for ${skill.name} v${nextVersionNum}: ${result.error}`);
                }
            })
            .catch(e => console.warn(`[skill-opt apply] Flow parse error:`, e));

        runStaticEvaluation({
            skillId: skill.id,
            version: nextVersionNum,
            user: user || null,
            trigger: 'auto-upload',
            enableL2: false,
        })
            .then(r => {
                if (r.status === 'skipped') {
                    console.log(`[skill-opt apply] Static eval skipped for ${skill.id} v${nextVersionNum}: ${r.skipReason}`);
                } else {
                    console.log(`[skill-opt apply] Static eval ${r.status} for ${skill.id} v${nextVersionNum}: ${r.issuesCount} issues`);
                }
            })
            .catch(e => console.warn(`[skill-opt apply] Static eval error:`, e));

        // 清空 session 草稿历史。session/messages 保留，前端会跳走、回来时 iterations
        // 列表自然就是空——再次"开始优化"时从 #1 重新计数。
        await (prismaRaw as any).skillOptIteration.deleteMany({
            where: { sessionId },
        });

        return NextResponse.json({
            success: true,
            skill,
            version: skillVersion,
        });
    } catch (error: any) {
        console.error('[skill-opt apply] failed:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
