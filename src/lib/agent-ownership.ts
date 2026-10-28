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

import type { Prisma } from '@prisma/client';

import { SYSTEM_AGENT_NAMES } from '@/lib/system-agent-names';
import { prismaRaw } from '@/lib/storage/prisma';

export async function buildExecutionOwnershipWhere(
  ownership: 'user' | 'system',
): Promise<Prisma.ExecutionWhereInput> {
  const registeredSystemAgents = await prismaRaw.registeredAgent.findMany({
    where: { agentOwnership: 'system' },
    select: { id: true, platform: true, name: true },
  });
  const systemAgentIds = registeredSystemAgents.map((agent) => agent.id);
  const systemIdentities = registeredSystemAgents
    .filter((agent) => agent.platform && agent.name)
    .map((agent) => ({ framework: agent.platform, agentName: agent.name }));

  if (ownership === 'system') {
    return {
      OR: [
        { agentName: { in: [...SYSTEM_AGENT_NAMES] } },
        ...(systemAgentIds.length > 0 ? [{ agentId: { in: systemAgentIds } }] : []),
        ...systemIdentities,
      ],
    };
  }

  return {
    AND: [
      {
        OR: [
          { agentName: null },
          { agentName: { notIn: [...SYSTEM_AGENT_NAMES] } },
        ],
      },
      ...(systemAgentIds.length > 0
        ? [{
            OR: [
              { agentId: null },
              { agentId: { notIn: systemAgentIds } },
            ],
          }]
        : []),
      ...(systemIdentities.length > 0
        ? [{
            OR: [
              { framework: null },
              { agentName: null },
              { NOT: { OR: systemIdentities } },
            ],
          }]
        : []),
    ],
  };
}
