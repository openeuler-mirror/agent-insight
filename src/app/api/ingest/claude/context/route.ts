import { buildContextSupplementEvents, maxTextChars } from '@/lib/ingest/claude-otel/context-supplement';
import { appendClaudeOtelEvents } from '@/lib/ingest/claude-otel/spool';
import { db } from '@/lib/storage/prisma';
import { NextResponse } from 'next/server';

/**
 * Claude Code 上下文补传入口。
 *
 * 官方 OTel logs 拿不到两样东西:
 *  1. system prompt —— 只在 Messages 请求体顶层 `system` 里,而 `file:` 模式下事件只带
 *     `body_ref`(客户端本机绝对路径),服务端与客户端不同机时永远读不到;
 *     inline 模式实测有 ~60KB 硬截断(body_truncated=true),JSON 不完整同样解析不出。
 *  2. hook 注入的 additionalContext —— 压根不进 OTel 事件,只落在客户端的会话 transcript。
 *
 * 客户端 claude_context_uploader.js 在每轮 Stop/SubagentStop/StopFailure 后异步补传,
 * 并用 SessionEnd 做最终兜底。它把这些内容从本机磁盘捞出来发到这里,
 * 服务端写进【同一份 claude spool 的 logs.jsonl】,消费者按增量字节自然发现并重聚合该 session,
 * 不新增 spool 源、不改消费者。
 */
export async function POST(req: Request) {
  try {
    // 补传等于往别人的 trace 里塞内容,比 logs 端点更值得收紧:必须是有效 API key。
    const apiKey = req.headers.get('x-witty-api-key');
    if (!apiKey || !(await db.findUserByApiKey(apiKey))) {
      return NextResponse.json({ status: 'error', message: 'invalid or missing x-witty-api-key' }, { status: 401 });
    }

    const contentType = req.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return NextResponse.json({ status: 'error', message: 'expected application/json' }, { status: 415 });
    }

    const body = await req.json();
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!sessionId) {
      return NextResponse.json({ status: 'error', message: 'sessionId is required' }, { status: 400 });
    }

    const { events, truncated } = buildContextSupplementEvents(sessionId, body?.items, {
      receivedAt: new Date().toISOString(),
      maxTextChars: maxTextChars(),
    });

    if (events.length > 0) appendClaudeOtelEvents(events);

    return NextResponse.json({
      status: 'accepted',
      received: Array.isArray(body?.items) ? body.items.length : 0,
      stored: events.length,
      truncated,
      sessionId,
    });
  } catch (err: any) {
    console.error('[Claude Context] Handler Error:', err);
    return NextResponse.json({ status: 'error', message: err?.message || 'unknown error' }, { status: 500 });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-witty-api-key',
    },
  });
}
