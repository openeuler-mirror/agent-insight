import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { db } from '@/lib/storage/prisma';
import {
  canReuseRootCauseCache,
  hashExpectedOutput,
  normalizeRootCauseItems,
  normalizeRootCauseMeta,
  type DatasetCaseRootCauseMeta,
  type RootCauseItem,
} from '@/lib/dataset-case-root-causes';
import { extractRootCausesFromExpected } from '@/lib/engine/evaluation/root-cause-extractor';
import { resolveAgentInsightDataPath } from '@/lib/env';

const DATA_DIR = resolveAgentInsightDataPath();
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
export type DatasetCaseSource = 'user' | 'skill-gen-draft' | 'trace-backflow';

export type DatasetFieldType = 'text' | 'number' | 'boolean' | 'json';

export interface DatasetField {
  id: string;
  key: string;
  label: string;
  type: DatasetFieldType;
  description?: string;
  system?: boolean;
}

export interface DatasetCase {
  id: string;
  input: string;
  expectedOutput: string;
  evaluationFocus: string;
  tags: string[];
  trajectory: string;
  values?: Record<string, unknown>;
  traceSource?: {
    taskId: string;
    executionId?: string;
    capturedAt: string;
  };
  /** 默认 'user'；存量数据无此字段时按 'user' 兜底。 */
  source?: DatasetCaseSource;
  rootCauses?: RootCauseItem[];
  rootCauseMeta?: DatasetCaseRootCauseMeta;
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
  fields: DatasetField[];
  datasetKind: DatasetKind;
  createdAt: string;
  updatedAt: string;
}

export interface AgentDatasetReferenceCase {
  id: string;
  input: string;
  expectedOutput: string;
  evaluationFocus: string;
  tags: string[];
}

export interface AgentDatasetSummary extends Omit<AgentDatasetRecord, 'cases'> {
  caseCount: number;
}

export interface AgentDatasetReference extends AgentDatasetSummary {
  cases: AgentDatasetReferenceCase[];
}

const DATASET_TRAJECTORY_PREVIEW_CHARS = 600;

function datasetTrajectoryPreview(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length <= DATASET_TRAJECTORY_PREVIEW_CHARS
    ? text
    : `${text.slice(0, DATASET_TRAJECTORY_PREVIEW_CHARS)}…`;
}

export function buildAgentDatasetItemsView(dataset: AgentDatasetRecord): AgentDatasetRecord {
  const trajectoryKeys = new Set(
    dataset.fields
      .map(field => field.key)
      .filter(key => ['trace', 'trajectory'].includes(key.trim().toLocaleLowerCase())),
  );
  trajectoryKeys.add('trace');
  trajectoryKeys.add('trajectory');

  return {
    ...dataset,
    cases: dataset.cases.map(item => {
      const values = { ...(item.values || {}) };
      for (const key of trajectoryKeys) {
        if (Object.hasOwn(values, key)) values[key] = datasetTrajectoryPreview(values[key]);
      }
      return {
        ...item,
        trajectory: datasetTrajectoryPreview(item.trajectory),
        values,
      };
    }),
  };
}

export function buildAgentDatasetProjection(cases: DatasetCase[]): {
  caseCount: number;
  referenceCasesJson: string;
} {
  const normalized = normalizeCases(cases);
  return {
    caseCount: normalized.length,
    referenceCasesJson: JSON.stringify(normalized.map(item => ({
      id: item.id,
      input: item.input,
      expectedOutput: item.expectedOutput,
      evaluationFocus: item.evaluationFocus,
      tags: item.tags,
    }))),
  };
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
  if (value === 'skill-gen-draft' || value === 'trace-backflow') return value;
  return 'user';
}

function normalizeValues(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      typeof item === 'string' ? item.trim() : item,
    ]),
  );
}

export function defaultDatasetFields(kind: DatasetKind): DatasetField[] {
  const fields: DatasetField[] = [
    { id: 'input', key: 'input', label: '输入', type: 'text', system: true },
    { id: 'reference_output', key: 'reference_output', label: '预期输出', type: 'text', system: true },
  ];
  if (kind === 'trajectory') {
    fields.push({ id: 'trajectory', key: 'trajectory', label: '轨迹', type: 'json', system: true });
  }
  return fields;
}

export function normalizeFields(value: unknown, kind: DatasetKind): DatasetField[] {
  if (!Array.isArray(value) || value.length === 0) return defaultDatasetFields(kind);
  const seen = new Set<string>();
  const fields = value.flatMap((item): DatasetField[] => {
    if (!item || typeof item !== 'object') return [];
    const obj = item as Record<string, unknown>;
    const key = String(obj.key || '').trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key) || seen.has(key)) return [];
    seen.add(key);
    const rawType = String(obj.type || 'text');
    const type: DatasetFieldType = ['number', 'boolean', 'json'].includes(rawType)
      ? rawType as DatasetFieldType
      : 'text';
    return [{
      id: String(obj.id || key).trim() || key,
      key,
      label: String(obj.label || key).trim() || key,
      type,
      description: String(obj.description || '').trim() || undefined,
      system: Boolean(obj.system),
    }];
  });
  return fields.length > 0 ? fields : defaultDatasetFields(kind);
}

export function validateDatasetFieldKeysForWrite(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return 'fields must be an array';
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return `field ${index + 1} is invalid`;
    }
    const key = String((item as Record<string, unknown>).key || '').trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
      return `field ${index + 1} key is invalid`;
    }
    if (seen.has(key)) return `field key ${key} already exists`;
    seen.add(key);
  }
  return null;
}

export function duplicateDatasetFieldName(fields: DatasetField[]): string | null {
  const seen = new Set<string>();
  for (const field of fields) {
    const label = field.label.trim();
    const normalized = label.toLocaleLowerCase();
    if (seen.has(normalized)) return label;
    seen.add(normalized);
  }
  return null;
}

export function normalizeCase(item: unknown): DatasetCase {
  const obj = (item || {}) as Partial<DatasetCase>;
  const values = normalizeValues((obj as { values?: unknown }).values);
  const hasInput = Object.prototype.hasOwnProperty.call(obj, 'input');
  const hasInputValue = Object.prototype.hasOwnProperty.call(values, 'input');
  const hasExpectedOutput = Object.prototype.hasOwnProperty.call(obj, 'expectedOutput');
  const hasTrajectory = Object.prototype.hasOwnProperty.call(obj, 'trajectory');
  const input = String(hasInput ? obj.input ?? '' : values.input ?? '').trim();
  const expectedOutput = String(
    hasExpectedOutput ? obj.expectedOutput ?? '' : values.reference_output ?? '',
  ).trim();
  const traceValue = values.trace;
  const trajectoryRaw = (obj as { trajectory?: unknown }).trajectory;
  const trajectory =
    hasTrajectory
      ? trajectoryRaw === null || trajectoryRaw === undefined
        ? ''
        : typeof trajectoryRaw === 'string'
          ? trajectoryRaw.trim()
          : JSON.stringify(trajectoryRaw)
      : traceValue !== undefined
      ? (typeof traceValue === 'string' ? traceValue.trim() : JSON.stringify(traceValue))
      : '';
  return {
    id: obj.id && String(obj.id).trim() ? String(obj.id).trim() : randomUUID(),
    input,
    expectedOutput,
    evaluationFocus: String(obj.evaluationFocus || '').trim(),
    tags: normalizeTags(obj.tags),
    trajectory,
    values: {
      ...values,
      ...(hasInput || hasInputValue ? { input } : {}),
      ...(expectedOutput || Object.hasOwn(values, 'reference_output') ? { reference_output: expectedOutput } : {}),
      ...(trajectory && !Object.hasOwn(values, 'trace') ? { trajectory } : {}),
    },
    source: normalizeCaseSource((obj as { source?: unknown }).source),
    traceSource: (() => {
      const source = (obj as { traceSource?: unknown }).traceSource;
      if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
      const raw = source as Record<string, unknown>;
      const taskId = String(raw.taskId || '').trim();
      if (!taskId) return undefined;
      return {
        taskId,
        executionId: String(raw.executionId || '').trim() || undefined,
        capturedAt: String(raw.capturedAt || '').trim() || new Date().toISOString(),
      };
    })(),
    rootCauses: normalizeRootCauseItems((obj as { rootCauses?: unknown }).rootCauses),
    rootCauseMeta: normalizeRootCauseMeta((obj as { rootCauseMeta?: unknown }).rootCauseMeta),
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
        Object.values(item.values || {}).some(v => v !== '' && v !== null && v !== undefined) ||
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

/** 数据集只负责保存结构化样本；具体评测所需字段由评测执行入口校验。 */
export function validateCasesForKind(
  cases: DatasetCase[],
  kind: DatasetKind,
): CaseValidationError[] {
  void cases;
  void kind;
  return [];
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
    fields: normalizeFields(raw.fields, normalizeDatasetKind(raw.datasetKind)),
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
  fieldsJson: string;
  casesJson: string;
  datasetKind: string;
  createdAt: Date;
  updatedAt: Date;
}): AgentDatasetRecord {
  let tags: unknown = [];
  let casesRaw: unknown = [];
  let fieldsRaw: unknown = [];
  try {
    tags = JSON.parse(row.tagsJson || '[]');
  } catch {
    tags = [];
  }
  try {
    fieldsRaw = JSON.parse(row.fieldsJson || '[]');
  } catch {
    fieldsRaw = [];
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
    fields: normalizeFields(fieldsRaw, normalizeDatasetKind(row.datasetKind)),
    cases: normalizeCases(casesRaw),
    datasetKind: normalizeDatasetKind(row.datasetKind),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function summaryFromDbRow(row: {
  id: string;
  user: string;
  name: string;
  description: string;
  targetAgent: string;
  targetSkill?: string;
  tagsJson: string;
  fieldsJson: string;
  datasetKind: string;
  caseCount: number;
  createdAt: Date;
  updatedAt: Date;
}): AgentDatasetSummary {
  let tags: unknown = [];
  let fields: unknown = [];
  try { tags = JSON.parse(row.tagsJson || '[]'); } catch { tags = []; }
  try { fields = JSON.parse(row.fieldsJson || '[]'); } catch { fields = []; }
  return {
    id: row.id,
    user: row.user,
    name: row.name,
    description: row.description,
    targetAgent: row.targetAgent,
    targetSkill: row.targetSkill ?? '',
    tags: normalizeTags(tags),
    fields: normalizeFields(fields, normalizeDatasetKind(row.datasetKind)),
    datasetKind: normalizeDatasetKind(row.datasetKind),
    caseCount: row.caseCount,
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
      const projection = buildAgentDatasetProjection(r.cases);
      await prisma.agentEvalDataset.create({
        data: {
          id: r.id,
          user: r.user,
          name: r.name,
          description: r.description,
          targetAgent: r.targetAgent,
          targetSkill: r.targetSkill ?? '',
          tagsJson: JSON.stringify(r.tags),
          fieldsJson: JSON.stringify(r.fields),
          casesJson: JSON.stringify(r.cases),
          ...projection,
          projectionReady: true,
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

export async function readUserAgentDatasets(user: string): Promise<AgentDatasetRecord[]> {
  const prisma = tryGetPrisma();
  if (prisma) {
    await migrateLegacyJsonIfNeeded(prisma);
    const rows = await prisma.agentEvalDataset.findMany({
      where: { user },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map(recordFromDbRow);
  }
  warnFileBackendOnce();
  return readLegacyFileSync().filter(item => item.user === user);
}

async function ensureAgentDatasetProjectionsForUser(prisma: PrismaClient, user: string): Promise<void> {
  const pending = await prisma.agentEvalDataset.findMany({
    where: { user, projectionReady: false },
    select: { id: true, casesJson: true, updatedAt: true },
  });
  for (const row of pending) {
    let rawCases: unknown = [];
    try { rawCases = JSON.parse(row.casesJson || '[]'); } catch { rawCases = []; }
    const projection = buildAgentDatasetProjection(normalizeCases(rawCases));
    await prisma.agentEvalDataset.update({
      where: { id: row.id },
      data: { ...projection, projectionReady: true, updatedAt: row.updatedAt },
    });
  }
}

export async function readAgentDatasetSummaries(
  user: string,
  targetSkill?: string,
): Promise<AgentDatasetSummary[]> {
  const prisma = tryGetPrisma();
  if (prisma) {
    await migrateLegacyJsonIfNeeded(prisma);
    await ensureAgentDatasetProjectionsForUser(prisma, user);
    const rows = await prisma.agentEvalDataset.findMany({
      where: { user, ...(targetSkill !== undefined ? { targetSkill } : {}) },
      select: {
        id: true, user: true, name: true, description: true, targetAgent: true,
        targetSkill: true, tagsJson: true, fieldsJson: true, datasetKind: true,
        caseCount: true, createdAt: true, updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map(summaryFromDbRow);
  }
  warnFileBackendOnce();
  return readLegacyFileSync()
    .filter(item => item.user === user && (targetSkill === undefined || item.targetSkill === targetSkill))
    .map(({ cases, ...item }) => ({ ...item, caseCount: cases.length }));
}

export async function readAgentDatasetReferences(
  user: string,
  targetSkill?: string,
): Promise<AgentDatasetReference[]> {
  const prisma = tryGetPrisma();
  if (prisma) {
    await migrateLegacyJsonIfNeeded(prisma);
    await ensureAgentDatasetProjectionsForUser(prisma, user);
    const rows = await prisma.agentEvalDataset.findMany({
      where: { user, ...(targetSkill !== undefined ? { targetSkill } : {}) },
      select: {
        id: true, user: true, name: true, description: true, targetAgent: true,
        targetSkill: true, tagsJson: true, fieldsJson: true, datasetKind: true,
        caseCount: true, referenceCasesJson: true, createdAt: true, updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map(row => {
      let cases: AgentDatasetReferenceCase[] = [];
      try {
        const parsed = JSON.parse(row.referenceCasesJson || '[]');
        if (Array.isArray(parsed)) cases = parsed.map(item => ({
          id: String(item?.id || ''),
          input: String(item?.input || ''),
          expectedOutput: String(item?.expectedOutput || ''),
          evaluationFocus: String(item?.evaluationFocus || ''),
          tags: normalizeTags(item?.tags),
        }));
      } catch { cases = []; }
      return { ...summaryFromDbRow(row), cases };
    });
  }
  warnFileBackendOnce();
  return readLegacyFileSync()
    .filter(item => item.user === user && (targetSkill === undefined || item.targetSkill === targetSkill))
    .map(item => ({
      ...item,
      caseCount: item.cases.length,
      cases: item.cases.map(({ id, input, expectedOutput, evaluationFocus, tags }) => ({
        id, input, expectedOutput, evaluationFocus, tags,
      })),
    }));
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
    const projection = buildAgentDatasetProjection(record.cases);
    await prisma.agentEvalDataset.create({
      data: {
        id: record.id,
        user: record.user,
        name: record.name,
        description: record.description,
        targetAgent: record.targetAgent,
        targetSkill: record.targetSkill ?? '',
        tagsJson: JSON.stringify(record.tags),
        fieldsJson: JSON.stringify(record.fields),
        casesJson: JSON.stringify(record.cases),
        ...projection,
        projectionReady: true,
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
    const projection = buildAgentDatasetProjection(updated.cases);
    const res = await prisma.agentEvalDataset.updateMany({
      where: { id: updated.id, user: updated.user },
      data: {
        name: updated.name,
        description: updated.description,
        targetAgent: updated.targetAgent,
        targetSkill: updated.targetSkill ?? '',
        tagsJson: JSON.stringify(updated.tags),
        fieldsJson: JSON.stringify(updated.fields),
        casesJson: JSON.stringify(updated.cases),
        ...projection,
        projectionReady: true,
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

export interface DatasetRootCauseWarning {
  caseId: string;
  message: string;
}

function buildRootCauseFailureMeta(
  expectedOutput: string,
  nowIso: string,
  error: string,
): DatasetCaseRootCauseMeta {
  return {
    status: 'failed',
    expectedOutputHash: hashExpectedOutput(expectedOutput),
    updatedAt: nowIso,
    error,
  };
}

function buildRootCauseEmptyMeta(nowIso: string): DatasetCaseRootCauseMeta {
  return {
    status: 'empty',
    expectedOutputHash: hashExpectedOutput(''),
    updatedAt: nowIso,
  };
}

function buildRootCauseReadyMeta(expectedOutput: string, nowIso: string): DatasetCaseRootCauseMeta {
  return {
    status: 'ready',
    expectedOutputHash: hashExpectedOutput(expectedOutput),
    updatedAt: nowIso,
  };
}

export interface PrepareDatasetCasesOptions {
  nextCases: DatasetCase[];
  previousCases?: DatasetCase[];
  user?: string | null;
  now?: Date;
  forceRefresh?: boolean;
  retryFailed?: boolean;
  extractor?: (
    caseInput: string,
    expectedOutput: string,
    user?: string | null,
  ) => Promise<RootCauseItem[]>;
}

export interface PrepareDatasetCasesResult {
  cases: DatasetCase[];
  warnings: DatasetRootCauseWarning[];
}

export async function prepareDatasetCasesForPersistence(
  options: PrepareDatasetCasesOptions,
): Promise<PrepareDatasetCasesResult> {
  const {
    nextCases,
    previousCases = [],
    user,
    now = new Date(),
    forceRefresh = false,
    retryFailed = false,
    extractor = extractRootCausesFromExpected,
  } = options;
  const nowIso = now.toISOString();
  const previousById = new Map(previousCases.map(item => [item.id, normalizeCase(item)]));
  const warnings: DatasetRootCauseWarning[] = [];
  const cases: DatasetCase[] = [];

  for (const rawCase of nextCases) {
    const nextCase = normalizeCase(rawCase);
    const prevCase = previousById.get(nextCase.id);

    if (!nextCase.expectedOutput) {
      cases.push({
        ...nextCase,
        rootCauses: [],
        rootCauseMeta: buildRootCauseEmptyMeta(nowIso),
      });
      continue;
    }

    const expectedOutputChanged = prevCase
      ? prevCase.expectedOutput !== nextCase.expectedOutput
      : true;
    const shouldRetryFailed = retryFailed && prevCase?.rootCauseMeta?.status === 'failed';
    const canReusePrev =
      !forceRefresh &&
      !expectedOutputChanged &&
      !shouldRetryFailed &&
      prevCase &&
      canReuseRootCauseCache(prevCase.expectedOutput, prevCase.rootCauseMeta);

    if (canReusePrev) {
      cases.push({
        ...nextCase,
        rootCauses: normalizeRootCauseItems(prevCase.rootCauses),
        rootCauseMeta: prevCase.rootCauseMeta,
      });
      continue;
    }

    try {
      const rootCauses = normalizeRootCauseItems(
        await extractor(nextCase.input, nextCase.expectedOutput, user),
      );
      cases.push({
        ...nextCase,
        rootCauses,
        rootCauseMeta: buildRootCauseReadyMeta(nextCase.expectedOutput, nowIso),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '关键观点提取失败';
      warnings.push({
        caseId: nextCase.id,
        message,
      });
      cases.push({
        ...nextCase,
        rootCauses: [],
        rootCauseMeta: buildRootCauseFailureMeta(nextCase.expectedOutput, nowIso, message),
      });
    }
  }

  return { cases, warnings };
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
