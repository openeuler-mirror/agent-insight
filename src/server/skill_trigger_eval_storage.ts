/**
 * Skill 触发评价集（TriggerTestSet）存储层。
 *
 * 模型：SkillTriggerEvalSet + SkillTriggerEvalRun（见 prisma/schema.prisma）。
 * 设计：docs/designs/agents/skill-eval-datasets/design.md。
 *
 * 为什么不复用 AgentEvalDataset：触发集 case 形态是 {query, shouldTrigger}，
 * 跟 ideal_output 的 {input, expectedOutput} 完全不是一码事——强塞会让
 * datasetKind 变杂物间。
 *
 * 与 agent_datasets_storage.ts 的区别：触发集没有 JSON 文件兜底（项目早已切到
 * Prisma 路径），所以本模块**只走 Prisma**，没 client 时直接抛错。
 */

import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { db } from '@/lib/storage/prisma';

// =========================================================================
// Types
// =========================================================================

/** Trigger 集 case 来源。 */
export type TriggerItemSource = 'llm-draft' | 'user-added' | 'user-edited' | 'trace-mined';

/** Trigger 集单条 query 项。 */
export interface TriggerItem {
  id: string;
  query: string;
  shouldTrigger: boolean;
  /** 起草时 LLM 给的"为什么这条用于测什么"，optional。 */
  rationale?: string;
  source: TriggerItemSource;
}

export type TriggerSetStatus = 'drafting' | 'ready';

/** 一个数据集版本是怎么来的。 */
export type TriggerSetVersionSource = 'llm-draft' | 'user-upload' | 'manual';

/** 触发评价集记录（一行 = 一个版本快照）。 */
export interface SkillTriggerEvalSetRecord {
  id: string;
  user: string;
  skillName: string;
  /** (user, skillName) 下的版本号；最大值即「latest / 当前可编辑版本」 */
  version: number;
  /** 该版本怎么来 */
  versionSource: TriggerSetVersionSource;
  /** 可选备注（上传时落文件名，AI 起草时落模型名等） */
  versionNote: string | null;
  description: string;
  items: TriggerItem[];
  draftedFromSkillHash: string | null;
  status: TriggerSetStatus;
  createdAt: string;
  updatedAt: string;
}

/** Run 单条 query 的命中结果。 */
export interface TriggerRunResultItem {
  itemId: string;
  query: string;
  shouldTrigger: boolean;
  /** runsPerQuery 次里实际触发了几次 */
  runsTriggered: number;
  runsTotal: number;
  /** runsTriggered / runsTotal */
  triggerRate: number;
  /** 跟 shouldTrigger 比对后是否 pass */
  pass: boolean;
  /** runsPerQuery 次的平均 latency；abort 触发的算实际 abort 前的 latency */
  latencyMsAvg: number;
  /**
   * 兄弟竞争诊断：若该 query 没触发本 skill 但触发了另一个 skill，记录那个 skill 名。
   * 用户可凭此分析"被谁抢了"。
   */
  competingSkill?: string;
}

export type TriggerRunStatus = 'running' | 'done' | 'failed';

/** 触发评测一次跑的记录。 */
export interface SkillTriggerEvalRunRecord {
  id: string;
  user: string;
  skillName: string;
  skillVersion: number;
  triggerSetId: string;
  results: TriggerRunResultItem[];
  passRate: number;
  truePositiveRate: number;
  falsePositiveRate: number;
  runsPerQuery: number;
  triggerThreshold: number;
  timeoutMs: number;
  durationMs: number | null;
  modelId: string | null;
  workspaceRoot: string | null;
  status: TriggerRunStatus;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

// =========================================================================
// Helpers
// =========================================================================

function requirePrisma(): PrismaClient {
  const client = db.getClient();
  if (!(client instanceof PrismaClient)) {
    throw new Error(
      'SkillTriggerEval storage requires the Prisma client. ' +
        '(项目应已切到 Prisma；如果在用 JSON 文件兜底，需要 lift 一下基础设施。)',
    );
  }
  return client;
}

function normalizeSource(value: unknown): TriggerItemSource {
  switch (value) {
    case 'llm-draft':
    case 'user-added':
    case 'user-edited':
    case 'trace-mined':
      return value;
    default:
      return 'user-added';
  }
}

function normalizeItem(raw: unknown): TriggerItem {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : randomUUID();
  return {
    id,
    query: typeof obj.query === 'string' ? obj.query.trim() : '',
    shouldTrigger: Boolean(obj.shouldTrigger),
    rationale: typeof obj.rationale === 'string' && obj.rationale.trim() ? obj.rationale.trim() : undefined,
    source: normalizeSource(obj.source),
  };
}

export function normalizeItems(raw: unknown): TriggerItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeItem).filter(item => item.query.length > 0);
}

function normalizeVersionSource(value: unknown): TriggerSetVersionSource {
  switch (value) {
    case 'llm-draft':
    case 'user-upload':
    case 'manual':
      return value;
    default:
      return 'manual';
  }
}

function setRecordFromRow(row: {
  id: string;
  user: string;
  skillName: string;
  version: number;
  versionSource: string;
  versionNote: string | null;
  description: string;
  itemsJson: string;
  draftedFromSkillHash: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): SkillTriggerEvalSetRecord {
  let items: TriggerItem[] = [];
  try {
    items = normalizeItems(JSON.parse(row.itemsJson || '[]'));
  } catch {
    items = [];
  }
  return {
    id: row.id,
    user: row.user,
    skillName: row.skillName,
    version: row.version,
    versionSource: normalizeVersionSource(row.versionSource),
    versionNote: row.versionNote,
    description: row.description,
    items,
    draftedFromSkillHash: row.draftedFromSkillHash,
    status: row.status === 'drafting' ? 'drafting' : 'ready',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function runRecordFromRow(row: {
  id: string;
  user: string;
  skillName: string;
  skillVersion: number;
  triggerSetId: string;
  resultsJson: string;
  passRate: number;
  truePositiveRate: number;
  falsePositiveRate: number;
  runsPerQuery: number;
  triggerThreshold: number;
  timeoutMs: number;
  durationMs: number | null;
  modelId: string | null;
  workspaceRoot: string | null;
  status: string;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}): SkillTriggerEvalRunRecord {
  let results: TriggerRunResultItem[] = [];
  try {
    const raw = JSON.parse(row.resultsJson || '[]');
    if (Array.isArray(raw)) results = raw as TriggerRunResultItem[];
  } catch {
    results = [];
  }
  const status: TriggerRunStatus = row.status === 'done' ? 'done' : row.status === 'failed' ? 'failed' : 'running';
  return {
    id: row.id,
    user: row.user,
    skillName: row.skillName,
    skillVersion: row.skillVersion,
    triggerSetId: row.triggerSetId,
    results,
    passRate: row.passRate,
    truePositiveRate: row.truePositiveRate,
    falsePositiveRate: row.falsePositiveRate,
    runsPerQuery: row.runsPerQuery,
    triggerThreshold: row.triggerThreshold,
    timeoutMs: row.timeoutMs,
    durationMs: row.durationMs,
    modelId: row.modelId,
    workspaceRoot: row.workspaceRoot,
    status,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// =========================================================================
// SkillTriggerEvalSet CRUD
// =========================================================================

/** 取 (user, skillName) 下最新的版本（version desc 第一条）；不存在返回 null。 */
export async function findLatestTriggerEvalSet(
  user: string,
  skillName: string,
): Promise<SkillTriggerEvalSetRecord | null> {
  const prisma = requirePrisma();
  const row = await prisma.skillTriggerEvalSet.findFirst({
    where: { user, skillName },
    orderBy: { version: 'desc' },
  });
  return row ? setRecordFromRow(row) : null;
}

/**
 * 老接口名保留——大部分调用方语义就是「拿最新那份」。新增 latest 名称只是把语义讲清。
 * @deprecated 用 findLatestTriggerEvalSet 表达意图更清楚。
 */
export const findTriggerEvalSet = findLatestTriggerEvalSet;

/** 按 id 取某个具体版本（用于跑评测 / 切到历史版本）。 */
export async function findTriggerEvalSetById(
  id: string,
): Promise<SkillTriggerEvalSetRecord | null> {
  const prisma = requirePrisma();
  const row = await prisma.skillTriggerEvalSet.findUnique({ where: { id } });
  return row ? setRecordFromRow(row) : null;
}

/** 列出 (user, skillName) 下所有版本，version desc。 */
export async function listTriggerEvalSetVersions(
  user: string,
  skillName: string,
): Promise<SkillTriggerEvalSetRecord[]> {
  const prisma = requirePrisma();
  const rows = await prisma.skillTriggerEvalSet.findMany({
    where: { user, skillName },
    orderBy: { version: 'desc' },
  });
  return rows.map(setRecordFromRow);
}

/**
 * 新建一个版本——AI 起草 / 上传都走这条。version 取 max+1（不存在则 1）。
 * **不**就地覆盖现有行；要原地改 items 见 replaceTriggerEvalItemsById。
 */
export async function createTriggerEvalSetVersion(args: {
  user: string;
  skillName: string;
  items: TriggerItem[];
  versionSource: TriggerSetVersionSource;
  versionNote?: string | null;
  description?: string;
  draftedFromSkillHash?: string | null;
  status?: TriggerSetStatus;
}): Promise<SkillTriggerEvalSetRecord> {
  const prisma = requirePrisma();
  const top = await prisma.skillTriggerEvalSet.findFirst({
    where: { user: args.user, skillName: args.skillName },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const nextVersion = (top?.version ?? 0) + 1;
  const row = await prisma.skillTriggerEvalSet.create({
    data: {
      user: args.user,
      skillName: args.skillName,
      version: nextVersion,
      versionSource: args.versionSource,
      versionNote: args.versionNote ?? null,
      description: args.description ?? '',
      itemsJson: JSON.stringify(args.items),
      draftedFromSkillHash: args.draftedFromSkillHash ?? null,
      status: args.status ?? 'ready',
    },
  });
  return setRecordFromRow(row);
}

/**
 * 兜底：(user, skillName) 不存在任何版本时新建 v1；存在则**返回最新版本不动**。
 * 用于 GET 时给一个空数据集起个底。**不会**覆盖任何已有数据。
 */
export async function ensureTriggerEvalSet(args: {
  user: string;
  skillName: string;
  description?: string;
}): Promise<SkillTriggerEvalSetRecord> {
  const latest = await findLatestTriggerEvalSet(args.user, args.skillName);
  if (latest) return latest;
  return createTriggerEvalSetVersion({
    user: args.user,
    skillName: args.skillName,
    items: [],
    versionSource: 'manual',
    description: args.description,
  });
}

/**
 * @deprecated 旧调用方习惯叫 upsert——新增版本用 createTriggerEvalSetVersion，
 *             兜底空建用 ensureTriggerEvalSet，原地改 items 用 replaceTriggerEvalItemsById。
 *             这里的语义保留为「在 latest 上原地改」以兼容老代码；不要在新代码里用它。
 */
export async function upsertTriggerEvalSet(args: {
  user: string;
  skillName: string;
  description?: string;
  items: TriggerItem[];
  draftedFromSkillHash?: string | null;
  status?: TriggerSetStatus;
}): Promise<SkillTriggerEvalSetRecord> {
  const prisma = requirePrisma();
  const latest = await findLatestTriggerEvalSet(args.user, args.skillName);
  if (!latest) {
    return createTriggerEvalSetVersion({
      user: args.user,
      skillName: args.skillName,
      items: args.items,
      versionSource: 'manual',
      description: args.description,
      draftedFromSkillHash: args.draftedFromSkillHash,
      status: args.status,
    });
  }
  const row = await prisma.skillTriggerEvalSet.update({
    where: { id: latest.id },
    data: {
      itemsJson: JSON.stringify(args.items),
      description: args.description,
      draftedFromSkillHash: args.draftedFromSkillHash ?? undefined,
      status: args.status ?? undefined,
    },
  });
  return setRecordFromRow(row);
}

/** 原地改某个版本的 items。返回更新后的 record；id 不存在返回 null。 */
export async function replaceTriggerEvalItemsById(
  id: string,
  items: TriggerItem[],
): Promise<SkillTriggerEvalSetRecord | null> {
  const prisma = requirePrisma();
  try {
    const row = await prisma.skillTriggerEvalSet.update({
      where: { id },
      data: { itemsJson: JSON.stringify(items) },
    });
    return setRecordFromRow(row);
  } catch {
    return null;
  }
}

/**
 * 老接口：按 (user, skillName) 改 items —— 等价于改 latest。
 * @deprecated 改用 replaceTriggerEvalItemsById（明确按版本 id）。
 */
export async function replaceTriggerEvalItems(
  user: string,
  skillName: string,
  items: TriggerItem[],
): Promise<SkillTriggerEvalSetRecord | null> {
  const latest = await findLatestTriggerEvalSet(user, skillName);
  if (!latest) return null;
  return replaceTriggerEvalItemsById(latest.id, items);
}

/** 删除 (user, skillName) 下所有版本。 */
export async function deleteTriggerEvalSet(user: string, skillName: string): Promise<boolean> {
  const prisma = requirePrisma();
  const res = await prisma.skillTriggerEvalSet.deleteMany({ where: { user, skillName } });
  return res.count > 0;
}

// =========================================================================
// SkillTriggerEvalRun CRUD
// =========================================================================

/** 创建一条 run 记录（初始 status=running）。 */
export async function createTriggerEvalRun(args: {
  user: string;
  skillName: string;
  skillVersion: number;
  triggerSetId: string;
  runsPerQuery: number;
  triggerThreshold: number;
  timeoutMs: number;
  modelId: string | null;
  workspaceRoot: string | null;
}): Promise<SkillTriggerEvalRunRecord> {
  const prisma = requirePrisma();
  const row = await prisma.skillTriggerEvalRun.create({
    data: {
      user: args.user,
      skillName: args.skillName,
      skillVersion: args.skillVersion,
      triggerSetId: args.triggerSetId,
      resultsJson: '[]',
      passRate: 0,
      truePositiveRate: 0,
      falsePositiveRate: 0,
      runsPerQuery: args.runsPerQuery,
      triggerThreshold: args.triggerThreshold,
      timeoutMs: args.timeoutMs,
      modelId: args.modelId,
      workspaceRoot: args.workspaceRoot,
      status: 'running',
    },
  });
  return runRecordFromRow(row);
}

/** Finalize 一条 run（写入 results + 聚合分数 + 标 done/failed + 时长）。 */
export async function finalizeTriggerEvalRun(args: {
  id: string;
  results: TriggerRunResultItem[];
  passRate: number;
  truePositiveRate: number;
  falsePositiveRate: number;
  durationMs: number;
  status: TriggerRunStatus;
  errorMessage?: string | null;
}): Promise<SkillTriggerEvalRunRecord> {
  const prisma = requirePrisma();
  const row = await prisma.skillTriggerEvalRun.update({
    where: { id: args.id },
    data: {
      resultsJson: JSON.stringify(args.results),
      passRate: args.passRate,
      truePositiveRate: args.truePositiveRate,
      falsePositiveRate: args.falsePositiveRate,
      durationMs: args.durationMs,
      status: args.status,
      errorMessage: args.errorMessage ?? null,
    },
  });
  return runRecordFromRow(row);
}

export async function findTriggerEvalRun(user: string, id: string): Promise<SkillTriggerEvalRunRecord | null> {
  const prisma = requirePrisma();
  const row = await prisma.skillTriggerEvalRun.findFirst({ where: { id, user } });
  return row ? runRecordFromRow(row) : null;
}

/** 拉 (user, skillName, skillVersion?) 的 run 历史，最新在前。 */
export async function listTriggerEvalRuns(
  user: string,
  skillName: string,
  opts?: { skillVersion?: number; limit?: number },
): Promise<SkillTriggerEvalRunRecord[]> {
  const prisma = requirePrisma();
  const rows = await prisma.skillTriggerEvalRun.findMany({
    where: {
      user,
      skillName,
      ...(opts?.skillVersion !== undefined ? { skillVersion: opts.skillVersion } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: opts?.limit ?? 50,
  });
  return rows.map(runRecordFromRow);
}

/** 拉某 skill 最近一次 done 的 run（用于分析页"触发分析"卡显示分数）。 */
export async function findLatestDoneRun(
  user: string,
  skillName: string,
  skillVersion?: number,
): Promise<SkillTriggerEvalRunRecord | null> {
  const prisma = requirePrisma();
  const row = await prisma.skillTriggerEvalRun.findFirst({
    where: {
      user,
      skillName,
      status: 'done',
      ...(skillVersion !== undefined ? { skillVersion } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
  return row ? runRecordFromRow(row) : null;
}
