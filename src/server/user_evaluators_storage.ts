import fs from 'fs';
import path from 'path';
import { prismaRaw } from '@/lib/storage/prisma';

const DATA_DIR = path.join(process.cwd(), 'data');
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
  const json = JSON.stringify(Array.isArray(items) ? items : []);
  await prismaRaw.customEvaluatorList.upsert({
    where: { user },
    create: { user, itemsJson: json },
    update: { itemsJson: json },
  });
}
