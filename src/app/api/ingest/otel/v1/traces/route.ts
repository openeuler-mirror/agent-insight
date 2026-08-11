import { normalizeOtlpTraces } from '@/lib/ingest/otel/normalize';
import { appendOtelTraceEvents } from '@/lib/ingest/otel/spool';
import { decodeOtlpRequest, OtlpDecodeError } from '@/lib/ingest/otel/decode';
import { isLangfuseOtlpTraceBody } from '@/lib/ingest/otel/langfuse';
import { jiuwenServiceName } from '@/lib/ingest/otel/jiuwen/aggregate';
import { ingestJiuwenOtlp } from '@/lib/ingest/otel/jiuwen/ingest';
import { partitionCodeAgentOtlpPayload } from '@/lib/ingest/codeagent-otel/detect';
import { db } from '@/lib/storage/prisma';
import { NextResponse } from 'next/server';

type LangfuseCredentials = {
  publicKey?: string;
  secretKey?: string;
  source: 'basic' | 'headers';
};

function langfuseCredentialsFromRequest(req: Request): LangfuseCredentials {
  const auth = req.headers.get('authorization') || '';
  if (auth.toLowerCase().startsWith('basic ')) {
    try {
      const decoded = Buffer.from(auth.slice('basic '.length).trim(), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator >= 0) {
        return {
          publicKey: decoded.slice(0, separator).trim(),
          secretKey: decoded.slice(separator + 1).trim(),
          source: 'basic',
        };
      }
      return { publicKey: decoded.trim(), source: 'basic' };
    } catch {
      return { source: 'basic' };
    }
  }

  return {
    publicKey: req.headers.get('x-langfuse-public-key')?.trim(),
    secretKey: req.headers.get('x-langfuse-secret-key')?.trim(),
    source: 'headers',
  };
}

async function authenticateLangfuseCredentials(req: Request): Promise<string | undefined> {
  const credentials = langfuseCredentialsFromRequest(req);
  if (!credentials.publicKey || !credentials.secretKey) {
    console.warn('[OTel] Rejected Langfuse trace ingest: missing public or secret key', {
      source: credentials.source,
      publicKey: credentials.publicKey || undefined,
    });
    return undefined;
  }

  const userRecord = await db.findUserByUsername(credentials.publicKey);
  if (!userRecord) {
    console.warn('[OTel] Rejected Langfuse trace ingest: unknown public key', {
      source: credentials.source,
      publicKey: credentials.publicKey,
    });
    return undefined;
  }

  if (userRecord.apiKey !== credentials.secretKey) {
    console.warn('[OTel] Rejected Langfuse trace ingest: secret key does not match public key', {
      source: credentials.source,
      publicKey: credentials.publicKey,
    });
    return undefined;
  }

  return userRecord.username;
}

function ignoredCodeAgentSpans(resourceSpans: number): Record<string, any> {
  return resourceSpans > 0 ? { ignored: { codeagent: { resourceSpans } } } : {};
}

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

    let body;
    try {
      body = await decodeOtlpRequest(req, 'traces');
    } catch (err) {
      if (err instanceof OtlpDecodeError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      console.error('[OTel] Failed to decode request body:', err);
      return NextResponse.json({ error: 'Invalid Payload' }, { status: 400 });
    }
    const codeAgentPartition = partitionCodeAgentOtlpPayload(body, 'traces');
    if (codeAgentPartition.codeAgentResourceCount > 0 && !codeAgentPartition.hasRemainingResources) {
      return NextResponse.json({
        status: 'accepted',
        framework: 'codeagent',
        ignored: true,
        ignoredResourceSpans: codeAgentPartition.codeAgentResourceCount,
        received: 0,
        sessions: [],
      });
    }
    body = codeAgentPartition.remainingBody;

    if (!authenticatedUser && isLangfuseOtlpTraceBody(body)) {
      authenticatedUser = await authenticateLangfuseCredentials(req);
      if (!authenticatedUser) {
        return NextResponse.json({ error: 'Invalid Langfuse credentials' }, { status: 401 });
      }
      console.log('[OTel] Langfuse Authenticated User:', authenticatedUser);
    }

    // Jiuwen 的结构 span 需要走自包含的 raw-span 聚合路径。
    if (jiuwenServiceName(body) === 'jiuwenswarm') {
      const { received, sessions } = await ingestJiuwenOtlp(body, { user: authenticatedUser });
      return NextResponse.json({
        status: 'accepted',
        framework: 'jiuwenswarm',
        received,
        sessions,
        ...ignoredCodeAgentSpans(codeAgentPartition.codeAgentResourceCount),
      });
    }

    const receivedAt = new Date().toISOString();
    const events = normalizeOtlpTraces(body, { receivedAt, authenticatedUser });
    const { dirtySessionIds } = appendOtelTraceEvents(events);
    return NextResponse.json({
      status: 'accepted',
      received: events.length,
      sessions: dirtySessionIds,
      ...ignoredCodeAgentSpans(codeAgentPartition.codeAgentResourceCount),
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
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-witty-api-key, x-api-key, x-langfuse-public-key, x-langfuse-secret-key, x-langfuse-sdk-name, x-langfuse-sdk-version, baggage, traceparent, tracestate',
    },
  });
}
