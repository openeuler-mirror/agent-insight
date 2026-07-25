import { appendClaudeOtelEvents } from '@/lib/ingest/claude-otel/spool';
import { normalizeOtlpLogs } from '@/lib/ingest/claude-otel/otlp-json';
import { appendCodeAgentOtelEvents } from '@/lib/ingest/codeagent-otel/spool';
import { isCodeAgentOtelEvent } from '@/lib/ingest/codeagent-otel/detect';
import { db } from '@/lib/storage/prisma';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const apiKey = req.headers.get('x-witty-api-key');
    let authenticatedUser: string | undefined;

    if (apiKey) {
      const userRecord = await db.findUserByApiKey(apiKey);
      if (userRecord) authenticatedUser = userRecord.username;
    }

    const contentType = req.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return NextResponse.json(
        { error: 'Only OTLP http/json logs are supported. Set OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json.' },
        { status: 415 },
      );
    }

    const body = await req.json();
    const receivedAt = new Date().toISOString();
    const events = normalizeOtlpLogs(body, { receivedAt, authenticatedUser });
    const codeAgentEvents = events.filter(isCodeAgentOtelEvent);
    const otherEvents = events.filter((event) => !isCodeAgentOtelEvent(event));
    const codeAgentResult = appendCodeAgentOtelEvents(codeAgentEvents);
    const otherResult = appendClaudeOtelEvents(otherEvents);
    const dirtySessionIds = Array.from(new Set([
      ...codeAgentResult.dirtySessionIds,
      ...otherResult.dirtySessionIds,
    ]));

    return NextResponse.json({
      status: 'accepted',
      received: events.length,
      sessions: dirtySessionIds,
      frameworks: {
        codeagent: {
          received: codeAgentEvents.length,
          sessions: codeAgentResult.dirtySessionIds,
        },
        other: {
          received: otherEvents.length,
          sessions: otherResult.dirtySessionIds,
        },
      },
    });
  } catch (err: any) {
    console.error('[OTel Logs] Handler Error:', err);
    return NextResponse.json({ status: 'error', message: err.message }, { status: 500 });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-witty-api-key, baggage, traceparent, tracestate',
    },
  });
}
