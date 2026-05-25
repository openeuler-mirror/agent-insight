import { NextRequest } from 'next/server';
import { streamSkillOptOpencode } from '@/lib/skill-opt-bridge';
import type { SkillOptIssueLite } from '@/lib/engine/general-agent/skill-opt-prompt';
import { prismaRaw } from '@/lib/storage/prisma';
import { createBlockMirror } from '@/lib/chat/block-mirror';

export const dynamic = 'force-dynamic';

/**
 * POST /api/skill-opt/chat
 *
 * SSE 接口，事件协议与 /api/skill-generator/chat 完全一致：
 *   text / thinking / tool_call / tool_result / vfs_patch / done / error
 *
 * 输入：
 *   {
 *     user: string;
 *     threadId: string;            // SkillOptSession.id；前端创建会话后传过来
 *     skillName: string;
 *     baseVersion: number;
 *     checkedIssues: SkillOptIssueLite[];
 *     userFeedback: string;
 *     modelId?: string;
 *     mock?: boolean;              // true → 回放固定脚本，不调 LLM
 *   }
 *
 * 持久化（skill-generator 同款）：
 *   - 进路由先把 user message 落 SkillOptMessage
 *   - title 是默认值时按首条 message 截 30 字自动改名
 *   - 用 createBlockMirror 镜像 SSE 事件，stream 结束时把 agent message + blocks JSON 入库
 *   - 最终 vfs 状态存到 SkillOptSession.files
 *
 * iteration（草稿）由前端在每次 turn 完成时单独 POST /sessions/[id]/iterations，
 * 不在这里搞——保持单一职责，chat 路由只管对话，iteration 路由管草稿快照。
 */
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const { user, threadId, skillName, baseVersion, checkedIssues, userFeedback, modelId, baselineFiles, mock } = body || {};

  const missing: string[] = [];
  if (!user) missing.push('user');
  if (!threadId) missing.push('threadId');
  if (!skillName) missing.push('skillName');
  if (typeof baseVersion !== 'number') missing.push('baseVersion');
  if (missing.length > 0) {
    return new Response(JSON.stringify({ error: `Missing fields: ${missing.join(', ')}` }), { status: 400 });
  }

  const issuesNormalized: SkillOptIssueLite[] = Array.isArray(checkedIssues)
    ? checkedIssues
        .filter((it: any) => it && typeof it.id === 'string' && typeof it.summary === 'string')
        .map((it: any) => ({
          id: String(it.id),
          severity: (['high', 'medium', 'low'] as const).includes(it.severity) ? it.severity : 'medium',
          category: typeof it.category === 'string' ? it.category : undefined,
          summary: String(it.summary),
          evidence: typeof it.evidence === 'string' ? it.evidence : undefined,
        }))
    : [];

  const feedback = typeof userFeedback === 'string' ? userFeedback : '';

  // baselineFiles 只接 string→string，剔掉非法值；体积上限 2MB（防滥用）
  const baselineFilesNormalized: Record<string, string> | undefined = (() => {
    if (!baselineFiles || typeof baselineFiles !== 'object') return undefined;
    const out: Record<string, string> = {};
    let totalBytes = 0;
    const MAX_BYTES = 2 * 1024 * 1024;
    for (const [k, v] of Object.entries(baselineFiles)) {
      if (typeof k !== 'string' || typeof v !== 'string') continue;
      totalBytes += v.length;
      if (totalBytes > MAX_BYTES) {
        console.warn('[skill-opt route] baselineFiles exceeded 2MB cap, truncating');
        break;
      }
      out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  })();

  const encoder = new TextEncoder();

  // ── 持久化前置：构造一条 user message 描述这次"开始优化"的请求。
  // 用 issues + feedback 拼，让会话历史回看时知道用户每次点了什么。
  const userMessageText = composeUserMessageText(issuesNormalized, feedback);

  // session 校验 + 落 user message + auto-title（skill-generator 同款逻辑，区别只是表名）
  let sessionExists = false;
  try {
    const session = await (prismaRaw as any).skillOptSession.findUnique({
      where: { id: threadId },
      select: { id: true, title: true },
    });
    sessionExists = !!session;
    if (sessionExists) {
      await (prismaRaw as any).skillOptMessage.create({
        data: { sessionId: threadId, role: 'user', content: userMessageText, blocks: '[]' },
      });
      // 默认 title 时用首条 user message 截 30 字（skill-generator 同款）
      if (session && (session.title === '新对话' || !session.title)) {
        const newTitle = userMessageText.length > 30 ? userMessageText.slice(0, 27) + '…' : userMessageText;
        if (newTitle.trim()) {
          await (prismaRaw as any).skillOptSession.update({
            where: { id: threadId },
            data: { title: newTitle },
          });
        }
      }
    }
  } catch (err: any) {
    // 落库失败不阻塞 chat（重启/迁移期间应该容错）；记日志即可
    console.warn('[skill-opt route] pre-stream persistence failed:', err?.message || err);
  }

  // ── mock 模式：固定脚本回放，不调 LLM。让前端在没有真实模型配置时也能联调 ──
  if (mock) {
    const readable = new ReadableStream({
      async start(controller) {
        const { send, getBlocks } = createBlockMirror(controller, encoder);
        let agentText = '';
        try {
          // 包一层把 send 投递的 text 也累计到 agentText（fallback content 列）
          const trackedSend = (mode: string, payload: any) => {
            if (mode === 'text' && typeof payload === 'string') agentText += payload;
            send(mode, payload);
          };
          await runMockScript({ skillName, baseVersion, issues: issuesNormalized, feedback, send: trackedSend });
          send('done', { reason: 'completed' });
        } catch (err: any) {
          try { send('error', err?.message || String(err)); } catch { /* closed */ }
        } finally {
          try { controller.close(); } catch { /* already closed */ }
        }

        // 落 agent message + blocks（mock 模式也存，方便前端调试历史）
        if (sessionExists) {
          try {
            await (prismaRaw as any).skillOptMessage.create({
              data: {
                sessionId: threadId,
                role: 'agent',
                content: agentText,
                blocks: JSON.stringify(getBlocks()),
              },
            });
          } catch (err: any) {
            console.warn('[skill-opt route] mock post-stream persistence failed:', err?.message || err);
          }
        }
      },
    });
    return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
  }

  // ── 真实模式：跑 opencode + runGeneralAgent ──
  const readable = new ReadableStream({
    async start(controller) {
      const { send, getBlocks } = createBlockMirror(controller, encoder);
      let agentText = '';
      let finalFiles: Record<string, any> = {};
      try {
        const trackedSend = (mode: string, payload: any) => {
          if (mode === 'text' && typeof payload === 'string') agentText += payload;
          if (mode === 'vfs_patch' && payload?.files) finalFiles = payload.files;
          send(mode, payload);
        };
        await streamSkillOptOpencode({
          user,
          threadId,
          skillName,
          baseVersion,
          checkedIssues: issuesNormalized,
          userFeedback: feedback,
          modelId,
          baselineFiles: baselineFilesNormalized,
          send: trackedSend,
        });
      } catch (err: any) {
        console.error('[skill-opt route] streamSkillOptOpencode threw:', err?.message || err);
        try { send('error', err?.message || String(err)); } catch { /* closed */ }
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }

      // 落 agent message + blocks + 最终 files（skill-generator 同款，区别是表名 + 新增字段不存）
      if (sessionExists) {
        try {
          await (prismaRaw as any).skillOptMessage.create({
            data: {
              sessionId: threadId,
              role: 'agent',
              content: agentText,
              blocks: JSON.stringify(getBlocks()),
            },
          });
          await (prismaRaw as any).skillOptSession.update({
            where: { id: threadId },
            data: { files: JSON.stringify(finalFiles) },
          });
        } catch (err: any) {
          console.warn('[skill-opt route] post-stream persistence failed:', err?.message || err);
        }
      }
    },
  });

  return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
}

/**
 * 把 issues + feedback 拼成一条人类可读的 user message。
 * 历史会话回看时用户能清楚看到这次"开始优化"勾了什么 + 写了什么诉求。
 */
function composeUserMessageText(issues: SkillOptIssueLite[], feedback: string): string {
  const parts: string[] = [];
  if (issues.length > 0) {
    const summary = issues.map(i => `[${i.severity}] ${i.id}: ${i.summary}`).join('\n');
    parts.push(`勾选了 ${issues.length} 个待优化点：\n${summary}`);
  }
  if (feedback.trim()) {
    parts.push(`附加诉求：${feedback.trim()}`);
  }
  if (parts.length === 0) {
    return '（开始优化）';
  }
  return parts.join('\n\n');
}

// ── mock 脚本：thinking → tool_call(read SKILL.md) → tool_result → text → vfs_patch → done ──

async function runMockScript(args: {
  skillName: string;
  baseVersion: number;
  issues: SkillOptIssueLite[];
  feedback: string;
  send: (mode: string, payload: any) => void;
}): Promise<void> {
  const { skillName, baseVersion, issues, feedback, send } = args;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const nextId = (() => {
    let n = 0;
    return (prefix: string) => `${prefix}_${Date.now()}_${++n}`;
  })();

  // Phase 1: thinking
  const thinkId = nextId('think');
  const thinkText = `分析 ${skillName} v${baseVersion} 的 ${issues.length} 个待优化点${feedback ? '和用户附加诉求' : ''}…`;
  for (const ch of thinkText) {
    send('thinking', { id: thinkId, delta: ch });
    await sleep(20);
  }
  send('thinking', { id: thinkId, done: true });
  await sleep(200);

  // Phase 2: read SKILL.md
  const toolId1 = nextId('tool');
  send('tool_call', { id: toolId1, name: 'read', args: { path: 'SKILL.md' }, status: 'running' });
  await sleep(300);
  send('tool_result', { id: toolId1, status: 'ok', summary: '读取 SKILL.md（mock）' });

  // Phase 3: edit SKILL.md
  const toolId2 = nextId('tool');
  send('tool_call', { id: toolId2, name: 'edit', args: { path: 'SKILL.md' }, status: 'running' });
  await sleep(400);
  send('tool_result', { id: toolId2, status: 'ok', summary: '已写入修改' });

  // Phase 4: 模拟 vfs_patch（一份"改过的" SKILL.md）
  const mockContent = mockOptimizedContent(skillName, baseVersion, issues, feedback);
  send('vfs_patch', {
    files: {
      '/workspace/SKILL.md': {
        content: mockContent.split('\n'),
        created_at: new Date().toISOString(),
        modified_at: new Date().toISOString(),
      },
    },
  });

  // Phase 5: 收尾文本
  const summary = formatMockSummary(issues);
  send('text', summary);
}

function mockOptimizedContent(
  skillName: string,
  baseVersion: number,
  issues: SkillOptIssueLite[],
  feedback: string,
): string {
  const lines = [
    '---',
    `name: ${skillName}`,
    `version: ${baseVersion + 1}`,
    'description: (mock 优化版本)',
    '---',
    '',
    `# ${skillName}`,
    '',
    '## 优化点处理（mock）',
    '',
  ];
  for (const it of issues) {
    lines.push(`- [${it.severity}] \`${it.id}\`：${it.summary}`);
  }
  if (feedback) {
    lines.push('', '## 用户诉求', '', feedback);
  }
  return lines.join('\n');
}

function formatMockSummary(issues: SkillOptIssueLite[]): string {
  if (issues.length === 0) {
    return '\n\n（mock）没有待优化点，已查看 SKILL.md 但未作修改。';
  }
  const ids = issues.map((it) => `\`${it.id}\``).join(', ');
  return `\n\n（mock）已修改 \`SKILL.md\`，覆盖以下 issue：${ids}。`;
}
