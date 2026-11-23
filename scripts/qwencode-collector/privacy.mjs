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

const maxContentLength = 2_000;
const sensitiveKeyPattern = /api[-_]?key|authorization|cookie|password|secret|token/i;

export function truncateContent(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length <= maxContentLength
    ? text
    : `${text.slice(0, maxContentLength)}…[truncated]`;
}

export function redactSensitive(value, key = '') {
  if (sensitiveKeyPattern.test(key)) return '[REDACTED]';

  if (typeof value === 'string') {
    return truncateContent(
      value
        .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
        .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]'),
    );
  }

  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactSensitive(entryValue, entryKey)]),
    );
  }

  return value;
}
