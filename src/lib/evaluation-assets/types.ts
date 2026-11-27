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

import type { EvaluationAssetDraft, EvaluationAssetHead, EvaluationAssetVersion, Prisma } from '@prisma/client';

export const ASSET_KINDS = ['agent', 'dataset', 'evaluator'] as const;
export type AssetKind = typeof ASSET_KINDS[number];
export type AssetIdentity = { user: string; kind: AssetKind; businessId: string };
export type DatasetAssetIdentity = { user: string; businessId: string };
export type AssetTransaction = Prisma.TransactionClient;
export type AssetQueries = Pick<AssetTransaction, 'evaluationAssetHead' | 'evaluationAssetVersion' | 'evaluationAssetDraft'>;
export type AssetVersion = EvaluationAssetVersion & { content: Record<string, unknown> };
export type AssetDraft = EvaluationAssetDraft & { content: Record<string, unknown> };
export type AssetPublication = { head: EvaluationAssetHead; version: AssetVersion; created: boolean };
export type AssetVersionSummary = Omit<EvaluationAssetVersion, 'contentJson'>;
export type AssetVersionInput = AssetIdentity & { content: unknown; note?: string; source?: string };

export class EvaluationAssetError extends Error {
  constructor(message: string, public status = 400, public code = 'INVALID_ASSET') {
    super(message);
    this.name = 'EvaluationAssetError';
  }
}
