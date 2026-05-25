import { NextRequest, NextResponse } from 'next/server';
import archiver from 'archiver';
import { prismaRaw } from '@/lib/storage/prisma';
import { findSkillMd, fileContentToString, sanitizeForFilename } from '@/lib/skill-generator/skill-files';

export const dynamic = 'force-dynamic';

/**
 * Stream a .zip of the skill files attached to a skill-generator session.
 *
 * Why server-side instead of a client Blob:
 * - The user wanted a real .zip (not a flat .skill.json bundle), and zipping
 *   in the browser would mean shipping JSZip (~100KB) just for one feature.
 * - The vfs is already persisted to `skillGeneratorSession.files` at stream end,
 *   so we can build the archive from authoritative DB state and skip the
 *   client → server file roundtrip.
 *
 * Layout in the zip（扁平 —— 不再嵌 skill-name 文件夹）：
 *   SKILL.md
 *   scripts/...
 *   references/...
 * 用户解压 <skill-name>.zip 后直接得到 skill 内容。zip 的文件名已经携带
 * skill 名，不需要再在内部多一层同名文件夹（之前因为 SKILL.md 路径写死，
 * fallback 后 zip 变成了 skill.zip 套 <skill-name>/，是双重重复）。
 */
export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ sessionId: string }> }
) {
    const { sessionId } = await params;
    if (!sessionId) {
        return NextResponse.json({ error: 'sessionId required' }, { status: 400 });
    }

    const session = await (prismaRaw as any).skillGeneratorSession.findUnique({
        where: { id: sessionId },
    });
    if (!session) {
        return NextResponse.json({ error: 'session not found' }, { status: 404 });
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
        return NextResponse.json({ error: 'no files in session' }, { status: 404 });
    }

    // 走共享工具找 SKILL.md 与 skill 名：兼容嵌套和根布局，避免之前 fallback 成 "skill.zip" 的尴尬。
    const skillMd = findSkillMd(files);
    const skillName = sanitizeForFilename(skillMd?.name || 'skill');
    // 只把 skill 文件夹下的内容打进 zip——之外的散文件不属于 skill。
    // SKILL.md 在 /workspace/ 根下时，整棵 /workspace/ 都算。
    const skillFolderPrefix = skillMd?.folder ? `/workspace/${skillMd.folder}/` : '/workspace/';

    // Bridge archiver's Node-style EventEmitter stream into a Web ReadableStream
    // that Next.js can return. archive emits 'data' as Buffer chunks; we enqueue
    // them on demand and close the controller on 'end'.
    const archive = archiver('zip', { zlib: { level: 9 } });
    const stream = new ReadableStream({
        start(controller) {
            archive.on('data', (chunk) => controller.enqueue(chunk));
            archive.on('end', () => controller.close());
            archive.on('warning', (err) => {
                if ((err as any).code !== 'ENOENT') console.warn('[skill-download] archiver warning', err);
            });
            archive.on('error', (err) => controller.error(err));

            for (const [filePath, fileData] of entries) {
                if (!filePath.startsWith(skillFolderPrefix)) continue;
                const relPath = filePath.slice(skillFolderPrefix.length);
                if (!relPath) continue;
                archive.append(fileContentToString(fileData), { name: relPath });
            }
            archive.finalize().catch((err) => controller.error(err));
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${skillName}.zip"`,
            'Cache-Control': 'no-store',
        },
    });
}
