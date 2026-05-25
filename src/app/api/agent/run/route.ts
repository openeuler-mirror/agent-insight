import { NextResponse } from 'next/server';
import { runGeneralAgent } from '@/lib/engine/general-agent';

export const dynamic = 'force-dynamic';
// 单次任务最多 5 分钟，避免 Next.js 默认超时把流截断。
export const maxDuration = 300;

/**
 * 通用 Agent 执行入口（HTTP 版本）。
 *
 * Request body:
 * {
 *   user: string,            // 必填，用户标识（多租户隔离的 key）
 *   query: string,           // 必填，任务描述
 *   skill?: string,          // 可选，要注入的 skill 名
 *   skillVersion?: number,   // 可选，指定 skill version
 *   system?: string,         // 可选，直接传 system prompt（与 skill 二选一）
 *   sessionId?: string,      // 可选，复用已有 session
 *   sessionTitle?: string,   // 可选，session 标题
 *   agent?: string,          // 可选，opencode agent 类型，默认 build
 *   model?: { providerID?, modelID?, apiKey?, baseURL?, headers? },
 *   modelOptions?: object,   // 可选，温度等
 *   timeoutMs?: number,      // 可选，整体超时
 * }
 *
 * Response:
 *   200 { success: true, sessionId, workspaceDir, skillResolved, skillMeta, output, stats }
 *   400 { error }
 *   500 { error }
 *
 * 流式版本另开 /api/agent/stream（暂未实现，可按需补）。
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const user = String(body.user || '').trim();
    if (!user) {
      return NextResponse.json({ error: 'user is required' }, { status: 400 });
    }
    const query = String(body.query || '').trim();
    if (!query) {
      return NextResponse.json({ error: 'query is required' }, { status: 400 });
    }

    const policy = typeof body.interactionPolicy === 'string' ? body.interactionPolicy : undefined;
    if (policy && policy !== 'auto-allow' && policy !== 'auto-deny' && policy !== 'manual') {
      return NextResponse.json(
        { error: "interactionPolicy must be one of: 'auto-allow' | 'auto-deny' | 'manual'" },
        { status: 400 },
      );
    }
    if (policy === 'manual') {
      return NextResponse.json(
        {
          error:
            "interactionPolicy='manual' is not supported on this synchronous HTTP endpoint; use the streaming endpoint or call runGeneralAgent() directly with handlers.",
        },
        { status: 400 },
      );
    }

    const result = await runGeneralAgent({
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
      interactionPolicy: policy as 'auto-allow' | 'auto-deny' | undefined,
      timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
    });

    return NextResponse.json({
      success: true,
      sessionId: result.sessionId,
      workspaceDir: result.workspaceDir,
      skillResolved: result.skillResolved,
      skillMeta: result.skillMeta,
      output: result.output,
      interactions: result.interactions,
      stats: result.stats,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[agent/run] error:', message);
    // 区分用户输入错误与系统错误：缺 user/query/skill 走 400，其余 500。
    const isUserError =
      /^(user|query) is required$/.test(message) ||
      /^skill not found:/.test(message) ||
      /^model\.apiKey missing/.test(message);
    return NextResponse.json(
      { error: message },
      { status: isUserError ? 400 : 500 },
    );
  }
}
