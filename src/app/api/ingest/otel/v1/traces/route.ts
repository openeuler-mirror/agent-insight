import { isStorageCoreEnabled } from '@/lib/storage-core/mode';
import {handleCoreCollectorTraces} from '@/lib/storage-core/collector-traces';
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
  return handleCoreCollectorTraces(req);
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
