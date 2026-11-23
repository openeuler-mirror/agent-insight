import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {handleCoreCollectorLogs} from '@/lib/storage-core/collector-logs';
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
  return handleCoreCollectorLogs(req);
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
