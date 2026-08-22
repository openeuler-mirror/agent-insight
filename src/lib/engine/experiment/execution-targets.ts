import { prisma } from '@/lib/storage/prisma';
import { pickDisplayClientIp } from '@/lib/reliability/client-ip';
import { deriveStatus, parseCapabilities } from '@/lib/reliability/client-registry';

export type ClientTraceGenerationTarget = {
  workerId: string;
  host: string;
  hostname: string | null;
  platform: string;
  agent: string;
  agentLabel: string;
  models: Array<{ id: string; label: string }>;
  lastSeenAt: string;
};

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
    for (const platform of capabilities.platforms) {
      const actions = new Set([...(capabilities.actions || []), ...(platform.actions || [])]);
      if (!actions.has('RUN_EXPERIMENT_CASE')) continue;
      if (platform.runExperimentCase?.returnsTraceId !== true) continue;
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
        });
      }
    }
  }
  return targets;
}
