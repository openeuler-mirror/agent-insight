/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { normalizeOtlpTraces } from '@/lib/ingest/otel/normalize';
import { isLlamaIndexOtlpTraceBody } from '@/lib/ingest/otel/llamaindex';
import { appendOtelTraceEvents, getActrailOtelTraceSpoolDir } from '@/lib/ingest/otel/spool';
import { decodeOtlpRequest, OtlpDecodeError } from '@/lib/ingest/otel/decode';
import { beginOtelTraceRequest } from '@/lib/ingest/otel/diagnostics';
import { isLangfuseOtlpTraceBody } from '@/lib/ingest/otel/langfuse';
import { isActrailOtlpTraceBody } from '@/lib/ingest/otel/actrail';
import { jiuwenServiceName } from '@/lib/ingest/otel/jiuwen/aggregate';
import { ingestJiuwenOtlp } from '@/lib/ingest/otel/jiuwen/ingest';
import { partitionCodeAgentOtlpPayload } from '@/lib/ingest/codeagent-otel/detect';
import { isolateQwenCodeOtelEvent, isQwenCodeOtelEvent } from '@/lib/ingest/otel/adapters/qwencode';
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

async function authenticateLangfuseCredentials(req: Request) {
  const credentials = langfuseCredentialsFromRequest(req);
  if (!credentials.publicKey || !credentials.secretKey) {
    return { reason: 'missing-langfuse-credentials' } as const;
  }

  const userRecord = await db.findUserByUsername(credentials.publicKey);
  if (!userRecord) {
    return { reason: 'unknown-langfuse-user' } as const;
  }

  if (userRecord.apiKey !== credentials.secretKey) {
    return { reason: 'langfuse-secret-mismatch' } as const;
  }

  return { user: userRecord.username } as const;
}

function ignoredCodeAgentSpans(resourceSpans: number): Record<string, any> {
  return resourceSpans > 0 ? { ignored: { codeagent: { resourceSpans } } } : {};
}

export async function POST(req: Request) {
  const diagnostic = beginOtelTraceRequest(req);
  const respond = (body: unknown, status: number, result: Parameters<typeof diagnostic.finish>[1]) => {
    const response = NextResponse.json(body, { status });
    diagnostic.finish(status, result);
    return response;
  };
  try {
    const apiKey = req.headers.get('x-witty-api-key');
    let authenticatedUser: string | undefined;
    const hasInvalidApiKey = false;

    if (apiKey) {
      diagnostic.stage('api-key-auth');
      const userRecord = await db.findUserByApiKey(apiKey);
      if (userRecord) {
        authenticatedUser = userRecord.username;
        diagnostic.authenticated();
      } else {
        // Never echo credentials into application logs. An explicitly supplied
        // key is an authentication attempt, so a mismatch must not fall back to
        // resource-level user attribution.
        return respond(
          { error: 'Invalid x-witty-api-key' },
          401, { reason: 'invalid-api-key' },
        );
      }
    }

    let body;
    diagnostic.stage('decode');
    try {
      body = await decodeOtlpRequest(req, 'traces');
    } catch (err) {
      if (err instanceof OtlpDecodeError) {
        return respond({ error: err.message }, err.status, { reason: 'decode-failed' });
      }
      return respond({ error: 'Invalid Payload' }, 400, { reason: 'decode-failed', error: err });
    }
    diagnostic.decoded(body);
    diagnostic.stage('partition');
    const codeAgentPartition = partitionCodeAgentOtlpPayload(body, 'traces');
    if (codeAgentPartition.codeAgentResourceCount > 0 && !codeAgentPartition.hasRemainingResources) {
      return respond({
        status: 'accepted',
        framework: 'codeagent',
        ignored: true,
        ignoredResourceSpans: codeAgentPartition.codeAgentResourceCount,
        received: 0,
        sessions: [],
      }, 200, { reason: 'ignored-codeagent' });
    }
    body = codeAgentPartition.remainingBody;

    if (!authenticatedUser && isLangfuseOtlpTraceBody(body)) {
      diagnostic.stage('langfuse-auth');
      const auth = await authenticateLangfuseCredentials(req);
      authenticatedUser = auth.user;
      if (!authenticatedUser) {
        return respond({ error: 'Invalid Langfuse credentials' }, 401, { reason: auth.reason || 'unknown-langfuse-user' });
      }
      diagnostic.authenticated();
    }

    // The managed LlamaIndex collector always receives an Agent Insight API
    // key during configuration. Do not let an unauthenticated client choose an
    // arbitrary owner through OTLP resource.user.id.
    if (!authenticatedUser && isLlamaIndexOtlpTraceBody(body)) {
      diagnostic.stage('api-key-auth');
      return respond({ error: 'Missing x-witty-api-key' }, 401, { reason: 'missing-api-key' });
    }

    // Jiuwen 的结构 span 需要走自包含的 raw-span 聚合路径。
    if (jiuwenServiceName(body) === 'jiuwenswarm') {
      diagnostic.stage('jiuwen');
      const { received, sessions } = await ingestJiuwenOtlp(body, { user: authenticatedUser });
      return respond({
        status: 'accepted',
        framework: 'jiuwenswarm',
        received,
        sessions,
        ...ignoredCodeAgentSpans(codeAgentPartition.codeAgentResourceCount),
      }, 200, { reason: 'accepted' });
    }

    diagnostic.stage('normalize');
    const actrailPayload = isActrailOtlpTraceBody(body);
    const receivedAt = new Date().toISOString();
    const events = normalizeOtlpTraces(body, { receivedAt, authenticatedUser })
      .map(isolateQwenCodeOtelEvent);
    diagnostic.mapped(events);
    const rejectedQwenEvents = hasInvalidApiKey
      ? events.filter(isQwenCodeOtelEvent)
      : [];
    const acceptedEvents = rejectedQwenEvents.length
      ? events.filter((event) => !isQwenCodeOtelEvent(event))
      : events;

    if (rejectedQwenEvents.length && acceptedEvents.length === 0) {
      return respond(
        {
          error: 'Invalid API key',
          detail: 'The x-witty-api-key does not match a configured user.',
          hint: 'Update AGENT_INSIGHT_API_KEY to the API key shown for the intended Agent Insight user.',
        },
        401, { reason: 'invalid-api-key', rejected: rejectedQwenEvents.length },
      );
    }
    diagnostic.stage('spool');
    const appendResult = appendOtelTraceEvents(
      acceptedEvents,
      actrailPayload ? getActrailOtelTraceSpoolDir() : undefined,
    );
    const rejectedForIdentityLimit = appendResult.rejectedEvents;
    return respond({
      status: rejectedForIdentityLimit > 0 ? 'partial' : 'accepted',
      received: acceptedEvents.length - rejectedForIdentityLimit,
      persisted: appendResult.events.length,
      deduplicated: appendResult.deduplicatedEvents,
      sessions: appendResult.dirtySessionIds,
      ...(rejectedQwenEvents.length || rejectedForIdentityLimit > 0 ? {
        rejected: {
          ...(rejectedQwenEvents.length ? { qwencode: {
            events: rejectedQwenEvents.length,
            reason: 'invalid-api-key',
          } } : {}),
          ...(rejectedForIdentityLimit > 0 ? { spool: {
            events: rejectedForIdentityLimit,
            reason: 'goal-plus-session-identity-limit',
          } } : {}),
        },
      } : {}),
      ...ignoredCodeAgentSpans(codeAgentPartition.codeAgentResourceCount),
    }, rejectedForIdentityLimit > 0 ? 413 : 200, {
      reason: rejectedForIdentityLimit > 0 ? 'spool-identity-limit' : 'accepted',
      spooled: appendResult.events.length,
      deduplicated: appendResult.deduplicatedEvents,
      rejected: rejectedForIdentityLimit + rejectedQwenEvents.length,
    });
  } catch (err: any) {
    return respond(
      { status: 'error', message: err?.message || 'Failed to accept OTLP traces' },
      500, { reason: 'handler-error', error: err },
    );
  }
}

export async function OPTIONS(_req: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-witty-api-key, x-api-key, x-langfuse-public-key, x-langfuse-secret-key, x-langfuse-sdk-name, x-langfuse-sdk-version, baggage, traceparent, tracestate',
    },
  });
}
