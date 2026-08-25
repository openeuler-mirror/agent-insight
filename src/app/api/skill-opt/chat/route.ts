import { NextRequest } from 'next/server';
import { streamSkillOptOpencode } from '@/lib/skill-opt-bridge';
import type { SkillOptIssueLite, SkillOptPlanItemLite } from '@/lib/engine/general-agent/skill-opt-prompt';
import { prismaRaw } from '@/lib/storage/prisma';
import { createBlockMirror } from '@/lib/chat/block-mirror';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import {
  beginWorkbenchOptimizationRun,
  finishWorkbenchOptimizationRun,
  updateWorkbenchOptimizationProgress,
} from '@/lib/skill-workbench/optimization-adapter';

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

  const { user, threadId, skillName, baseVersion, checkedIssues, userFeedback, modelId, baselineFiles, mock, planId, runId } = body || {};

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
          improvementSuggestion: typeof it.improvementSuggestion === 'string' ? it.improvementSuggestion : undefined,
        }))
    : [];

  const feedback = typeof userFeedback === 'string' ? userFeedback : '';

  // ── plan 模式：planId 有效时加载归并 plan 的可执行条目（core/reference 且未弃用），
  // 注入 prompt 替代平铺 checkedIssues；conflict 未仲裁的条目不进 prompt。
  let planItems: SkillOptPlanItemLite[] | undefined;
  let planDisplay: {
    id: string;
    sourceCount: number;
    items: Array<{
      id: string;
      route: string;
      status: string;
      severity: string;
      title: string;
      targetFile?: string;
      conflictNote?: string;
    }>;
  } | undefined;
  if (typeof planId === 'string' && planId.trim()) {
    try {
      const plan = await (prismaRaw as any).skillOptPlan.findUnique({
        where: { id: planId.trim() },
        include: { items: { orderBy: { rank: 'asc' } } },
      });
      if (!plan || plan.sessionId !== threadId) {
        return new Response(JSON.stringify({ error: 'plan not found for this session' }), { status: 400 });
      }
      const sourceIssueIds = new Set<string>();
      planDisplay = {
        id: plan.id,
        sourceCount: 0,
        items: (plan.items || []).map((it: any) => {
          for (const issueId of parseStringArray(it.sourceIssueIds)) sourceIssueIds.add(issueId);
          return {
            id: it.id,
            route: it.route,
            status: it.status,
            severity: it.severity,
            title: it.title,
            ...(it.targetFile ? { targetFile: it.targetFile } : {}),
            ...(it.conflictNote ? { conflictNote: it.conflictNote } : {}),
          };
        }),
      };
      planDisplay.sourceCount = sourceIssueIds.size;
      planItems = (plan.items || [])
        .filter((it: any) => (it.route === 'core' || it.route === 'reference') && it.status === 'pending')
        .map((it: any) => ({
          id: it.id,
          route: it.route,
          title: it.title,
          rationale: it.rationale,
          severity: (['high', 'medium', 'low'] as const).includes(it.severity) ? it.severity : 'medium',
          targetFile: it.targetFile ?? undefined,
          anchorText: it.anchorText ?? undefined,
          proposedEdit: it.proposedEdit ?? undefined,
          prevalence: it.prevalence ?? undefined,
        }));
      if (planItems!.length === 0) {
        return new Response(JSON.stringify({ error: 'plan has no executable items (all conflict/dismissed/backlog)' }), { status: 400 });
      }
      // plan 进入执行 → confirmed（应用完成由 iterations 路由置 applied）
      if (plan.status === 'draft') {
        await (prismaRaw as any).skillOptPlan.update({ where: { id: plan.id }, data: { status: 'confirmed' } });
      }
    } catch (err: any) {
      console.warn('[skill-opt route] plan load failed:', err?.message || err);
      return new Response(JSON.stringify({ error: 'failed to load plan' }), { status: 500 });
    }
  }

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
  // 用 issues/plan + feedback 拼，让会话历史回看时知道用户每次点了什么。
  const userMessageText = planItems
    ? composePlanUserMessageText(planItems, feedback)
    : composeUserMessageText(issuesNormalized, feedback);
  const normalizedRunId = typeof runId === 'string' && runId.trim() ? runId.trim() : `${threadId}:${Date.now()}`;
  const optimizationSourceKind = issuesNormalized.length || planDisplay ? 'evaluation' as const : 'user' as const;
  const optimizationSourceRefs = [
    { type: 'optimization-run', id: normalizedRunId },
    ...issuesNormalized.map((issue) => ({ type: 'issue', id: issue.id })),
    ...(planDisplay ? [{ type: 'plan', id: planDisplay.id }] : []),
  ];

  // 先创建运行，再让用户消息与 Agent 消息共同持久化同一个 runId/taskId/recordId。
  let sessionExists = false;
  let session: { id: string; title: string | null; user: string | null } | null = null;
  try {
    session = await (prismaRaw as any).skillOptSession.findUnique({
      where: { id: threadId },
      select: { id: true, title: true, user: true },
    });
    sessionExists = !!session && session.user === user;
  } catch (err: any) {
    console.warn('[skill-opt route] session validation failed:', err?.message || err);
  }
  const workbenchRun = sessionExists
    ? await beginWorkbenchOptimizationRun({
        user,
        optSessionId: threadId,
        runId: normalizedRunId,
        sourceKind: optimizationSourceKind,
        sourceRefs: optimizationSourceRefs,
      }).catch((error) => {
        console.error('[skill-opt route] start workbench task failed:', error);
        return null;
      })
    : null;

  try {
    if (sessionExists && session) {
      const runMeta = {
        kind: 'optimization_meta',
        id: `optimization-${normalizedRunId}`,
        runId: normalizedRunId,
        taskId: workbenchRun?.taskId,
        recordId: workbenchRun?.recordId,
      };
      await (prismaRaw as any).skillOptMessage.create({
        data: { sessionId: threadId, role: 'user', content: userMessageText, blocks: JSON.stringify([runMeta]) },
      });

      // 优化请求已被接受 = 一次有效使用；流式 token 不重复计。
      recordUsageEvent({ user, featureKey: 'skill-opt', eventKey: 'skill.optimize.run' });
      // 默认 title 时用首条 user message 截 30 字（skill-generator 同款）
      if (session.title === '新对话' || !session.title) {
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
    console.warn('[skill-opt route] pre-stream persistence failed:', err?.message || err);
  }

  // ── mock 模式：固定脚本回放，不调 LLM。让前端在没有真实模型配置时也能联调 ──
  if (mock) {
    const readable = new ReadableStream({
      async start(controller) {
        const { send, getBlocks } = createBlockMirror(controller, encoder);
        let agentText = '';
        let finalFiles: Record<string, any> = {};
        let chatError: string | null = null;
        let candidateStageStarted = false;
        try {
          send('optimization_meta', { runId: normalizedRunId, taskId: workbenchRun?.taskId, recordId: workbenchRun?.recordId });
          if (planDisplay) send('optimization_plan', planDisplay);
          // 包一层把 send 投递的 text 也累计到 agentText（fallback content 列）
          const trackedSend = (mode: string, payload: any) => {
            if (mode === 'text' && typeof payload === 'string') agentText += payload;
            if (mode === 'vfs_patch' && payload?.files) finalFiles = payload.files;
            if (!candidateStageStarted && workbenchRun && (mode === 'tool_call' || mode === 'vfs_patch')) {
              candidateStageStarted = true;
              void updateWorkbenchOptimizationProgress({
                taskId: workbenchRun.taskId,
                stage: '生成候选版本',
                activeStep: 2,
                percent: 35,
              }).catch(() => undefined);
            }
            send(mode, payload);
          };
          await runMockScript({ skillName, baseVersion, issues: issuesNormalized, feedback, send: trackedSend });
          send('done', { reason: 'completed' });
        } catch (err: any) {
          chatError = err?.message || String(err);
          try { send('error', err?.message || String(err)); } catch { /* closed */ }
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
            await (prismaRaw as any).skillOptSession.update({
              where: { id: threadId },
              data: { files: JSON.stringify(finalFiles) },
            });
          } catch (err: any) {
            console.warn('[skill-opt route] mock post-stream persistence failed:', err?.message || err);
            chatError ||= err?.message || String(err);
          }
        }
        if (workbenchRun) {
          await finishWorkbenchOptimizationRun({
            user,
            workbenchSessionId: workbenchRun.workbenchSessionId,
            taskId: workbenchRun.taskId,
            sourceKind: optimizationSourceKind,
            sourceRefs: optimizationSourceRefs,
            recordId: workbenchRun.recordId,
            error: chatError,
          });
        }
        try { controller.close(); } catch { /* already closed */ }
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
      let chatError: string | null = null;
      let candidateStageStarted = false;
      try {
        send('optimization_meta', { runId: normalizedRunId, taskId: workbenchRun?.taskId, recordId: workbenchRun?.recordId });
        if (planDisplay) send('optimization_plan', planDisplay);
        const trackedSend = (mode: string, payload: any) => {
          if (mode === 'text' && typeof payload === 'string') agentText += payload;
          if (mode === 'vfs_patch' && payload?.files) finalFiles = payload.files;
          if (!candidateStageStarted && workbenchRun && (mode === 'tool_call' || mode === 'vfs_patch')) {
            candidateStageStarted = true;
            void updateWorkbenchOptimizationProgress({
              taskId: workbenchRun.taskId,
              stage: '生成候选版本',
              activeStep: 2,
              percent: 35,
            }).catch(() => undefined);
          }
          send(mode, payload);
        };
        await streamSkillOptOpencode({
          user,
          threadId,
          skillName,
          baseVersion,
          checkedIssues: issuesNormalized,
          planItems,
          userFeedback: feedback,
          modelId,
          baselineFiles: baselineFilesNormalized,
          send: trackedSend,
        });
      } catch (err: any) {
        const rawError = err?.message || String(err);
        chatError = presentSkillOptError(rawError);
        console.error('[skill-opt route] streamSkillOptOpencode threw:', rawError);
        try { send('error', chatError); } catch { /* closed */ }
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
          chatError ||= err?.message || String(err);
        }
      }
      if (workbenchRun) {
        await finishWorkbenchOptimizationRun({
          user,
          workbenchSessionId: workbenchRun.workbenchSessionId,
          taskId: workbenchRun.taskId,
          sourceKind: optimizationSourceKind,
          sourceRefs: optimizationSourceRefs,
          recordId: workbenchRun.recordId,
          error: chatError,
          repair: chatError ? undefined : async (blockingIssues) => {
            const repairMirror = createBlockMirror(controller, encoder);
            repairMirror.send('optimization_meta', { runId: normalizedRunId, taskId: workbenchRun.taskId, recordId: workbenchRun.recordId });
            repairMirror.send('text', `\n\n静态质量校验发现 ${blockingIssues.length} 个阻断问题，正在自动修复（1/1）…\n`);
            const repairResult = await streamSkillOptOpencode({
              user,
              threadId,
              skillName,
              baseVersion,
              checkedIssues: blockingIssues.map((issue) => ({
                id: issue.id,
                severity: issue.severity,
                category: issue.dimension,
                summary: issue.summary,
                evidence: issue.evidence || issue.reasoning,
                improvementSuggestion: issue.suggestedFix,
              })),
              userFeedback: '上一轮候选未通过静态质量门禁。请只修复下面的阻断问题，保留已经正确的修改；修复后会自动重新评估。',
              modelId,
              baselineFiles: baselineFilesNormalized,
              send: repairMirror.send,
            });
            await prismaRaw.$transaction([
              prismaRaw.skillOptMessage.create({
                data: {
                  sessionId: threadId,
                  role: 'user',
                  content: `自动修复上一轮静态质量门禁的 ${blockingIssues.length} 个阻断问题：\n${blockingIssues.map((issue) => `- ${issue.summary}`).join('\n')}`,
                  blocks: JSON.stringify([{
                    kind: 'optimization_meta',
                    id: `optimization-${normalizedRunId}`,
                    runId: normalizedRunId,
                    taskId: workbenchRun.taskId,
                    recordId: workbenchRun.recordId,
                    automatic: true,
                  }]),
                },
              }),
              prismaRaw.skillOptMessage.create({
                data: {
                  sessionId: threadId,
                  role: 'agent',
                  content: repairResult.agentText,
                  blocks: JSON.stringify(repairMirror.getBlocks()),
                },
              }),
              prismaRaw.skillOptSession.update({
                where: { id: threadId },
                data: { files: JSON.stringify(repairResult.files) },
              }),
            ]);
          },
        });
      }
      try { controller.close(); } catch { /* already closed */ }
    },
  });

  return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
}

/**
 * 把 issues + feedback 拼成一条人类可读的 user message。
 * 历史会话回看时用户能清楚看到这次"开始优化"勾了什么 + 写了什么诉求。
 */
function composePlanUserMessageText(items: SkillOptPlanItemLite[], feedback: string): string {
  const parts: string[] = [];
  const core = items.filter(it => it.route === 'core').length;
  const reference = items.length - core;
  const summary = items.map(i => `[${i.severity}/${i.route}] ${i.id}: ${i.title}`).join('\n');
  parts.push(`按归并优化计划执行（core ${core} 条 + reference ${reference} 条）：\n${summary}`);
  if (feedback.trim()) parts.push(`附加诉求：${feedback.trim()}`);
  return parts.join('\n\n');
}

function composeUserMessageText(issues: SkillOptIssueLite[], feedback: string): string {
  if (feedback.trim()) return feedback.trim();
  const parts: string[] = [];
  if (issues.length > 0) {
    const summary = issues.map(i => `[${i.severity}] ${i.id}: ${i.summary}`).join('\n');
    parts.push(`勾选了 ${issues.length} 个待优化点：\n${summary}`);
  }
  if (parts.length === 0) {
    return '（开始优化）';
  }
  return parts.join('\n\n');
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function presentSkillOptError(message: string) {
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network error/i.test(message)) {
    return '模型服务连接失败，当前候选未生成，请稍后重新优化。';
  }
  return message;
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
