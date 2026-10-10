import { appendClaudeOtelEvents } from '@/lib/ingest/claude-otel/spool';
import { normalizeOtlpLogs } from '@/lib/ingest/claude-otel/otlp-json';
import { appendCodeAgentOtelEvents } from '@/lib/ingest/codeagent-otel/spool';
import { isCodeAgentOtelEvent } from '@/lib/ingest/codeagent-otel/detect';
import { appendOtelTraceEvents } from '@/lib/ingest/otel/spool';
import { qwenSkillLogToOtelEvent } from '@/lib/ingest/otel/adapters/qwencode';
import { appendDeepSeekHarnessOtelEvents } from '@/lib/ingest/deepseek-harness-otel/spool';
import { partitionDeepSeekHarnessOtlpLogs } from '@/lib/ingest/deepseek-harness-otel/detect';
import { normalizeDeepSeekHarnessOtlpLogs } from '@/lib/ingest/deepseek-harness-otel/otlp-json';
import { db } from '@/lib/storage/prisma';
import { NextResponse } from 'next/server';
import { gunzipSync } from 'node:zlib';

async function readOtlpJson(req: Request): Promise<any> {
  const contentEncoding = String(req.headers.get('content-encoding') || '').trim().toLowerCase();
  if (!contentEncoding || contentEncoding === 'identity') return req.json();
  if (contentEncoding !== 'gzip') throw new Error(`Unsupported Content-Encoding: ${contentEncoding}`);
  const compressed = Buffer.from(await req.arrayBuffer());
  return JSON.parse(gunzipSync(compressed).toString('utf8'));
}

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

    const body = await readOtlpJson(req);
    const receivedAt = new Date().toISOString();
    const harnessPartition = partitionDeepSeekHarnessOtlpLogs(body);
    if (harnessPartition.harnessResourceCount > 0 && !authenticatedUser) {
      return NextResponse.json(
        { status: 'error', error: 'DeepSeek Harness telemetry requires a valid x-witty-api-key.' },
        { status: 401 },
      );
    }
    const harnessEvents = normalizeDeepSeekHarnessOtlpLogs(harnessPartition.harnessBody, {
      receivedAt,
      authenticatedUser,
    });
    const harnessResult = appendDeepSeekHarnessOtelEvents(harnessEvents);
    const events = harnessPartition.hasRemainingResources
      ? normalizeOtlpLogs(harnessPartition.remainingBody, { receivedAt, authenticatedUser })
      : [];
    const isQwenLog = (event: (typeof events)[number]) => {
      const serviceName = String(event.resource?.['service.name'] || '').toLowerCase();
      return serviceName === 'qwencode'
        || serviceName === 'qwen-code'
        || event.eventName.startsWith('qwen-code.');
    };
    const qwenLogEvents = events.filter(isQwenLog);
    const qwenSkillEvents = events.map(qwenSkillLogToOtelEvent)
      .filter((event): event is NonNullable<typeof event> => event !== null);
    const codeAgentEvents = events.filter(isCodeAgentOtelEvent);
    // Qwen emits config, prompts, API calls and memory events as OTLP Logs.
    // They belong to the Qwen trace session and must never enter the generic
    // Claude log spool, where they would create a phantom running Claude task.
    const otherEvents = events.filter((event) => !isCodeAgentOtelEvent(event) && !isQwenLog(event));
    const codeAgentResult = appendCodeAgentOtelEvents(codeAgentEvents);
    const otherResult = appendClaudeOtelEvents(otherEvents);
    const qwenResult = appendOtelTraceEvents(qwenSkillEvents);
    const dirtySessionIds = Array.from(new Set([
      ...codeAgentResult.dirtySessionIds,
      ...otherResult.dirtySessionIds,
      ...qwenResult.dirtySessionIds,
      ...harnessResult.dirtySessionIds,
    ]));

    return NextResponse.json({
      status: 'accepted',
      received: events.length + harnessEvents.length,
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
        qwencode: {
          received: qwenLogEvents.length,
          skills: qwenSkillEvents.length,
          sessions: qwenResult.dirtySessionIds,
        },
        'deepseek-harness': {
          received: harnessEvents.length,
          sessions: harnessResult.dirtySessionIds,
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
