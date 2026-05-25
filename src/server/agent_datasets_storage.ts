import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { db } from '@/lib/storage/prisma';

const DATA_DIR = path.join(process.cwd(), 'data');
const LEGACY_FILE = path.join(DATA_DIR, 'agent_datasets.json');

let fileBackendWarned = false;

function warnFileBackendOnce() {
  if (fileBackendWarned) return;
  fileBackendWarned = true;
  const client = db.getClient();
  if (!(client instanceof PrismaClient)) {
    console.warn(
      '[agent-datasets] 使用 JSON 文件存储（非 Prisma 数据库客户端）。评测集数据在 data/agent_datasets.json。',
    );
  }
}

export type DatasetKind = 'ideal_output' | 'trajectory';

/**
 * Case 来源标记。'user' = 用户手填 / 手编辑（默认）；'skill-gen-draft' = skill 生成
 * pipeline 自动起草。区分用于 UI 提示 + 用户改动率埋点。
 */
export type DatasetCaseSource = 'user' | 'skill-gen-draft';

export interface DatasetCase {
  id: string;
  input: string;
  expectedOutput: string;
  evaluationFocus: string;
  tags: string[];
  trajectory: string;
  /** 默认 'user'；存量数据无此字段时按 'user' 兜底。 */
  source?: DatasetCaseSource;
}

export interface AgentDatasetRecord {
  id: string;
  user: string;
  name: string;
  description: string;
  targetAgent: string;
  /**
   * 服务于哪个 skill；为空表示通用 agent eval（不绑定 skill）。
   * skill 生成自动起草的行为评测集会填这个字段（用 Skill.name）。
   */
  targetSkill: string;
  tags: string[];
  cases: DatasetCase[];
  datasetKind: DatasetKind;
  createdAt: string;
  updatedAt: string;
}

function tryGetPrisma(): PrismaClient | null {
  const client = db.getClient();
  return client instanceof PrismaClient ? client : null;
}

function ensureLegacyDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LEGACY_FILE)) fs.writeFileSync(LEGACY_FILE, JSON.stringify([], null, 2));
}

export function normalizeDatasetKind(value: unknown): DatasetKind {
  return value === 'trajectory' ? 'trajectory' : 'ideal_output';
}

export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => String(item || '').trim())
    .filter(Boolean);
}

function normalizeCaseSource(value: unknown): DatasetCaseSource {
  return value === 'skill-gen-draft' ? 'skill-gen-draft' : 'user';
}

export function normalizeCase(item: unknown): DatasetCase {
  const obj = (item || {}) as Partial<DatasetCase>;
  const trajectoryRaw = (obj as { trajectory?: unknown }).trajectory;
  const trajectory =
    trajectoryRaw === null || trajectoryRaw === undefined
      ? ''
      : typeof trajectoryRaw === 'string'
      ? trajectoryRaw.trim()
      : JSON.stringify(trajectoryRaw);
  return {
    id: obj.id && String(obj.id).trim() ? String(obj.id).trim() : randomUUID(),
    input: String(obj.input || '').trim(),
    expectedOutput: String(obj.expectedOutput || '').trim(),
    evaluationFocus: String(obj.evaluationFocus || '').trim(),
    tags: normalizeTags(obj.tags),
    trajectory,
    source: normalizeCaseSource((obj as { source?: unknown }).source),
  };
}

export function normalizeCases(value: unknown): DatasetCase[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeCase)
    .filter(
      item =>
        item.input ||
        item.expectedOutput ||
        item.evaluationFocus ||
        item.trajectory ||
        item.tags.length > 0,
    );
}

export interface CaseValidationError {
  caseIndex: number;
  caseId: string;
  field: 'input' | 'expectedOutput' | 'trajectory';
  code: 'required';
  message: string;
}

/**
 * 按 datasetKind 校验 case 必填项与字段格式：
 * - 任意类型：input 必填
 * - ideal_output：expectedOutput 必填
 * - trajectory：trajectory 为可选文本
 *
 * 仅对 normalizeCases 之后剩余的非空 case 生效；空数组合法（允许新建后再补 case）。
 */
export function validateCasesForKind(
  cases: DatasetCase[],
  kind: DatasetKind,
): CaseValidationError[] {
  const errors: CaseValidationError[] = [];
  cases.forEach((c, idx) => {
    const rowLabel = `第 ${idx + 1} 行`;
    if (!c.input) {
      errors.push({
        caseIndex: idx,
        caseId: c.id,
        field: 'input',
        code: 'required',
        message: `${rowLabel}：input（输入）不能为空`,
      });
    }
    if (kind === 'ideal_output') {
      if (!c.expectedOutput) {
        errors.push({
          caseIndex: idx,
          caseId: c.id,
          field: 'expectedOutput',
          code: 'required',
          message: `${rowLabel}：expectedOutput（理想输出）不能为空（理想输出评测集要求）`,
        });
      }
    }
  });
  return errors;
}

function normalizeStoredDataset(raw: Record<string, unknown>): AgentDatasetRecord {
  return {
    id: String(raw.id || ''),
    user: String(raw.user || ''),
    name: String(raw.name || ''),
    description: String(raw.description || ''),
    targetAgent: String(raw.targetAgent || ''),
    targetSkill: String(raw.targetSkill || ''),
    tags: normalizeTags(raw.tags),
    cases: Array.isArray(raw.cases) ? (raw.cases as unknown[]).map(normalizeCase) : [],
    datasetKind: normalizeDatasetKind(raw.datasetKind),
    createdAt: String(raw.createdAt || ''),
    updatedAt: String(raw.updatedAt || ''),
  };
}

function recordFromDbRow(row: {
  id: string;
  user: string;
  name: string;
  description: string;
  targetAgent: string;
  targetSkill?: string;
  tagsJson: string;
  casesJson: string;
  datasetKind: string;
  createdAt: Date;
  updatedAt: Date;
}): AgentDatasetRecord {
  let tags: unknown = [];
  let casesRaw: unknown = [];
  try {
    tags = JSON.parse(row.tagsJson || '[]');
  } catch {
    tags = [];
  }
  try {
    casesRaw = JSON.parse(row.casesJson || '[]');
  } catch {
    casesRaw = [];
  }
  return {
    id: row.id,
    user: row.user,
    name: row.name,
    description: row.description,
    targetAgent: row.targetAgent,
    targetSkill: row.targetSkill ?? '',
    tags: normalizeTags(tags),
    cases: normalizeCases(casesRaw),
    datasetKind: normalizeDatasetKind(row.datasetKind),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function readLegacyFileSync(): AgentDatasetRecord[] {
  ensureLegacyDir();
  try {
    const raw = fs.readFileSync(LEGACY_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item: unknown) =>
        item && typeof item === 'object' ? normalizeStoredDataset(item as Record<string, unknown>) : null,
      )
      .filter((d): d is AgentDatasetRecord => d !== null && Boolean(d.id) && Boolean(d.user));
  } catch {
    return [];
  }
}

function writeLegacyFileSync(datasets: AgentDatasetRecord[]) {
  ensureLegacyDir();
  fs.writeFileSync(LEGACY_FILE, JSON.stringify(datasets, null, 2));
}

let legacyMigration: Promise<void> | null = null;

async function migrateLegacyJsonIfNeeded(prisma: PrismaClient): Promise<void> {
  if (legacyMigration) return legacyMigration;

  legacyMigration = (async () => {
    const count = await prisma.agentEvalDataset.count();
    if (count > 0) {
      if (fs.existsSync(LEGACY_FILE)) {
        try {
          fs.renameSync(LEGACY_FILE, `${LEGACY_FILE}.bak.${Date.now()}`);
        } catch {
          /* ignore */
        }
      }
      return;
    }

    if (!fs.existsSync(LEGACY_FILE)) return;

    let list: AgentDatasetRecord[];
    try {
      const raw = fs.readFileSync(LEGACY_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      list = parsed
        .map((item: unknown) =>
          item && typeof item === 'object' ? normalizeStoredDataset(item as Record<string, unknown>) : null,
        )
        .filter((d): d is AgentDatasetRecord => d !== null && Boolean(d.id) && Boolean(d.user));
    } catch {
      return;
    }

    if (list.length === 0) return;

    for (const r of list) {
      await prisma.agentEvalDataset.create({
        data: {
          id: r.id,
          user: r.user,
          name: r.name,
          description: r.description,
          targetAgent: r.targetAgent,
          targetSkill: r.targetSkill ?? '',
          tagsJson: JSON.stringify(r.tags),
          casesJson: JSON.stringify(r.cases),
          datasetKind: r.datasetKind,
          createdAt: r.createdAt ? new Date(r.createdAt) : new Date(),
          updatedAt: r.updatedAt ? new Date(r.updatedAt) : new Date(),
        },
      });
    }

    try {
      fs.renameSync(LEGACY_FILE, `${LEGACY_FILE}.migrated.${Date.now()}`);
    } catch {
      /* ignore */
    }
  })();

  return legacyMigration;
}

/** 全部评测集（仅 Prisma 路径会做 JSON 文件一次性迁移） */
export async function readAllAgentDatasets(): Promise<AgentDatasetRecord[]> {
  const prisma = tryGetPrisma();
  if (prisma) {
    await migrateLegacyJsonIfNeeded(prisma);
    const rows = await prisma.agentEvalDataset.findMany({ orderBy: { updatedAt: 'desc' } });
    return rows.map(recordFromDbRow);
  }
  warnFileBackendOnce();
  return readLegacyFileSync();
}

export async function findAgentDataset(user: string, id: string): Promise<AgentDatasetRecord | null> {
  const prisma = tryGetPrisma();
  if (prisma) {
    await migrateLegacyJsonIfNeeded(prisma);
    const row = await prisma.agentEvalDataset.findFirst({
      where: { id, user },
    });
    return row ? recordFromDbRow(row) : null;
  }
  warnFileBackendOnce();
  return readLegacyFileSync().find(d => d.id === id && d.user === user) ?? null;
}

export async function createAgentDatasetRecord(record: AgentDatasetRecord): Promise<void> {
  const prisma = tryGetPrisma();
  if (prisma) {
    await migrateLegacyJsonIfNeeded(prisma);
    await prisma.agentEvalDataset.create({
      data: {
        id: record.id,
        user: record.user,
        name: record.name,
        description: record.description,
        targetAgent: record.targetAgent,
        targetSkill: record.targetSkill ?? '',
        tagsJson: JSON.stringify(record.tags),
        casesJson: JSON.stringify(record.cases),
        datasetKind: record.datasetKind,
        createdAt: new Date(record.createdAt),
        updatedAt: new Date(record.updatedAt),
      },
    });
    return;
  }
  warnFileBackendOnce();
  const datasets = readLegacyFileSync();
  datasets.push(record);
  writeLegacyFileSync(datasets);
}

export async function updateAgentDatasetRecord(updated: AgentDatasetRecord): Promise<boolean> {
  const prisma = tryGetPrisma();
  if (prisma) {
    await migrateLegacyJsonIfNeeded(prisma);
    const res = await prisma.agentEvalDataset.updateMany({
      where: { id: updated.id, user: updated.user },
      data: {
        name: updated.name,
        description: updated.description,
        targetAgent: updated.targetAgent,
        targetSkill: updated.targetSkill ?? '',
        tagsJson: JSON.stringify(updated.tags),
        casesJson: JSON.stringify(updated.cases),
        datasetKind: updated.datasetKind,
        updatedAt: new Date(updated.updatedAt),
      },
    });
    return res.count > 0;
  }
  warnFileBackendOnce();
  const datasets = readLegacyFileSync();
  const index = datasets.findIndex(item => item.id === updated.id && item.user === updated.user);
  if (index === -1) return false;
  datasets[index] = updated;
  writeLegacyFileSync(datasets);
  return true;
}

/**
 * 拉某 user 下挂在指定 skill 上的所有评测集（behavior eval set 用）。
 * 不传 targetSkill 或传空串：返回通用 agent eval（targetSkill === ''）。
 */
export async function findAgentDatasetsByTargetSkill(
  user: string,
  targetSkill: string,
): Promise<AgentDatasetRecord[]> {
  const prisma = tryGetPrisma();
  if (prisma) {
    await migrateLegacyJsonIfNeeded(prisma);
    const rows = await prisma.agentEvalDataset.findMany({
      where: { user, targetSkill },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map(recordFromDbRow);
  }
  warnFileBackendOnce();
  return readLegacyFileSync().filter(d => d.user === user && (d.targetSkill ?? '') === targetSkill);
}

export async function deleteAgentDataset(user: string, id: string): Promise<boolean> {
  const prisma = tryGetPrisma();
  if (prisma) {
    await migrateLegacyJsonIfNeeded(prisma);
    const res = await prisma.agentEvalDataset.deleteMany({ where: { id, user } });
    return res.count > 0;
  }
  warnFileBackendOnce();
  const datasets = readLegacyFileSync();
  const next = datasets.filter(d => !(d.id === id && d.user === user));
  if (next.length === datasets.length) return false;
  writeLegacyFileSync(next);
  return true;
}
