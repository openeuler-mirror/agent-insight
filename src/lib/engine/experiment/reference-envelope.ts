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

import { parseJsonWithNumericFields } from './json-field-number';

export const WORKSHOP_RUBRIC_VERSION = 'result-workshop-v1';

export type WorkshopReferenceResult =
  | { ok: true; rules: Record<string, unknown> }
  | { ok: false; reasonCode: 'missing_reference' | 'invalid_reference' };

export function decodeWorkshopReference(raw: string | null, metric: string): WorkshopReferenceResult {
  if (raw === null || !raw.trim()) return { ok: false, reasonCode: 'missing_reference' };
  const invalid = (): WorkshopReferenceResult => ({ ok: false, reasonCode: 'invalid_reference' });
  const prefix = 'AI-EVAL-REF-V1:';
  const trimmed = raw.trim();
  if (!trimmed.startsWith(prefix)) return invalid();
  const body = trimmed.slice(prefix.length);
  if (!body || body.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body)) return invalid();
  try {
    const bytes = Buffer.from(body, 'base64');
    if (bytes.toString('base64') !== body) return invalid();
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const payload = parseJsonWithNumericFields(json, ['rules', 'expected']);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return invalid();
    const envelope = payload as Record<string, unknown>;
    if (Object.keys(envelope).some(key => !['rubricVersion', 'metric', 'rules'].includes(key))) return invalid();
    if (envelope.rubricVersion !== WORKSHOP_RUBRIC_VERSION || envelope.metric !== metric) return invalid();
    if (!envelope.rules || typeof envelope.rules !== 'object' || Array.isArray(envelope.rules)) return invalid();
    return { ok: true, rules: envelope.rules as Record<string, unknown> };
  } catch {
    return invalid();
  }
}
