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

import { normalizeClaudeOtlpTraces } from '@/lib/ingest/claude-otel/otlp-json';
import { isActrailOtlpTraceBody, normalizeActrailOtlpTraces } from './actrail';
import { isLangfuseOtlpTraceBody, normalizeLangfuseOtlpTraces } from './langfuse';
import { isLlamaIndexOtlpTraceBody, normalizeLlamaIndexOtlpTraces } from './llamaindex';
import { normalizeDifyOtlpTraces, splitDifyOtlpTraces } from './dify';
import type { OtelTraceEvent } from './types';

export function normalizeOtlpTraces(
  body: any,
  opts: { receivedAt?: string; authenticatedUser?: string } = {},
): OtelTraceEvent[] {
  const split = splitDifyOtlpTraces(body);
  if (split.dify.resourceSpans.length) {
    return [
      ...normalizeDifyOtlpTraces(split.dify, opts),
      ...(split.other.resourceSpans.length ? normalizeOtlpTraces(split.other, opts) : []),
    ];
  }
  body = split.other;
  if (isActrailOtlpTraceBody(body)) {
    return normalizeActrailOtlpTraces(body, opts);
  }

  if (isLangfuseOtlpTraceBody(body)) {
    return normalizeLangfuseOtlpTraces(body, opts);
  }
  if (isLlamaIndexOtlpTraceBody(body)) {
    return normalizeLlamaIndexOtlpTraces(body, opts);
  }

  return normalizeClaudeOtlpTraces(body, opts);
}
