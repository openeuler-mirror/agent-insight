import { NextResponse } from 'next/server';
import { appendOtelTraceEvents } from '@/lib/ingest/claude-otel/spool';
import crypto from 'node:crypto';
import type { OtelTraceEvent } from '@/lib/ingest/claude-otel/types';

function randomHex(len: number): string {
  return crypto.randomBytes(len).toString('hex').slice(0, len);
}

/**
 * Bridge endpoint for OpenClaw watcher uploads.
 * Accepts the watcher's legacy format and converts to OTel trace events.
 *
 * 路径必须留在 openclaw 自己的命名空间下。这个 handler 曾经挂在 /api/upload，
 * 而 /api/upload 是老的通用上报端点、重构后由 next.config 的兼容别名指向
 * /api/ingest/upload；真实路由优先级高于 rewrite(afterFiles)，于是别名被静默
 * 遮蔽，opencode uploader 的整包 record（含 interactions）全被这里的转换丢掉，
 * 只剩一条合成的 chat span。
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const watcherApiKey = request.headers.get('x-witty-api-key');
    let user: string | undefined;
    if (watcherApiKey) {
      // Dynamic import to avoid circular dependency
      const { db } = await import('@/lib/storage/prisma');
      const userRecord = await db.findUserByApiKey(watcherApiKey).catch(() => null);
      if (userRecord) user = userRecord.username;
    }

    // Parse the watcher's record format into OtelTraceEvent[]
    const record = body.record || body;
    const taskId = record.task_id || randomHex(8);
    const traceId = randomHex(8);
    const spanId = randomHex(8);
    const startTimeMs = record.timestamp
      ? new Date(record.timestamp).getTime()
      : Date.now();

    const inputTokens = record.tokens ? Math.ceil(record.tokens / 2) : 0;
    const outputTokens = record.tokens ? Math.ceil(record.tokens / 2) : 0;
    const totalTokens = record.tokens || 0;
    const model = record.model || 'unknown';
    const skills = Array.isArray(record.skills) ? record.skills : [];
    const latencyMs = record.latency || 0;

    const events: OtelTraceEvent[] = [];

    // 1. LLM event
    events.push({
      receivedAt: new Date().toISOString(),
      sessionId: taskId,
      traceId,
      spanId,
      name: 'chat',
      kind: 'llm',
      serviceName: 'openclaw',
      user,
      model,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens },
      latencyMs,
      startTimeMs,
      attributes: {
        'gen_ai.span.kind': 'llm',
        'gen_ai.request.model': model,
        'gen_ai.prompt': record.query || '',
        'gen_ai.completion': record.final_result || '',
        'llm.latency_ms': latencyMs,
        'llm.provider': 'deepseek',
        ...(skills.length > 0 ? { 'gen_ai.request.tools': skills.join(',') } : {}),
      },
    });

    // 2. Tool events for each skill
    for (const skillName of skills) {
      if (!skillName) continue;
      const toolSpanId = randomHex(8);
      events.push({
        receivedAt: new Date().toISOString(),
        sessionId: taskId,
        traceId,
        spanId: toolSpanId,
        parentSpanId: spanId,
        name: 'execute_tool',
        kind: 'tool',
        serviceName: 'openclaw',
        user,
        model,
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        latencyMs: 0,
        startTimeMs,
        attributes: {
          'tool.name': skillName,
          'tool.arguments': '{}',
          'llm.provider': 'deepseek',
        },
      });
    }

    await appendOtelTraceEvents(events);
    return NextResponse.json({ success: true, sessionId: taskId, events: events.length });
  } catch (error: any) {
    console.error('[Upload] Error:', error);
    return NextResponse.json({ error: error?.message || 'Upload failed' }, { status: 500 });
  }
}
