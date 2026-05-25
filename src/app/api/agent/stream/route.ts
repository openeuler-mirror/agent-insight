import { randomUUID } from 'node:crypto';
import { runGeneralAgent } from '@/lib/engine/general-agent';
import { awaitInteraction, cancelStream } from '@/lib/engine/general-agent/pending-requests';
import type { ChatHandlers } from '@/lib/engine/skill-generation/opencode-agent-cli/opencode-client';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

/**
 * 流式版本：服务端推送 text/tool/subagent/permission/question/done/error 事件，
 * 前端遇到 permission/question 时通过 POST /api/agent/respond 回传应答。
 *
 * SSE 协议：
 *   event: <type>
 *   data: <json>
 *   \n
 *
 * 事件类型：
 *   - ready              { streamId, user }
 *   - text               { delta, fullText }
 *   - reasoning          { delta }
 *   - tool               { phase, name, callID, input?, output?, status? }
 *   - subagent           { ... }
 *   - permission         { requestId, title, type, pattern, callID }       ← 等用户回 reply: 'once'|'always'|'reject'
 *   - question           { requestId, questions, messageID }               ← 等用户回 reply: any[]|null
 *   - done               { sessionId, output, skillMeta, interactions, stats }
 *   - error              { message }
 *
 * 应答路径：POST /api/agent/respond  body: { requestId, user, kind, reply }
 *   - kind='permission' 时 reply 必须是 'once'|'always'|'reject'
 *   - kind='question'   时 reply 必须是 any[]|null（null 表示拒绝回答）
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const user = String(body.user || '').trim();
  const query = String(body.query || '').trim();
  if (!user || !query) {
    return new Response(JSON.stringify({ error: 'user and query are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const streamId = randomUUID();
  const liveRequestIds = new Set<string>();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* controller closed */
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

      // 客户端断连：取消所有未应答的交互（让 runner 拿到 reject 并降级）
      const onAbort = () => {
        cancelStream(streamId, 'client disconnected');
        close();
      };
      try {
        request.signal.addEventListener('abort', onAbort, { once: true });
      } catch {
        /* ignore */
      }

      send('ready', { streamId, user });

      const handlers: ChatHandlers = {
        onText: (e) => send('text', { delta: e.delta, fullText: e.fullText }),
        onReasoning: (e) => send('reasoning', { delta: e.delta }),
        onTool: (e) =>
          send('tool', {
            phase: e.phase,
            name: e.name,
            callID: e.callID,
            status: e.status,
            input: e.phase === 'start' ? e.input : undefined,
            output: e.phase === 'end' ? e.output : undefined,
          }),
        onSubagent: (e) => send('subagent', e),
        onTodo: (e) => send('todo', e),
        onFileEdited: (e) => send('file_edited', e),
        onPermission: async (e) => {
          send('permission', {
            requestId: e.id,
            title: e.title,
            type: e.type,
            pattern: e.pattern,
            callID: e.callID,
            metadata: e.metadata,
          });
          liveRequestIds.add(e.id);
          try {
            const reply = await awaitInteraction({
              requestId: e.id,
              kind: 'permission',
              user,
              streamId,
              ttlMs: typeof body.interactionTimeoutMs === 'number' ? body.interactionTimeoutMs : undefined,
            });
            return reply ?? 'reject';
          } catch (err) {
            // 超时 / 取消：降级为 reject，避免 opencode 永远卡着
            send('interaction_timeout', {
              requestId: e.id,
              kind: 'permission',
              reason: (err as Error).message,
            });
            return 'reject';
          } finally {
            liveRequestIds.delete(e.id);
          }
        },
        onQuestion: async (e) => {
          send('question', {
            requestId: e.id,
            questions: e.questions,
            messageID: e.messageID,
          });
          liveRequestIds.add(e.id);
          try {
            const reply = await awaitInteraction({
              requestId: e.id,
              kind: 'question',
              user,
              streamId,
              ttlMs: typeof body.interactionTimeoutMs === 'number' ? body.interactionTimeoutMs : undefined,
            });
            return reply ?? null;
          } catch (err) {
            send('interaction_timeout', {
              requestId: e.id,
              kind: 'question',
              reason: (err as Error).message,
            });
            return null;
          } finally {
            liveRequestIds.delete(e.id);
          }
        },
      };

      runGeneralAgent({
        user,
        query,
        skill: typeof body.skill === 'string' && body.skill.trim() ? body.skill.trim() : undefined,
        skillVersion: typeof body.skillVersion === 'number' ? body.skillVersion : undefined,
        system: typeof body.system === 'string' && body.system.trim() ? body.system : undefined,
        sessionId: typeof body.sessionId === 'string' && body.sessionId.trim() ? body.sessionId : undefined,
        sessionTitle: typeof body.sessionTitle === 'string' ? body.sessionTitle : undefined,
        agent: typeof body.agent === 'string' && body.agent.trim() ? body.agent : undefined,
        model: body.model && typeof body.model === 'object' ? body.model : undefined,
        modelOptions:
          body.modelOptions && typeof body.modelOptions === 'object' ? body.modelOptions : undefined,
        interactionPolicy: 'manual',
        handlers,
        timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
      })
        .then((result) => {
          send('done', {
            sessionId: result.sessionId,
            workspaceDir: result.workspaceDir,
            skillResolved: result.skillResolved,
            skillMeta: result.skillMeta,
            output: result.output,
            interactions: result.interactions,
            stats: result.stats,
          });
        })
        .catch((err) => {
          send('error', { message: err instanceof Error ? err.message : String(err) });
        })
        .finally(() => {
          // 兜底：清掉所有还没应答的请求
          if (liveRequestIds.size > 0) cancelStream(streamId, 'run finished');
          close();
        });
    },
    cancel() {
      cancelStream(streamId, 'stream cancelled');
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
