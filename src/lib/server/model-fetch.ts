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

import type { OpenAI } from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import type { AnyZodObject } from 'zod';
import { getProxyConfig } from '@/lib/ingest/proxy-config';

const ANTHROPIC_HOST = 'api.anthropic.com';
const AZURE_SAMPLING_FIELDS = ['temperature', 'top_p', 'logprobs', 'top_logprobs', 'seed'];

export function getJsonResponseFormat(
  baseURL: string,
  name: string,
  schema: AnyZodObject,
): OpenAI.ResponseFormatJSONObject | OpenAI.ResponseFormatJSONSchema {
  // The Anthropic compatibility endpoint accepts only strict JSON Schema.
  return new URL(baseURL).hostname === ANTHROPIC_HOST
    ? zodResponseFormat(schema, name)
    : { type: 'json_object' };
}

function isModernOpenAIModel(model: string): boolean {
  return /^(?:gpt-[56](?:[.-]|$)|o[134](?:-|$))/i.test(model);
}

export function isClaudeFixedSamplingModel(model: string): boolean {
  // Claude 4.0 snapshot IDs put an eight-digit date after the major version.
  return /^claude-(?:mythos-|[a-z]+-(?:[5-9]|4-(?!\d{8}(?:-|$))(?:[7-9]|\d{2,}))(?:-|$))/i.test(model);
}

export function getModelFetch(fetcher = getProxyConfig().customFetch ?? globalThis.fetch): typeof fetch {
  return async (input, init) => {
    if (init?.method?.toUpperCase() !== 'POST' || typeof init.body !== 'string' || input instanceof Request) {
      return fetcher(input, init);
    }

    const { hostname, pathname } = new URL(input);
    const chat = pathname.endsWith('/chat/completions');
    const azure = hostname.endsWith('.openai.azure.com');
    const azureV1Chat = azure && pathname === '/openai/v1/chat/completions';
    const openai = hostname === 'api.openai.com' || azure;
    const anthropic = hostname === ANTHROPIC_HOST;
    if (!(openai && (chat || pathname.endsWith('/responses'))) && !(anthropic && chat)) {
      return fetcher(input, init);
    }

    const body = JSON.parse(init.body);
    if (openai) {
      if (!azureV1Chat && !isModernOpenAIModel(body.model ?? '')) return fetcher(input, init);
      if (chat && 'max_tokens' in body) {
        body.max_completion_tokens ??= body.max_tokens;
        delete body.max_tokens;
      }
      if (!azureV1Chat) {
        const effort = chat ? body.reasoning_effort : body.reasoning?.effort;
        const allowsSampling = effort === 'none' || (effort == null && /^gpt-5\.[1-4](?:-|$)/i.test(body.model));
        if (!allowsSampling) {
          delete body.temperature;
          delete body.top_p;
          delete body.logprobs;
          delete body.top_logprobs;
        }
        delete body.seed;
      } else if (AZURE_SAMPLING_FIELDS.some(field => Object.hasOwn(body, field))) {
        // Azure deployment names can alias any model, so keep sampling until the service rejects it.
        const response = await fetcher(input, { ...init, body: JSON.stringify(body) });
        if (response.status !== 400 || init.signal?.aborted) return response;

        const payload = await response.clone().json().catch(() => null);
        const { param, code, message } = payload?.error ?? payload ?? {};
        const unsupported = code === 'unsupported_parameter' || code === 'unsupported_value'
          || (code == null && typeof message === 'string' && /^Unsupported (?:parameter|value):/.test(message));
        if (!unsupported || !AZURE_SAMPLING_FIELDS.includes(param) || !Object.hasOwn(body, param) || init.signal?.aborted) {
          return response;
        }

        await response.body?.cancel();
        for (const field of AZURE_SAMPLING_FIELDS) delete body[field];
      }
    } else {
      if (isClaudeFixedSamplingModel(body.model ?? '')) {
        delete body.temperature;
        delete body.top_p;
      } else if (body.temperature != null) {
        delete body.top_p;
      }
    }
    return fetcher(input, { ...init, body: JSON.stringify(body) });
  };
}
