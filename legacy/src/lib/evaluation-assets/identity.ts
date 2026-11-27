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

import { canonicalExperimentAgentName } from '@/lib/engine/experiment/agent-identity';
import { ASSET_KINDS, EvaluationAssetError, type AssetIdentity } from './types';

export function agentAssetBusinessId(platform: string, name: string): string {
  const normalizedPlatform = String(platform || '').trim().toLowerCase();
  const normalizedName = canonicalExperimentAgentName(normalizedPlatform, String(name || ''));
  if (!normalizedPlatform || !normalizedName) throw new EvaluationAssetError('Agent 平台和名称不能为空');
  if (normalizedPlatform.length > 100 || normalizedName.length > 200) throw new EvaluationAssetError('Agent 平台或名称过长');
  return JSON.stringify([normalizedPlatform, normalizedName]);
}

export function assertAssetIdentity(identity: AssetIdentity): void {
  if (!identity.user?.trim() || identity.user.length > 200) throw new EvaluationAssetError('资产所属用户不能为空');
  if (!ASSET_KINDS.includes(identity.kind)) throw new EvaluationAssetError('资产类型无效');
  if (!identity.businessId?.trim() || identity.businessId.length > 500) throw new EvaluationAssetError('资产标识不能为空或过长');
}
