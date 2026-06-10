import { normalizeClaudeOtlpTraces } from '@/lib/ingest/claude-otel/otlp-json';
import { appendOtelTraceEvents } from '@/lib/ingest/claude-otel/spool';
import { db } from '@/lib/storage/prisma';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const apiKey = req.headers.get('x-witty-api-key');
    let authenticatedUser: string | undefined;

    if (apiKey) {
      const userRecord = await db.findUserByApiKey(apiKey);
      if (userRecord) {
        authenticatedUser = userRecord.username;
        console.log(`[OTel] Authenticated User: ${authenticatedUser}`);
      } else {
        console.warn(`[OTel] Invalid API Key provided: ${apiKey}`);
      }
    }

    const contentType = req.headers.get('content-type') || '';
    if (contentType.includes('application/x-protobuf')) {
      return NextResponse.json(
        { error: 'Protobuf not supported yet, please use OTEL_EXPORTER_OTLP_PROTOCOL=http/json' },
        { status: 415 },
      );
    }

    let body: any;
    try {
      body = await req.json();
    } catch (err) {
      console.error('[OTel] Failed to parse request body:', err);
      return NextResponse.json({ error: 'Invalid Payload' }, { status: 400 });
    }

    const receivedAt = new Date().toISOString();
    const events = normalizeClaudeOtlpTraces(body, { receivedAt, authenticatedUser });
    const { dirtySessionIds } = appendOtelTraceEvents(events);

    return NextResponse.json({
      status: 'accepted',
      received: events.length,
      sessions: dirtySessionIds,
    });
  } catch (err: any) {
    console.error('[OTel] Trace ingest handler error:', err);
    return NextResponse.json(
      { status: 'error', message: err?.message || 'Failed to accept OTLP traces' },
      { status: 500 },
    );
  }
}

export async function OPTIONS(req: Request) {
  console.log('[OTel] Received OPTIONS Request. Headers:', JSON.stringify(Object.fromEntries(req.headers.entries())));
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-witty-api-key, x-api-key, baggage, traceparent, tracestate',
    },
  });
}
