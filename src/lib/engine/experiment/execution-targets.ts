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

import { definitionsForTarget, type RuntimeDefinition } from '../../../../packages/agent-runtime/index.cjs';
import { prisma } from '@/lib/storage/prisma';
import { pickDisplayClientIp } from '@/lib/reliability/client-ip';
import {
  deriveStatus,
  parseCapabilities,
  type ClientCapabilities,
  type ClientPlatformCapability,
} from '@/lib/reliability/client-registry';

export type ClientTraceGenerationTarget = {
  workerId: string;
  host: string;
  hostname: string | null;
  platform: string;
  agent: string;
  agentLabel: string;
  models: Array<{ id: string; label: string }>;
  lastSeenAt: string;
  parameterDefinitions?: RuntimeDefinition[];
  supportsSkillSnapshot?: boolean;
  supportsTriggerRouting?: boolean;
  supportsEnvironmentPreparation?: boolean;
};

export function listTraceGenerationPlatforms(
  capabilities: ClientCapabilities,
): ClientPlatformCapability[] {
  return capabilities.platforms.filter((platform) => {
    const actions = new Set([...(capabilities.actions || []), ...(platform.actions || [])]);
    return actions.has('RUN_EXPERIMENT_CASE')
      && platform.runExperimentCase?.returnsTraceId === true;
  });
}

export async function listClientTraceGenerationTargets(
  user: string | null,
): Promise<ClientTraceGenerationTarget[]> {
  if (!user) return [];
  const clients = await prisma.reliabilityClient.findMany({
    where: { user, unboundAt: null },
    orderBy: { lastSeenAt: 'desc' },
    take: 100,
  });
  const targets: ClientTraceGenerationTarget[] = [];
  for (const client of clients) {
    if (deriveStatus(client) !== 'online') continue;
    const capabilities = parseCapabilities(client.capabilitiesJson);
    for (const platform of listTraceGenerationPlatforms(capabilities)) {
      const host = pickDisplayClientIp({
        reportedIp: client.reportedIp,
        observedIp: client.observedIp,
      }) || client.hostname || client.clientId;
      const models = [
        { id: '', label: '平台默认' },
        ...(platform.models || []).map((model) => ({ id: model, label: model })),
      ];
      for (const agent of platform.agents || []) {
        targets.push({
          workerId: client.clientId,
          host,
          hostname: client.hostname,
          platform: platform.id,
          agent,
          agentLabel: agent,
          models,
          lastSeenAt: client.lastSeenAt.toISOString(),
          parameterDefinitions: definitionsForTarget(platform.parameterDefinitions || [], platform.id, agent),
          supportsSkillSnapshot: Number(platform.runExperimentCase?.skillSnapshotVersion || 0) >= 1,
          supportsTriggerRouting: Number(platform.runExperimentCase?.skillSnapshotVersion || 0) >= 4,
          supportsEnvironmentPreparation: capabilities.actions?.includes('PREPARE_EXECUTION_ENVIRONMENT') === true,
        });
      }
    }
  }
  return targets;
}
