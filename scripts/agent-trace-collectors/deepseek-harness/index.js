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

import { createHash } from 'node:crypto';

export const name = 'agent-insight-deepseek-harness-observability';

const INTEGRATION_VERSION = '0.1.0';
const REDACTION_POLICY = 'v1';
const DEFAULT_MAX_STRING_CHARS = 32768;

const SENSITIVE_KEY = /(?:^|[._-])(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|credential)$/i;
const BEARER_TOKEN = /\bBearer\s+[^\s,;]+/gi;
const SECRET_TOKEN = /\bsk-[A-Za-z0-9._-]+\b/g;
const SECRET_ENV_ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*)=([^\s&]+)/gi;
const SECRET_QUERY_PARAM = /([?&](?:access_token|refresh_token|api_key|token|secret|password)=)[^&#\s]+/gi;

function redactString(value) {
  return value
    .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
    .replace(SECRET_ENV_ASSIGNMENT, '$1=[REDACTED]')
    .replace(SECRET_QUERY_PARAM, '$1[REDACTED]')
    .replace(SECRET_TOKEN, '[REDACTED]');
}

function truncateString(value, maxStringChars) {
  const characters = Array.from(value);
  if (characters.length <= maxStringChars) return value;

  const digest = createHash('sha256').update(value).digest('hex').slice(0, 16);
  return `${characters.slice(0, maxStringChars).join('')}…[truncated chars=${characters.length} sha256=${digest}]`;
}

function transform(value, options, key) {
  if (key && SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    return truncateString(redactString(value), options.maxStringChars);
  }
  if (Array.isArray(value)) {
    return value.map((item) => transform(item, options));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        transform(childValue, options, childKey),
      ]),
    );
  }
  return value;
}

export function redactTelemetryRecord(record, config = {}) {
  const configuredMax = Number(config.maxStringChars);
  const maxStringChars = Number.isFinite(configuredMax) && configuredMax > 0
    ? Math.floor(configuredMax)
    : DEFAULT_MAX_STRING_CHARS;
  const transformed = transform(record, { maxStringChars });

  transformed.attributes = {
    ...(transformed.attributes || {}),
    'agent.insight.integration.name': 'deepseek-harness',
    'agent.insight.integration.version': INTEGRATION_VERSION,
    'agent.insight.redaction.policy': REDACTION_POLICY,
  };
  return transformed;
}

export function apply(ctx, config = {}) {
  ctx.on('session-telemetry/record', (_record, next) => {
    return redactTelemetryRecord(next(), config);
  });
}
