import { NextRequest } from 'next/server';
import { streamSkillGeneratorOpencode, createFileData } from '@/lib/skill-generator-opencode-bridge';
import fs from 'fs';
import path from 'path';
import { prismaRaw } from '@/lib/storage/prisma';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import { isUsageEnabled } from '@/lib/usage-analytics/config';
import { createBlockMirror } from '@/lib/chat/block-mirror';
import { createStreamCheckpointWriter } from '@/lib/chat/stream-checkpoint';
import {
    beginWorkbenchGenerationRun,
    finishWorkbenchGenerationRun,
} from '@/lib/skill-workbench/generation-service';

export const dynamic = 'force-dynamic';

function readMockDirectory(dirPath: string, rootPath: string, result: Record<string, any> = {}) {
    const items = fs.readdirSync(dirPath);
    for (const item of items) {
        const fullPath = path.join(dirPath, item);
        const relativePath = '/workspace/' + path.relative(rootPath, fullPath);
        
        if (fs.statSync(fullPath).isDirectory()) {
            readMockDirectory(fullPath, rootPath, result);
        } else {
            const content = fs.readFileSync(fullPath, 'utf-8');
            result[relativePath] = createFileData(content);
        }
    }
    return result;
}

function blockText(blocks: any[]) {
    return blocks.filter((block) => block.kind === 'text').map((block) => String(block.text || '')).join('');
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { message, user, threadId, files, modelId, webSearchEnabled, mock = true, runId } = body;

        if (!message || !user || !threadId) {
            return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400 });
        }

        const workbenchRun = await beginWorkbenchGenerationRun({
            user,
            generatorSessionId: threadId,
            runId: typeof runId === 'string' && runId.trim() ? runId.trim() : `${threadId}:${Date.now()}`,
        });
        if (workbenchRun?.kind === 'busy') {
            return new Response(JSON.stringify({ error: '当前会话已有生成任务正在执行', taskId: workbenchRun.taskId }), {
                status: 409,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        let agentMessage: { id: string };
        try {
            // 1. Save user message to DB
            await (prismaRaw as any).skillGeneratorMessage.create({
                data: {
                    sessionId: threadId,
                    role: 'user',
                    content: message
                }
            });

            // 用户消息已被接受 = 一次有效使用。首条算"发起生成"，后续算"继续对话"；
            // 流式 token 不在这里计（每次 POST 只走一遍）。
            if (isUsageEnabled()) {
                const priorUserMessages = await (prismaRaw as any).skillGeneratorMessage.count({
                    where: { sessionId: threadId, role: 'user' },
                });
                recordUsageEvent({
                    user,
                    featureKey: 'skill-generator',
                    eventKey: priorUserMessages <= 1 ? 'skill.generate.run' : 'skill.generate.message',
                });
            }

            // 1.5 Auto-update title if it's still 'New Chat'
            const session = await (prismaRaw as any).skillGeneratorSession.findUnique({ where: { id: threadId } });
            if (session && (session.title === 'New Chat' || !session.title)) {
                const newTitle = message.length > 30 ? message.substring(0, 27) + '...' : message;
                await (prismaRaw as any).skillGeneratorSession.update({
                    where: { id: threadId },
                    data: { title: newTitle }
                });
            }

            agentMessage = await (prismaRaw as any).skillGeneratorMessage.create({
                data: { sessionId: threadId, role: 'agent', content: '', blocks: '[]' },
                select: { id: true },
            });
        } catch (error) {
            if (workbenchRun) {
                await finishWorkbenchGenerationRun({
                    user,
                    workbenchSessionId: workbenchRun.workbenchSessionId,
                    taskId: workbenchRun.taskId,
                    error: error instanceof Error ? error.message : String(error),
                }).catch(() => undefined);
            }
            throw error;
        }

        const encoder = new TextEncoder();

        if (mock) {
            const readable = new ReadableStream({
                async start(controller) {
                    const mirror = createBlockMirror(controller, encoder);

                    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
                    let agentContent = '';
                    let blockSeq = 0;
                    let liveFiles: Record<string, any> = { ...(files || {}) };
                    const checkpoint = createStreamCheckpointWriter({
                        capture: () => ({
                            content: blockText(mirror.getBlocks()) || agentContent,
                            blocks: JSON.stringify(mirror.getBlocks()),
                            files: JSON.stringify(liveFiles),
                        }),
                        persist: (snapshot) => (prismaRaw as any).$transaction([
                            (prismaRaw as any).skillGeneratorMessage.update({
                                where: { id: agentMessage.id },
                                data: { content: snapshot.content, blocks: snapshot.blocks },
                            }),
                            (prismaRaw as any).skillGeneratorSession.update({
                                where: { id: threadId },
                                data: { files: snapshot.files },
                            }),
                        ]),
                        onError: (error) => console.warn('[skill-generator/chat] checkpoint failed:', error),
                    });
                    const send = (mode: string, payload: any) => {
                        if (mode === 'vfs_patch' && payload?.files) liveFiles = payload.files;
                        mirror.send(mode, payload);
                        checkpoint.schedule();
                    };
                    const nextId = (prefix: string) => `${prefix}_${Date.now()}_${++blockSeq}`;

                    // ── Phase 1: thinking — analyze user intent ─────────────
                    const thinkId1 = nextId('think');
                    const thinkText1 = `用户希望生成"${message}"相关的诊断技能包。\n我会先确定 Skill 名称与诊断场景，然后按 SKILL.md → scripts/ → references/ 的顺序逐步创建文件。`;
                    for (const ch of thinkText1) {
                        send("thinking", { id: thinkId1, delta: ch });
                        await sleep(15);
                    }
                    send("thinking", { id: thinkId1, done: true });
                    await sleep(300);

                    // ── Phase 2: short user-facing intro ────────────────────
                    const initialText = `好的，我会为你构建一个 **vmcore-analysis** 技能包，用于 Linux 内核崩溃转储分析。\n\n下面开始生成文件：`;
                    agentContent += initialText;
                    send("text", initialText);
                    await sleep(400);

                    // ── Phase 3: walk mock dir and emit tool_call/tool_result per file ──
                    const mockSourceDir = path.join(process.cwd(), 'src/mock/skills/vmcore-analysis-generate');
                    const mockFilesState = liveFiles;

                    const emitWriteFile = async (relativePath: string, content: string) => {
                        const toolId = nextId('tool');
                        send("tool_call", {
                            id: toolId,
                            name: 'write_file',
                            args: { path: relativePath, bytes: content.length },
                            status: 'running',
                        });
                        await sleep(250);
                        mockFilesState[relativePath] = createFileData(content);
                        send("vfs_patch", { files: { ...mockFilesState }, changed: [relativePath] });
                        send("tool_result", {
                            id: toolId,
                            status: 'ok',
                            summary: `已写入 ${relativePath}（${content.length} 字节）`,
                        });
                        await sleep(150);
                    };

                    if (fs.existsSync(mockSourceDir)) {
                        const items = fs.readdirSync(mockSourceDir);
                        for (const item of items) {
                            const fullPath = path.join(mockSourceDir, item);
                            const relativePath = '/workspace/' + item;

                            if (fs.statSync(fullPath).isDirectory()) {
                                // Insert a thinking note before scripts/ folder etc.
                                const thinkId = nextId('think');
                                const note = `接下来生成 ${item}/ 目录下的文件。`;
                                for (const ch of note) {
                                    send("thinking", { id: thinkId, delta: ch });
                                    await sleep(10);
                                }
                                send("thinking", { id: thinkId, done: true });
                                await sleep(150);

                                const subFiles = readMockDirectory(fullPath, mockSourceDir);
                                for (const [p, fd] of Object.entries(subFiles)) {
                                    const content = Array.isArray((fd as any).content)
                                        ? (fd as any).content.join('\n')
                                        : String((fd as any).content || '');
                                    await emitWriteFile(p, content);
                                }
                            } else {
                                const content = fs.readFileSync(fullPath, 'utf-8');
                                await emitWriteFile(relativePath, content);
                            }
                        }
                    }

                    // ── Phase 4: final summary + skill-card + download card ─
                    const skillCard = "\n\n:::skill-card\nname: vmcore-analysis\nsubtitle: Linux 内核崩溃转储分析\ndescription: 该技能包已完整生成。\nscripts: 8\ncommands: 50+\nscenarios: 12\n:::";
                    agentContent += skillCard;
                    send("text", skillCard);

                    // Compute aggregate size for the download card so users get a
                    // sense of the package weight before clicking.
                    const fileCount = Object.keys(mockFilesState).length;
                    const sizeBytes = Object.values(mockFilesState).reduce<number>((acc, fd: any) => {
                        const c = fd?.content;
                        const text = Array.isArray(c) ? c.join('\n') : String(c || '');
                        return acc + text.length;
                    }, 0);
                    send("download", {
                        id: nextId('dl'),
                        skillName: 'vmcore-analysis',
                        fileCount,
                        sizeBytes,
                    });
                    send("done", { reason: 'completed' });

                    liveFiles = mockFilesState;
                    let checkpointError: string | null = null;
                    try {
                        await checkpoint.flush();
                    } catch (error) {
                        checkpointError = error instanceof Error ? error.message : String(error);
                    }

                    if (workbenchRun) {
                        await finishWorkbenchGenerationRun({
                            user,
                            workbenchSessionId: workbenchRun.workbenchSessionId,
                            taskId: workbenchRun.taskId,
                            error: checkpointError,
                        });
                    }

                    try { controller.close(); } catch { /* client disconnected */ }
                }
            });

            return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
        }

        // --- REAL AGENT MODE (opencode-backed) ---
        const readable = new ReadableStream({
            async start(controller) {
                // 复用 createBlockMirror：把发出的事件同步累积成 blocks[]，最后 JSON.stringify 入库。
                // 这样 page.tsx 通过 hydrateMessages 在历史 session 上能 1:1 还原 thinking/tool/download UI。
                const mirror = createBlockMirror(controller, encoder);
                let agentText = '';
                let finalFiles: any = { ...(files || {}) };
                let chatErr: Error | null = null;
                const checkpoint = createStreamCheckpointWriter({
                    capture: () => ({
                        content: blockText(mirror.getBlocks()) || agentText || (chatErr ? `[运行中断] ${chatErr.message}` : ''),
                        blocks: JSON.stringify(mirror.getBlocks()),
                        files: JSON.stringify(finalFiles),
                    }),
                    persist: (snapshot) => (prismaRaw as any).$transaction([
                        (prismaRaw as any).skillGeneratorMessage.update({
                            where: { id: agentMessage.id },
                            data: { content: snapshot.content, blocks: snapshot.blocks },
                        }),
                        (prismaRaw as any).skillGeneratorSession.update({
                            where: { id: threadId },
                            data: { files: snapshot.files },
                        }),
                    ]),
                    onError: (error) => console.warn('[skill-generator/chat] checkpoint failed:', error),
                });
                const send = (mode: string, payload: any) => {
                    if (mode === 'vfs_patch' && payload?.files) finalFiles = payload.files;
                    mirror.send(mode, payload);
                    checkpoint.schedule();
                };
                try {
                    const r = await streamSkillGeneratorOpencode({
                        user,
                        threadId,
                        message,
                        modelId,
                        webSearchEnabled: webSearchEnabled !== false,
                        send,
                    });
                    agentText = r.agentText;
                    finalFiles = r.files;
                } catch (err: any) {
                    chatErr = err instanceof Error ? err : new Error(String(err));
                    try { send('error', chatErr.message); } catch { /* controller closed */ }
                }

                try {
                    await checkpoint.flush();
                } catch (saveErr) {
                    console.error('[skill-generator/chat] persist agent message failed:', saveErr);
                    chatErr ||= saveErr instanceof Error ? saveErr : new Error(String(saveErr));
                }
                if (workbenchRun) {
                    await finishWorkbenchGenerationRun({
                        user,
                        workbenchSessionId: workbenchRun.workbenchSessionId,
                        taskId: workbenchRun.taskId,
                        error: chatErr?.message || null,
                    });
                }
                try { controller.close(); } catch { /* already closed */ }
            }
        });

        return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });

    } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}
