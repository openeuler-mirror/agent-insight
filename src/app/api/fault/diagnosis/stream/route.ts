import { runGeneralAgent } from '@/lib/engine/general-agent';
import type { ChatHandlers } from '@/lib/engine/skill-generation/opencode-agent-cli/opencode-client';
import { ensureSessionWorkspace } from '@/lib/engine/general-agent/workspace';
import { ensureTraceBundle } from '@/lib/engine/observability/trace-bundle';
import { inferSubagentNamesFromInteractions } from '@/lib/engine/observability/subagent-inference';
import { normalizeClaudeCodeInteractionsForStorage } from '@/lib/shared/interaction-content';
import { db, prismaRaw } from '@/lib/storage/prisma';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

interface StoredTraceSession {
  interactions?: string | null;
}

interface FaultDiagnosisSessionRow {
  id: string;
}

interface FaultDiagnosisMessageRow {
  role: string;
  content: string;
}

interface FaultDiagnosisStore {
  faultDiagnosisSession: {
    findUnique(args: { where: { executionId: string } }): Promise<FaultDiagnosisSessionRow | null>;
    create(args: { data: { executionId: string; user: string | null } }): Promise<FaultDiagnosisSessionRow>;
    update(args: { where: { id: string }; data: { opencodeSessionId: string } }): Promise<unknown>;
  };
  faultDiagnosisMessage: {
    findMany(args: {
      where: { sessionId: string };
      orderBy: { createdAt: 'asc' | 'desc' };
      take: number;
    }): Promise<FaultDiagnosisMessageRow[]>;
    create(args: { data: { sessionId: string; role: 'user' | 'assistant'; content: string } }): Promise<unknown>;
  };
}

const faultDb = prismaRaw as unknown as FaultDiagnosisStore;

const SYSTEM_PROMPT = `你是 Agent Insight 的故障定位诊断助手，运行在基于 OpenCode 的通用 Agent 框架中。

职责：
1. 基于用户提供的执行记录、异常详情、评测结论、历史对话和 trace 资料包回答追问。
2. 区分两类故障：原始错误类故障（接口、工具、权限、运行时、环境、链路中断等）与效果偏差类故障（无明显报错但输出、路由、Skill 调用、最终答案偏离预期）。
3. 回答要直接、可操作，优先给出根因假设、证据、影响范围、下一步验证和修复建议。

节点引用格式（重要）：
- 当你需要引用 trace-index.json 中的具体执行节点时，必须使用格式：@[nodeId:nodeLabel]
- 例如：@[n-llm-deepseek-1:DeepSeek · 意图理解] 或 @[n-skill-route:route_planner · 路由规划]
- nodeId 必须来自 trace-index.json 的 id 字段，不要编造不存在的 id
- 前端会将这些引用渲染为可交互的节点链接，用户点击后可跳转到对应执行节点
- 每次提及某个节点时都应使用此格式，不要直接写节点名称的纯文本

trace 资料包读取规则：
- 先读取 manifest.json 和 trace-index.json 理解整体链路。
- 不要一次性读取 artifacts 目录下的大文件；只有需要验证某个节点证据时，才读取对应 nodeFile 或 artifactPath。
- nodeFile 中的 input/output 如带 artifactPath，说明正文较长，应按需读取该 artifact。
- 回答必须优先基于执行记录、trace-index、相关节点文件和历史对话，证据不足时说明缺口。

约束：
- 不要重新声明自己已经完成了自动诊断；首屏异常详情由前端静态展示，当前对话只处理用户追问。
- 如果证据不足，明确说"当前证据不足"，然后列出需要补充的日志或字段。
- 不要编造不存在的接口、文件路径、日志行或配置项。
- 默认用中文回答，除非用户明确要求其他语言。`;

function compactJson(value: unknown, max = 12_000): string {
  let text = '';
  try {
    text = JSON.stringify(value ?? {}, null, 2);
  } catch {
    text = String(value ?? '');
  }
  return text.length > max ? `${text.slice(0, max)}\n...<truncated>` : text;
}

function compactText(value: unknown, max = 8_000): string {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}\n...<truncated>` : text;
}

function formatConversationHistory(messages: Array<{ role: string; content: string }>, max = 8_000): string {
  if (!messages.length) return '无历史对话。';
  const text = messages
    .map((message) => {
      const role = message.role === 'assistant' ? 'Assistant' : 'User';
      return `[${role}]\n${message.content || ''}`;
    })
    .join('\n\n---\n\n');
  return compactText(text, max);
}

function parseInteractionsFromSession(session: StoredTraceSession | null, framework?: string): unknown[] {
  let rawInteractions: unknown[] = [];
  try {
    rawInteractions = session?.interactions ? JSON.parse(session.interactions) : [];
  } catch {
    rawInteractions = [];
  }
  const normalized = framework === 'claudecode'
    ? normalizeClaudeCodeInteractionsForStorage(rawInteractions as Parameters<typeof normalizeClaudeCodeInteractionsForStorage>[0])
    : rawInteractions;
  return inferSubagentNamesFromInteractions(normalized as Parameters<typeof inferSubagentNamesFromInteractions>[0]);
}

async function ensureDiagnosisSession(executionId: string, user: string) {
  const existing = await faultDb.faultDiagnosisSession.findUnique({
    where: { executionId },
  });
  if (existing) return existing;
  return await faultDb.faultDiagnosisSession.create({
    data: { executionId, user: user || null },
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const user = String(body.user || '').trim();
  const message = String(body.message || body.query || '').trim();
  if (!user || !message) {
    return new Response(JSON.stringify({ error: 'user and message are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const executionId = String(body.executionId || '').trim();
  if (!executionId) {
    return new Response(JSON.stringify({ error: 'executionId is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const diagnosisSession = await ensureDiagnosisSession(executionId, user);
  const diagnosisSessionId = diagnosisSession.id;
  const previousMessagesDesc = await faultDb.faultDiagnosisMessage.findMany({
    where: { sessionId: diagnosisSessionId },
    orderBy: { createdAt: 'desc' },
    take: 24,
  });
  const previousMessages = previousMessagesDesc.reverse();

  const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim() ? body.sessionId.trim() : undefined;
  const workspaceTag = executionId ? `fault-diagnosis-${executionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)}` : undefined;
  const workspaceDir = ensureSessionWorkspace(user, workspaceTag || executionId);
  const traceSession = await db.findSessionByTaskId(executionId).catch(() => null) as StoredTraceSession | null;
  const executionBriefValue = body.executionBrief && typeof body.executionBrief === 'object'
    ? body.executionBrief as Record<string, unknown>
    : undefined;
  const framework = typeof executionBriefValue?.framework === 'string' ? executionBriefValue.framework : undefined;
  const interactions = parseInteractionsFromSession(traceSession, framework);
  const traceBundle = ensureTraceBundle({ workspaceDir, executionId, interactions });
  const executionBrief = compactJson(body.executionBrief, 14_000);
  const conversationHistory = formatConversationHistory(previousMessages);
  const query = [
    '下面是用户当前打开的故障记录上下文，请只基于这些证据和后续用户问题作答。',
    '',
    '## 执行记录',
    executionBrief,
    '',
    '## 历史对话上下文',
    conversationHistory,
    '',
    '## Trace 资料包',
    [
      `资料包目录：${traceBundle.bundleRelDir}/`,
      `manifest：${traceBundle.manifestRelPath}`,
      `index：${traceBundle.indexRelPath}`,
      `节点数：${traceBundle.nodeCount}`,
      `长文本 artifact 数：${traceBundle.artifactCount}`,
      `是否复用已有资料包：${traceBundle.reused ? '是' : '否'}`,
      '',
      '读取规则：',
      '1. 先读取 manifest.json 和 trace-index.json。',
      '2. 不要读取完整原始 trace；本次上下文未直接提供完整 interactions。',
      '3. 需要定位某个节点时，按 trace-index.json 中的 nodeFile 读取对应 nodes/*.json。',
      '4. 如果 nodeFile 的 input/output 带 artifactPath，只在需要原文证据时读取对应 artifacts/*.txt。',
      '5. 回答引用节点时使用 @[nodeId:nodeLabel] 格式。',
    ].join('\n'),
    '',
    '## 用户问题',
    message,
  ].join('\n');

  await faultDb.faultDiagnosisMessage.create({
    data: {
      sessionId: diagnosisSessionId,
      role: 'user',
      content: message,
    },
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let assistantContent = '';
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* stream closed */
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      send('ready', { executionId, sessionId: sessionId ?? null, diagnosisSessionId });

      const handlers: ChatHandlers = {
        onText: (e) => {
          assistantContent = e.fullText || assistantContent + e.delta;
          send('text', { delta: e.delta, fullText: e.fullText });
        },
        onReasoning: (e) => send('reasoning', { delta: e.delta }),
        onTool: (e) =>
          send('tool', {
            phase: e.phase,
            name: e.name,
            callID: e.callID,
            status: e.status,
          }),
      };

      runGeneralAgent({
        user,
        query,
        system: SYSTEM_PROMPT,
        sessionId,
        workspaceTag,
        sessionTitle: executionId ? `fault-diagnosis · ${executionId}` : 'fault-diagnosis',
        systemAgentName: 'fault-diagnosis-agent',
        interactionPolicy: 'auto-deny',
        agent: 'plan',
        handlers,
        timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : 5 * 60 * 1000,
        modelOptions: { temperature: 0.2, maxTokens: 2400 },
      })
        .then(async (result) => {
          await faultDb.faultDiagnosisMessage.create({
            data: {
              sessionId: diagnosisSessionId,
              role: 'assistant',
              content: result.output || assistantContent,
            },
          });
          if (result.sessionId) {
            await faultDb.faultDiagnosisSession.update({
              where: { id: diagnosisSessionId },
              data: { opencodeSessionId: result.sessionId },
            });
          }
          send('done', {
            sessionId: result.sessionId,
            diagnosisSessionId,
            workspaceDir: result.workspaceDir,
            output: result.output,
            stats: result.stats,
          });
        })
        .catch(async (err) => {
          const errorMessage = err instanceof Error ? err.message : String(err);
          await faultDb.faultDiagnosisMessage.create({
            data: {
              sessionId: diagnosisSessionId,
              role: 'assistant',
              content: `错误: ${errorMessage}`,
            },
          });
          send('error', { message: errorMessage });
        })
        .finally(close);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
