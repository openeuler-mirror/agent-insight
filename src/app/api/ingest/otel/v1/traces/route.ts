import { normalizeOtlpTraces } from '@/lib/ingest/otel/normalize';
import { appendOtelTraceEvents } from '@/lib/ingest/otel/spool';
import { decodeOtlpRequest, OtlpDecodeError } from '@/lib/ingest/otel/decode';
import { jiuwenServiceName } from '@/lib/ingest/otel/jiuwen/aggregate';
import { ingestJiuwenOtlp } from '@/lib/ingest/otel/jiuwen/ingest';
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

    let body: any;
    try {
      body = await decodeOtlpRequest(req, 'traces');
    } catch (err) {
      if (err instanceof OtlpDecodeError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      console.error('[OTel] Failed to decode request body:', err);
      return NextResponse.json({ error: 'Invalid Payload' }, { status: 400 });
    }

    // jiuwen (openJiuwen / JiuwenSwarm via agent-core) emits a nested agent.*/team.*
    // span tree whose structural spans the flat claude-otel normalizer would drop,
    // so it takes a self-contained raw-span path that rebuilds the agent tree.
    if (jiuwenServiceName(body) === 'jiuwenswarm') {
      const { received, sessions } = await ingestJiuwenOtlp(body, { user: authenticatedUser });
      return NextResponse.json({ status: 'accepted', framework: 'jiuwenswarm', received, sessions });
    }

    const receivedAt = new Date().toISOString();
    const events = normalizeOtlpTraces(body, { receivedAt, authenticatedUser });
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
