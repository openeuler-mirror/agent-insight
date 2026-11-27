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

import fs from 'fs';
import path from 'path';
import { resolveAgentInsightDataPath } from '@/lib/env';
import { prismaRaw } from '@/lib/storage/prisma';
import { ensureAssetVersion, withEvaluationAssetTransaction } from '@/lib/evaluation-assets/store';
import type { AssetPublication, AssetTransaction } from '@/lib/evaluation-assets/types';

const DATA_DIR = resolveAgentInsightDataPath();
const LEGACY_FILE = path.join(DATA_DIR, 'user_custom_evaluators.json');

/**
 * 自建评估器始终经 Prisma 写入 DATABASE_URL 指向的库（默认 SQLite：data/witty_insight.db
 * 表 CustomEvaluatorList），与是否配置 DB_HOST（OpenGauss）无关。
 */

function ensureLegacyDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readLegacyFileSync(): Record<string, unknown[]> {
  ensureLegacyDir();
  if (!fs.existsSync(LEGACY_FILE)) return {};
  try {
    const raw = fs.readFileSync(LEGACY_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, unknown[]> = {};
    for (const [k, v] of Object.entries(parsed)) {
      out[k] = Array.isArray(v) ? v : [];
    }
    return out;
  } catch {
    return {};
  }
}

function writeLegacyFileSync(store: Record<string, unknown[]>) {
  ensureLegacyDir();
  fs.writeFileSync(LEGACY_FILE, JSON.stringify(store, null, 2));
}

/** 读取某用户的自建评估器 JSON 数组（不做结构校验） */
export async function readUserCustomEvaluators(user: string): Promise<unknown[]> {
  const row = await prismaRaw.customEvaluatorList.findUnique({ where: { user } });
  let parsed: unknown[] = [];
  if (row?.itemsJson) {
    try {
      const data = JSON.parse(row.itemsJson);
      parsed = Array.isArray(data) ? data : [];
    } catch {
      parsed = [];
    }
  }

  if (parsed.length === 0) {
    const store = readLegacyFileSync();
    const legacy = store[user];
    if (Array.isArray(legacy) && legacy.length > 0) {
      await writeUserCustomEvaluators(user, legacy);
      delete store[user];
      writeLegacyFileSync(store);
      return legacy;
    }
  }

  return parsed;
}

/** 覆盖写入某用户的自建评估器列表 */
export async function writeUserCustomEvaluators(user: string, items: unknown[]): Promise<void> {
  items = Array.isArray(items) ? items : [];
  if (!process.env.DB_HOST) {
    await withEvaluationAssetTransaction(tx => writeUserCustomEvaluatorsInTransaction(tx, user, items));
    return;
  }
  const json = JSON.stringify(Array.isArray(items) ? items : []);
  await prismaRaw.customEvaluatorList.upsert({
    where: { user },
    create: { user, itemsJson: json },
    update: { itemsJson: json },
  });
}

export function evaluatorVersionContent(value: object): Record<string, unknown> {
  const card = value as Record<string, unknown>;
  const fields = ['id', 'name', 'description', 'evaluatorType', 'source', 'category', 'targetTypes', 'objectives', 'scenarios', 'runMode', 'scoreRange', 'popularity', 'mappedMetrics', 'status', 'creator', 'pointsDef', 'codeConfig', 'runtimeHref', 'runtimeNote', 'outputDescription'];
  const content = Object.fromEntries(fields.filter(key => card[key] !== undefined).map(key => [key, card[key]]));
  if (card.llmConfig && typeof card.llmConfig === 'object' && !Array.isArray(card.llmConfig)) {
    const llm = card.llmConfig as Record<string, unknown>;
    content.llmConfig = Object.fromEntries(['model', 'systemPrompt', 'userPrompt', 'skills'].filter(key => llm[key] !== undefined).map(key => [key, llm[key]]));
  }
  return content;
}

function evaluatorCards(items: unknown[]): Map<string, Record<string, unknown>> {
  return new Map(items.flatMap(item => item && typeof item === 'object' && !Array.isArray(item) && typeof (item as { id?: unknown }).id === 'string'
    ? [[(item as { id: string }).id, item as Record<string, unknown>] as const] : []));
}

export async function writeUserCustomEvaluatorsInTransaction(tx: AssetTransaction, user: string, items: unknown[], publication?: { evaluatorId: string; note?: string }): Promise<Map<string, AssetPublication>> {
  const row = await tx.customEvaluatorList.findUnique({ where: { user } });
  let old: unknown[] = [];
  if (row) {
    try { const value = JSON.parse(row.itemsJson); if (Array.isArray(value)) old = value; } catch { old = []; }
  }
  const previous = evaluatorCards(old), incoming = evaluatorCards(items);
  for (const [id, card] of previous) {
    await tx.evaluationAssetHead.updateMany({ where: { user, kind: 'evaluator', businessId: id, archived: true }, data: { archived: false } });
    await ensureAssetVersion(tx, { user, kind: 'evaluator', businessId: id, content: evaluatorVersionContent(card), source: 'legacy' });
  }
  await tx.customEvaluatorList.upsert({ where: { user }, create: { user, itemsJson: JSON.stringify(items) }, update: { itemsJson: JSON.stringify(items) } });
  const published = new Map<string, AssetPublication>();
  for (const [id, card] of incoming) {
    await tx.evaluationAssetHead.updateMany({ where: { user, kind: 'evaluator', businessId: id, archived: true }, data: { archived: false } });
    published.set(id, await ensureAssetVersion(tx, { user, kind: 'evaluator', businessId: id, content: evaluatorVersionContent(card), source: publication?.evaluatorId === id ? 'publication' : 'legacy', note: publication?.evaluatorId === id ? publication.note : undefined }));
  }
  for (const id of previous.keys()) if (!incoming.has(id)) await tx.evaluationAssetHead.updateMany({ where: { user, kind: 'evaluator', businessId: id }, data: { archived: true } });
  return published;
}
