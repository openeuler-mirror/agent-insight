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

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getWorkspaceRoot, sanitizeUserSlug } from '@/lib/engine/general-agent/workspace';
import type { DiagnosisProgressSnapshot, DiagnosisProgressWriter } from './progress-types';

interface ProgressIdentity { user: string; executionId: string; runId: string }
const MAX_EVENTS = 200;
const MAX_BYTES = 1024 * 1024;

export function progressFile(identity: ProgressIdentity): string {
  const key = createHash('sha256').update(JSON.stringify([identity.executionId, identity.runId])).digest('hex');
  return path.join(getWorkspaceRoot(), sanitizeUserSlug(identity.user), '.diagnosis-progress', `${key}.json`);
}

export function sanitizeProgressText(value: string): string {
  return String(value).replace(/(["'](?:api[_-]?key|token|password|secret|authorization)["']\s*:\s*)["'][^"']*["']/gi, '$1"[redacted]"').replace(/(?:Bearer\s+)[\w.+/=-]+/gi, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|token|password|secret|authorization)\s*[=:]\s*)[^\s,;"}]+/gi, '$1[redacted]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 1000);
}

export function createDiagnosisProgress(identity: ProgressIdentity): DiagnosisProgressWriter {
  const state: DiagnosisProgressSnapshot = { runId: identity.runId, events: [], lastProgressAt: null, unavailable: false, truncated: false };
  const keys = new Set<string>();
  let seq = 0;
  const persist = () => {
    try {
      const file = progressFile(identity);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch {
      state.unavailable = true;
    }
  };
  return {
    runId: identity.runId,
    emit(event) {
      if (keys.has(event.key)) return;
      keys.add(event.key);
      if (keys.size > 2000) keys.delete(keys.values().next().value!);
      const at = new Date().toISOString();
      state.events.push({ ...event, key: event.key.slice(0, 180), title: sanitizeProgressText(event.title).slice(0, 160), summary: sanitizeProgressText(event.summary), refs: event.refs?.slice(0, 12), seq: ++seq, at });
      if (state.events.length > MAX_EVENTS) { state.events.shift(); state.truncated = true; }
      state.lastProgressAt = at;
      persist();
    },
    snapshot: () => structuredClone(state),
    unavailable() { state.unavailable = true; persist(); },
  };
}

export function readDiagnosisProgress(identity: ProgressIdentity): DiagnosisProgressSnapshot | null {
  try {
    const file = progressFile(identity);
    if (!fs.existsSync(file)) return null;
    if (fs.statSync(file).size > MAX_BYTES) throw new Error('progress size limit');
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as DiagnosisProgressSnapshot;
    if (data.runId !== identity.runId || !Array.isArray(data.events) || data.events.length > MAX_EVENTS) throw new Error('invalid progress');
    const kinds = ['task', 'tool', 'evidence', 'analysis', 'stage'];
    const states = ['started', 'update', 'completed', 'failed', 'skipped'];
    if (data.events.some((event, index) => !event || !Number.isInteger(event.seq)
      || event.seq <= (data.events[index - 1]?.seq ?? 0)
      || typeof event.title !== 'string' || typeof event.summary !== 'string'
      || !Number.isFinite(Date.parse(event.at)) || !kinds.includes(event.kind) || !states.includes(event.state)
      || (event.refs != null && (!Array.isArray(event.refs) || event.refs.some(ref => !ref || !Number.isInteger(ref.traceStepIndex)))))
      || (data.lastProgressAt != null && !Number.isFinite(Date.parse(data.lastProgressAt)))) throw new Error('invalid events');
    return data;
  } catch {
    return { runId: identity.runId, events: [], lastProgressAt: null, unavailable: true, truncated: false };
  }
}
