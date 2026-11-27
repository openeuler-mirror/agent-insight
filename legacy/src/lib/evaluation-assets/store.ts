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

import type { EvaluationAssetHead, PrismaClient } from '@prisma/client';
import { assetContentHash, assetContentObject, canonicalAssetJson } from './canonical';
import { assertAssetIdentity } from './identity';
import {
  EvaluationAssetError, type AssetDraft, type AssetIdentity, type AssetPublication, type AssetQueries,
  type AssetTransaction, type AssetVersion, type AssetVersionInput, type AssetVersionSummary, type DatasetAssetIdentity,
} from './types';

const conflict = (message: string) => new EvaluationAssetError(message, 409, 'ASSET_CONFLICT');
const missing = () => new EvaluationAssetError('资产版本不存在或无权访问', 404, 'ASSET_NOT_FOUND');
const datasetIdentity = (identity: DatasetAssetIdentity): AssetIdentity => ({ user: identity.user, businessId: identity.businessId, kind: 'dataset' });
const versionContent = <T extends { contentJson: string }>(row: T) => ({ ...row, content: assetContentObject(JSON.parse(row.contentJson)) });

async function ownedHead(client: AssetQueries, identity: AssetIdentity): Promise<EvaluationAssetHead> {
  assertAssetIdentity(identity);
  const head = await client.evaluationAssetHead.findUnique({ where: { user_kind_businessId: { user: identity.user, kind: identity.kind, businessId: identity.businessId } } });
  if (!head) throw missing();
  return head;
}

export async function withEvaluationAssetTransaction<T>(work: (tx: AssetTransaction) => Promise<T>, client?: Pick<PrismaClient, '$transaction'>): Promise<T> {
  const database: Pick<PrismaClient, '$transaction'> = client || (await import('@/lib/storage/prisma')).prismaRaw as unknown as Pick<PrismaClient, '$transaction'>;
  for (let attempt = 0; ; attempt++) {
    try { return await database.$transaction(work, { timeout: 15000, maxWait: 15000 }); }
    catch (error) {
      const code = (error as { code?: string }).code;
      const retryable = ['P1008', 'P2002', 'P2028', 'P2034'].includes(code || '') || error instanceof EvaluationAssetError && error.code === 'ASSET_RETRY';
      if (!retryable || attempt >= 7) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(10 * 2 ** attempt, 250)));
    }
  }
}

export async function ensureAssetVersion(tx: AssetTransaction, input: AssetVersionInput): Promise<AssetPublication> {
  const identity: AssetIdentity = { user: input.user, kind: input.kind, businessId: input.businessId };
  assertAssetIdentity(identity);
  if ((input.note?.length || 0) > 2000 || (input.source?.length || 0) > 100) throw new EvaluationAssetError('版本说明或来源过长');
  const contentJson = canonicalAssetJson(input.content);
  const contentHash = assetContentHash(input.kind, input.content);
  let head = await tx.evaluationAssetHead.findUnique({ where: { user_kind_businessId: identity } });
  if (!head) head = await tx.evaluationAssetHead.create({ data: identity });
  if (head.archived) throw conflict('资产已归档，请先恢复后再发布');
  if (head.publishedVersion > 0) {
    const current = await tx.evaluationAssetVersion.findUnique({ where: { assetId_version: { assetId: head.id, version: head.publishedVersion } } });
    if (!current) throw new EvaluationAssetError('资产当前版本记录缺失', 409, 'ASSET_CORRUPT');
    if (current.contentHash === contentHash) return { head, version: versionContent(current), created: false };
  }
  const reserved = await tx.evaluationAssetHead.updateMany({
    where: { id: head.id, revision: head.revision, publishedVersion: head.publishedVersion, archived: false },
    data: { publishedVersion: { increment: 1 }, revision: { increment: 1 } },
  });
  if (!reserved.count) throw new EvaluationAssetError('资产发布冲突，请重试', 409, 'ASSET_RETRY');
  const version = await tx.evaluationAssetVersion.create({ data: {
    assetId: head.id, version: head.publishedVersion + 1, contentJson, contentHash, note: input.note || '', source: input.source || 'manual',
  } });
  return { head: await tx.evaluationAssetHead.findUniqueOrThrow({ where: { id: head.id } }), version: versionContent(version), created: true };
}

export async function listAssetVersions(client: AssetQueries, identity: AssetIdentity): Promise<{ head: EvaluationAssetHead | null; versions: AssetVersionSummary[] }> {
  assertAssetIdentity(identity);
  const head = await client.evaluationAssetHead.findUnique({ where: { user_kind_businessId: { user: identity.user, kind: identity.kind, businessId: identity.businessId } } });
  if (!head) return { head: null, versions: [] };
  const versions = await client.evaluationAssetVersion.findMany({ where: { assetId: head.id }, orderBy: { version: 'desc' }, select: {
    id: true, assetId: true, version: true, contentHash: true, note: true, source: true, createdAt: true,
  } });
  return { head, versions };
}

export async function getAssetVersion(client: AssetQueries, input: { user: string; versionId: string; kind?: AssetIdentity['kind']; businessId?: string }): Promise<AssetVersion> {
  if (!input.user?.trim() || !input.versionId?.trim()) throw missing();
  const version = await client.evaluationAssetVersion.findFirst({ where: { id: input.versionId, asset: {
    user: input.user, ...(input.kind ? { kind: input.kind } : {}), ...(input.businessId ? { businessId: input.businessId } : {}),
  } } });
  if (!version) throw missing();
  return versionContent(version);
}

export async function getDatasetDraft(client: AssetQueries, identity: DatasetAssetIdentity): Promise<AssetDraft | null> {
  const head = await ownedHead(client, datasetIdentity(identity));
  const draft = await client.evaluationAssetDraft.findUnique({ where: { assetId: head.id } });
  return draft ? versionContent(draft) : null;
}

export async function createDatasetDraft(tx: AssetTransaction, identity: DatasetAssetIdentity): Promise<AssetDraft> {
  const head = await ownedHead(tx, datasetIdentity(identity));
  if (head.archived || head.publishedVersion < 1) throw conflict('资产已归档或没有已发布版本');
  const existing = await tx.evaluationAssetDraft.findUnique({ where: { assetId: head.id } });
  if (existing) return versionContent(existing);
  const current = await tx.evaluationAssetVersion.findUnique({ where: { assetId_version: { assetId: head.id, version: head.publishedVersion } } });
  if (!current) throw missing();
  datasetCases(assetContentObject(JSON.parse(current.contentJson)));
  const draft = await tx.evaluationAssetDraft.create({ data: { assetId: head.id, baseVersion: head.publishedVersion, contentJson: current.contentJson } });
  return versionContent(draft);
}

function datasetCases(content: Record<string, unknown>): Array<Record<string, unknown>> {
  if (!Array.isArray(content.cases) || content.cases.some(item => !item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !item.id)) throw new EvaluationAssetError('草稿缺少有效的 Case 列表');
  const cases = content.cases as Array<Record<string, unknown>>;
  if (new Set(cases.map(item => item.id)).size !== cases.length) throw new EvaluationAssetError('Case 标识重复');
  return cases;
}

type DraftChange = DatasetAssetIdentity & { caseId: string; expectedRevision: number };
async function changeDraft(tx: AssetTransaction, input: DraftChange, transform: (content: Record<string, unknown>, draft: AssetDraft) => Promise<Record<string, unknown>>): Promise<AssetDraft> {
  if (!input.caseId?.trim() || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw new EvaluationAssetError('Case 标识或草稿 revision 无效');
  const draft = await getDatasetDraft(tx, input);
  if (!draft) throw missing();
  const head = await ownedHead(tx, datasetIdentity(input));
  if (head.archived) throw conflict('资产已归档');
  if (draft.revision !== input.expectedRevision) throw conflict('草稿已变化，请刷新后重试');
  const content = await transform(draft.content, draft);
  datasetCases(content);
  const contentJson = canonicalAssetJson(content);
  const updated = await tx.evaluationAssetDraft.updateMany({ where: { assetId: draft.assetId, revision: input.expectedRevision }, data: { contentJson, revision: { increment: 1 } } });
  if (!updated.count) throw conflict('草稿更新冲突，请刷新后重试');
  const result = await tx.evaluationAssetDraft.findUniqueOrThrow({ where: { assetId: draft.assetId } });
  return versionContent(result);
}

export async function saveDatasetDraftCase(tx: AssetTransaction, input: DraftChange & { case: Record<string, unknown> | null }): Promise<AssetDraft> {
  return changeDraft(tx, input, async content => {
    const cases = datasetCases(content);
    const value = input.case;
    if (value !== null && (typeof value !== 'object' || Array.isArray(value) || value.id !== input.caseId)) throw new EvaluationAssetError('Case 内容与标识不一致');
    const index = cases.findIndex(item => item.id === input.caseId);
    const next = [...cases];
    if (value === null) { if (index < 0) throw missing(); next.splice(index, 1); }
    else if (index < 0) next.push(assetContentObject(value));
    else next[index] = assetContentObject(value);
    return { ...content, cases: next };
  });
}

export async function revertDatasetDraftCase(tx: AssetTransaction, input: DraftChange): Promise<AssetDraft> {
  return changeDraft(tx, input, async (content, draft) => {
    const original = await tx.evaluationAssetVersion.findUnique({ where: { assetId_version: { assetId: draft.assetId, version: draft.baseVersion } } });
    if (!original) throw missing();
    const baseCases = datasetCases(assetContentObject(JSON.parse(original.contentJson)));
    const base = baseCases.find(item => item.id === input.caseId);
    const cases = datasetCases(content);
    const index = cases.findIndex(item => item.id === input.caseId);
    if (!base && index < 0) throw missing();
    const next = [...cases];
    if (!base) next.splice(index, 1);
    else if (index >= 0) next[index] = base;
    else {
      const baseIndex = baseCases.findIndex(item => item.id === input.caseId);
      const nextBase = baseCases.slice(baseIndex + 1).find(item => next.some(current => current.id === item.id));
      const at = nextBase ? next.findIndex(item => item.id === nextBase.id) : next.length;
      next.splice(at, 0, base);
    }
    return { ...content, cases: next };
  });
}

export async function publishDatasetDraft(tx: AssetTransaction, input: DatasetAssetIdentity & {
  expectedRevision: number; note?: string;
  project?: (tx: AssetTransaction, content: Record<string, unknown>, publication: AssetPublication) => Promise<void>;
}): Promise<AssetPublication> {
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw new EvaluationAssetError('草稿 revision 无效');
  const identity = datasetIdentity(input);
  const head = await ownedHead(tx, identity);
  const draft = await getDatasetDraft(tx, input);
  if (!draft) throw missing();
  if (draft.revision !== input.expectedRevision) throw conflict('草稿已变化，请刷新后重试');
  if (draft.baseVersion !== head.publishedVersion) throw conflict('发布版本已变化，草稿基线冲突，请先核对新版内容');
  datasetCases(draft.content);
  const claimed = await tx.evaluationAssetDraft.updateMany({ where: { assetId: head.id, revision: input.expectedRevision, baseVersion: head.publishedVersion }, data: { revision: { increment: 1 } } });
  if (!claimed.count) throw conflict('草稿发布冲突，请刷新后重试');
  const result = await ensureAssetVersion(tx, { ...identity, content: draft.content, source: 'publication', note: input.note });
  if (input.project) await input.project(tx, draft.content, result);
  const removed = await tx.evaluationAssetDraft.deleteMany({ where: { assetId: head.id, revision: input.expectedRevision + 1 } });
  if (!removed.count) throw conflict('草稿发布冲突，请刷新后重试');
  return result;
}
