import type { PrismaClient } from '@prisma/client';
import { listFrameworks, resolveFrameworkId } from '@/lib/ingest/adapters/registry';
import { FRAMEWORK_OPTIONS } from '@/lib/ingest/setup/install-profile';
import { hash } from '@/lib/trace-datasets/sampling';
import { GenerationError } from '@/lib/trace-datasets/contracts';

export const platformId = (value: string) => resolveFrameworkId(value.trim().toLowerCase());
export function platformCatalog() {
  const all = new Map(FRAMEWORK_OPTIONS.map(p => [platformId(p.value), { id: platformId(p.value), label: p.label }]));
  for (const p of listFrameworks()) all.set(p.id, { id: p.id, label: p.label });
  return all;
}
export function agentKey(row: { framework: string | null; agentId: string | null; agentName: string | null; clientId?: string | null }) {
  return row.agentId ? `registered:${row.agentId}` : `legacy:${hash([platformId(row.framework || ''), row.agentName || '', row.clientId || ''])}`;
}
export async function generationOptions(db: PrismaClient, owner: string, from: string, to: string, platform?: string) {
  const catalog = platformCatalog();
  const history = await db.execution.groupBy({ by: ['framework'], where: { user: owner } });
  const available = [...new Set(history.map(r => platformId(r.framework || '')))].filter(id => catalog.has(id));
  const platforms = available.sort().map(id => catalog.get(id)!);
  const aliases = history.filter(r => platformId(r.framework || '') === platform).map(r => r.framework).filter((s): s is string => !!s);
  const agents: { agentKey: string; name: string; traceCount: number }[] = [];
  if (platform && available.includes(platform)) {
    const rows = await db.execution.groupBy({ by: ['framework', 'agentId', 'agentName', 'clientId'], where: { user: owner, framework: { in: aliases }, timestamp: { gte: new Date(from), lt: new Date(to) } }, _count: { id: true } });
    const merged = new Map<string, typeof agents[number]>();
    for (const row of rows) {
      if (!row.agentId && !row.agentName) continue;
      const key = agentKey(row), existing = merged.get(key);
      if (existing) existing.traceCount += row._count.id;
      else merged.set(key, { agentKey: key, name: row.agentName || row.agentId || '', traceCount: row._count.id });
    }
    const names = new Map<string, number>();
    for (const a of merged.values()) names.set(a.name, (names.get(a.name) || 0) + 1);
    for (const a of merged.values()) agents.push({ ...a, name: names.get(a.name)! > 1 ? `${a.name} (${a.agentKey.slice(-8)})` : a.name });
    agents.sort((a, b) => a.name.localeCompare(b.name) || a.agentKey.localeCompare(b.agentKey));
  }
  return { platforms, agents, aliases };
}
export async function sourceScope(db: PrismaClient, owner: string, config: { from: string; to: string; platform: string; agentKey: string }) {
  const options = await generationOptions(db, owner, config.from, config.to, config.platform);
  const agent = options.agents.find(a => a.agentKey === config.agentKey);
  if (!agent) throw new GenerationError('SOURCE_NOT_AVAILABLE', '该 Agent 在所选时间内没有可访问的 Trace，请重新选择', 422);
  const rows = await db.execution.groupBy({ by: ['framework', 'agentId', 'agentName', 'clientId'], where: { user: owner, framework: { in: options.aliases }, timestamp: { gte: new Date(config.from), lt: new Date(config.to) } } });
  return { agentName: agent.name, identities: rows.filter(r => agentKey(r) === config.agentKey).map(({ framework, agentId, agentName, clientId }) => ({ framework, agentId, agentName, clientId })) };
}
