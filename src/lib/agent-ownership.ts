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
