import { NextRequest } from 'next/server';
import { streamSkillGeneratorOpencode, createFileData } from '@/lib/skill-generator-opencode-bridge';
import fs from 'fs';
import path from 'path';
import { prismaRaw } from '@/lib/storage/prisma';

export const dynamic = 'force-dynamic';

/**
 * Mirrors every emitted SSE event into a server-side `blocks` array so the
 * full UI state (thinking / tool_call / tool_result / download blocks) can be
 * persisted to SkillGeneratorMessage.blocks and restored on page reload.
 *
 * The shape mirrors the frontend `Block` union in src/app/(main)/skill-generator/
 * page.tsx — keep them in sync if either side adds a new block kind.
 */
function createBlockMirror(controller: ReadableStreamDefaultController, encoder: TextEncoder) {
    const blocks: any[] = [];
    const send = (mode: string, payload: any) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ mode, payload })}\n\n`));

        if (mode === 'text') {
            const tail = blocks[blocks.length - 1];
            if (tail && tail.kind === 'text') tail.text += payload;
            else blocks.push({ kind: 'text', id: `text_${blocks.length}`, text: payload });
        } else if (mode === 'thinking') {
            const { id, delta, done } = payload || {};
            if (!id) return;
            const idx = blocks.findIndex((b: any) => b.kind === 'thinking' && b.id === id);
            if (idx === -1) blocks.push({ kind: 'thinking', id, text: delta || '', done: !!done });
            else {
                if (delta) blocks[idx].text += delta;
                if (done) blocks[idx].done = true;
            }
        } else if (mode === 'tool_call') {
            const { id, name, args, status } = payload || {};
            if (!id) return;
            blocks.push({ kind: 'tool', id, name, args, status: status || 'running' });
        } else if (mode === 'tool_result') {
            const { id, status, summary, error, finalArgs } = payload || {};
            if (!id) return;
            const idx = blocks.findIndex((b: any) => b.kind === 'tool' && b.id === id);
            if (idx !== -1) {
                if (status) blocks[idx].status = status;
                if (summary) blocks[idx].summary = summary;
                if (error) blocks[idx].error = error;
                // start phase 时 args 通常是空 {}，end phase bridge 会带上完整 input；
                // 用它覆盖 block.args 让 TodoBlock 等下游 args 依赖的渲染能正常工作。
                if (finalArgs && typeof finalArgs === 'object') {
                    blocks[idx].args = finalArgs;
                }
            }
        } else if (mode === 'download') {
            const { id, skillName, fileCount, sizeBytes } = payload || {};
            if (!id) return;
            blocks.push({ kind: 'download', id, skillName, fileCount, sizeBytes });
        } else if (mode === 'question') {
            // agent 提问 → 持久化为可恢复的 question block（pending 状态）
            const { id, question, choices } = payload || {};
            if (!id) return;
            blocks.push({ kind: 'question', id, question: question || '', choices, status: 'pending' });
        } else if (mode === 'question_answered') {
            // 答复回来 / 超时 / 跳过 → 更新对应 question block 的状态
            const { id, status, answer } = payload || {};
            if (!id) return;
            const idx = blocks.findIndex((b: any) => b.kind === 'question' && b.id === id);
            if (idx !== -1) {
                if (status) blocks[idx].status = status;
                if (answer !== undefined) blocks[idx].answer = answer;
            }
        }
        // 'vfs_patch' / 'done' / 'error' are runtime-only and not persisted.
    };
    return { send, getBlocks: () => blocks };
}

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

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { message, user, threadId, files, modelId, webSearchEnabled, mock = true } = body;

        if (!message || !user || !threadId) {
            return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400 });
        }

        // 1. Save user message to DB
        await (prismaRaw as any).skillGeneratorMessage.create({
            data: {
                sessionId: threadId,
                role: 'user',
                content: message
            }
        });

        // 1.5 Auto-update title if it's still 'New Chat'
        const session = await (prismaRaw as any).skillGeneratorSession.findUnique({ where: { id: threadId } });
        if (session && (session.title === 'New Chat' || !session.title)) {
            const newTitle = message.length > 30 ? message.substring(0, 27) + '...' : message;
            await (prismaRaw as any).skillGeneratorSession.update({
                where: { id: threadId },
                data: { title: newTitle }
            });
        }

        const encoder = new TextEncoder();

        if (mock) {
            const readable = new ReadableStream({
                async start(controller) {
                    const { send, getBlocks } = createBlockMirror(controller, encoder);

                    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
                    let agentContent = '';
                    let blockSeq = 0;
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
                    const mockFilesState: Record<string, any> = { ...files };

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

                    // 2. Save agent response (text + structured blocks) and final VFS.
                    //    blocks let us restore thinking/tool/download UI on reload.
                    await (prismaRaw as any).skillGeneratorMessage.create({
                        data: {
                            sessionId: threadId,
                            role: 'agent',
                            content: agentContent,
                            blocks: JSON.stringify(getBlocks()),
                        }
                    });
                    await (prismaRaw as any).skillGeneratorSession.update({
                        where: { id: threadId },
                        data: { files: JSON.stringify(mockFilesState) }
                    });

                    controller.close();
                }
            });

            return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
        }

        // --- REAL AGENT MODE (opencode-backed) ---
        const readable = new ReadableStream({
            async start(controller) {
                // 复用 createBlockMirror：把发出的事件同步累积成 blocks[]，最后 JSON.stringify 入库。
                // 这样 page.tsx 通过 hydrateMessages 在历史 session 上能 1:1 还原 thinking/tool/download UI。
                const { send, getBlocks } = createBlockMirror(controller, encoder);
                let agentText = '';
                let finalFiles: any = {};
                let chatErr: Error | null = null;
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

                // 即使 chat 中途 throw（如上游 fetch failed），也要把已经收到的 blocks 落库——
                // 否则 30min 跑出来的 thinking/tool_call/question 全丢，用户看不到任何记录。
                // agentText 没值时，从 blocks 里聚合 text kind 兜底，保证 message.content 不为空。
                try {
                    const blocks = getBlocks();
                    let content = agentText;
                    if (!content && blocks.length) {
                        content = blocks.filter((b: any) => b.kind === 'text').map((b: any) => b.text).join('');
                    }
                    if (chatErr && !content) content = `[运行中断] ${chatErr.message}`;
                    await (prismaRaw as any).skillGeneratorMessage.create({
                        data: {
                            sessionId: threadId,
                            role: 'agent',
                            content,
                            blocks: JSON.stringify(blocks),
                        }
                    });
                    await (prismaRaw as any).skillGeneratorSession.update({
                        where: { id: threadId },
                        data: { files: JSON.stringify(finalFiles) }
                    });
                } catch (saveErr) {
                    console.error('[skill-generator/chat] persist agent message failed:', saveErr);
                } finally {
                    try { controller.close(); } catch { /* already closed */ }
                }
            }
        });

        return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });

    } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}
