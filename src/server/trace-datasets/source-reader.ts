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
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { Prisma, PrismaClient } from '@prisma/client';
import { hash } from '../../lib/trace-datasets/sampling';
import { type Event } from './normalizer';
import { normalizeSourceUnits } from './trace-analysis';
import { processContent } from './content-processor';

export type FrozenConfig = { mappingVersion?: string; from: string; to: string; platform: string; identities: { framework: string | null; agentId: string | null; agentName: string | null; clientId?: string | null }[] };
function timestamp(value: string | number | null) {
  if (typeof value !== 'number') return value || '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}
const select = { id: true, taskId: true, framework: true, agentId: true, agentName: true, clientId: true, isSubagent: true, lastIngestedAt: true, timestamp: true } as const;
export async function atomicJson(file: string, value: unknown) { await fs.writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 }); await fs.rename(`${file}.tmp`, file); }
export async function* lines(file: string) { const stream = createReadStream(file, { encoding: 'utf8' }); const reader = createInterface({ input: stream, crlfDelay: Infinity }); try { for await (const line of reader) if (line) yield JSON.parse(line); } finally { reader.close(); stream.destroy(); } }

async function readSource(db: PrismaClient | Prisma.TransactionClient, id: string, owner: string, includeEvents = true) {
  const read = async (tx: Prisma.TransactionClient) => {
    const execution = await tx.execution.findFirst({ where: { id, user: owner }, select: { ...select, query: true, finalResult: true, failures: true } });
    if (!execution?.taskId) return null;
    const session = await tx.session.findFirst({ where: { taskId: execution.taskId, user: owner }, select: { id: true, endTime: true } });
    if (!session) return null;
    const digest = createHash('sha256').update(JSON.stringify(execution));
    const events: Event[] = [];
    // SQLite projects only visible message and behavior fields; giant tool results never cross into JS.
    for (let offset = 0; includeEvents; offset += 128) {
      const rows = await tx.$queryRawUnsafe<{ role: string | null; content: string | null; channel: string | null; names: string | null; timestamp: string | null; spanId: string | null; traceId: string | null; completedAt: string | null; finishReason: string | null; nonText: number; subagent: number; truncated: number | null; failed: number | null; retry: number | null; delegated: number | null }[]>(`
        SELECT json_extract(j.value,'$.role') role,
          CASE WHEN json_extract(j.value,'$.role') IN ('user','assistant') THEN
            CASE WHEN json_type(j.value,'$.content')='text' THEN json_extract(j.value,'$.content')
              WHEN json_type(j.value,'$.content')='array' THEN (SELECT group_concat(json_extract(p.value,'$.text'),'') FROM json_each(j.value,'$.content') p WHERE json_extract(p.value,'$.type') IN ('text','input_text','output_text')) ELSE NULL END END content,
          COALESCE(json_extract(j.value,'$.channel'),json_extract(j.value,'$.type')) channel,
          (SELECT json_group_array(COALESCE(json_extract(t.value,'$.function.name'),json_extract(t.value,'$.name'))) FROM json_each(j.value,'$.tool_calls') t) names,
          COALESCE(json_extract(j.value,'$.traceId'),json_extract(j.value,'$.trace_id')) traceId,
          COALESCE(json_extract(j.value,'$.timestamp'),json_extract(j.value,'$.timeInfo.created')) timestamp,
          json_extract(j.value,'$.spanId') spanId,
          json_extract(j.value,'$.timeInfo.completed') completedAt,
          COALESCE(json_extract(j.value,'$.finish_reason'),json_extract(j.value,'$.stop_reason'),json_extract(j.value,'$.finish')) finishReason,
          CASE WHEN json_type(j.value,'$.content')='array' THEN EXISTS (SELECT 1 FROM json_each(j.value,'$.content') p WHERE COALESCE(json_extract(p.value,'$.type'),'') NOT IN ('text','input_text','output_text')) ELSE 0 END nonText,
          CASE WHEN json_extract(j.value,'$.subagent_session_id') IS NOT NULL THEN 1 ELSE 0 END subagent,
          COALESCE(json_extract(j.value,'$._payloadDeferred'),json_extract(j.value,'$.truncated'),0) truncated,
          CASE WHEN json_extract(j.value,'$.status') IN ('error','failed') THEN 1 ELSE 0 END failed,
          json_extract(j.value,'$.retry') retry, json_extract(j.value,'$.delegated') delegated
        FROM Session s, json_each(COALESCE(s.interactions,'[]')) j WHERE s.id=? ORDER BY CAST(j.key AS INTEGER) LIMIT 128 OFFSET ?`, session.id, offset);
      for (const r of rows) events.push({ role: r.role || '', content: r.content || '', channel: r.channel || '', toolNames: JSON.parse(r.names || '[]').filter(Boolean), timestamp: timestamp(r.timestamp), completedAt: timestamp(r.completedAt), finishReason: r.finishReason || '', nonText: !!r.nonText, subagent: !!r.subagent, spanId: r.spanId || '', traceId: r.traceId || '', truncated: !!r.truncated, failed: !!r.failed, retry: !!r.retry, delegated: !!r.delegated });
      if (rows.length < 128) break;
    }
    for (let offset = 1; ; offset += 65536) {
      const rows = await tx.$queryRawUnsafe<{ chunk: string | null }[]>('SELECT substr(interactions, ?, 65536) chunk FROM Session WHERE id=?', offset, session.id);
      const chunk = rows[0]?.chunk || '';
      digest.update(chunk);
      if (Array.from(chunk).length < 65536) break;
    }
    digest.update(JSON.stringify(session));
    return { execution, session, events, digest: digest.digest('hex') };
  };
  return '$transaction' in db ? db.$transaction(read, { timeout: 120000, maxWait: 30000 }) : read(db);
}

export async function captureSources(db: PrismaClient, owner: string, config: FrozenConfig, dir: string, check: () => Promise<void>) {
  await fs.mkdir(path.join(dir, 'sources'), { recursive: true, mode: 0o700 });
  const members = path.join(dir, 'members.jsonl');
  try { await fs.access(members); } catch {
    const out = await fs.open(`${members}.tmp`, 'w', 0o600);
    try {
      await db.$transaction(async tx => {
        let cursor: { timestamp: Date; id: string } | undefined;
        for (;;) {
          const rows = await tx.execution.findMany({ where: { user: owner, timestamp: { gte: new Date(config.from), lt: new Date(config.to) }, OR: config.identities, ...(cursor ? { AND: [{ OR: [{ timestamp: { lt: cursor.timestamp } }, { timestamp: cursor.timestamp, id: { gt: cursor.id } }] }] } : {}) }, select, orderBy: [{ timestamp: 'desc' }, { id: 'asc' }], take: 128 });
          for (const row of rows) {
            const revision = await readSource(tx, row.id, owner, false);
            await out.write(`${JSON.stringify({ ...row, sourceDigest: revision?.digest || null })}\n`);
          }
          if (rows.length < 128) break;
          cursor = rows.at(-1)!;
        }
      }, { timeout: 120000, maxWait: 30000 });
    } finally { await out.close(); }
    await fs.rename(`${members}.tmp`, members);
  }
  const sealed = path.join(dir, 'sealed.json');
  try {
    const seal = JSON.parse(await fs.readFile(sealed, 'utf8'));
    if (seal.members !== await fileHash(members)) throw new Error('SOURCE_CORRUPT');
    return;
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  for await (const member of lines(members)) {
    await check();
    const file = path.join(dir, 'sources', `${hash(member.id)}.json`);
    try { await fs.access(file); continue; } catch { /* incomplete member */ }
    let result: Record<string, unknown> = { reason: 'SOURCE_CHANGED' };
    for (let attempt = 0; attempt < 3; attempt++) {
      const first = await readSource(db, member.id, owner, true);
      if (!first) { result = { reason: 'SOURCE_UNAVAILABLE' }; break; }
      if (first.digest !== member.sourceDigest) break;
      const second = await readSource(db, member.id, owner, true);
      if (!second || second.digest !== first.digest) continue;
      let failures: { failure_type?: string }[] = [];
      try { failures = JSON.parse(first.execution.failures || '[]'); } catch { throw new Error('SOURCE_CORRUPT'); }
      const failed = failures.some(f => ['opencode-session-error', 'goal_plus_pi_session_failed', 'agent-process-exit'].includes(f.failure_type || ''));
      const source = { query: first.execution.query || '', finalResult: first.execution.finalResult || '', completed: !!first.session.endTime, failed, isSubagent: first.execution.isSubagent, events: first.events, platform: config.platform };
      const normalized = normalizeSourceUnits(source);
      const units = [];
      for (const unit of normalized.units) units.push(await processContent(unit));
      result = { units, exclusions: normalized.exclusions, sourceId: member.id, revision: first.digest };
      break;
    }
    await atomicJson(file, { ...result, checksum: hash(result) });
  }
  await atomicJson(sealed, { members: await fileHash(members) });
}
export async function fileHash(file: string) { const h = createHash('sha256'); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest('hex'); }
