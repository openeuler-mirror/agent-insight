// auto-derive：从 Execution.endpoint 聚合候选源 → 探测 /metrics → 标记可观测 / 已注册。

import { NextResponse } from 'next/server';

import { deriveCandidates, probeEndpoint } from '@/lib/infra/registry';
import { prismaRaw } from '@/lib/storage/prisma';

export const dynamic = 'force-dynamic';

export async function GET() {
  const rows = await prismaRaw.execution.findMany({
    where: { endpoint: { not: null } },
    select: { endpoint: true, model: true },
    take: 5000,
  });
  const candidates = deriveCandidates(rows);

  const registered = new Set(
    (await prismaRaw.infraSource.findMany({ select: { endpoint: true } })).map((s) => s.endpoint),
  );

  const probed = await Promise.all(
    candidates.map(async (c) => ({
      ...c,
      registered: registered.has(c.endpoint),
      probe: await probeEndpoint(c.endpoint, { timeoutMs: 5000 }),
    })),
  );

  return NextResponse.json({ candidates: probed });
}
