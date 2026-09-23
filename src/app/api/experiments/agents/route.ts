// 实验向导 ① 步：候选 Agent 下拉 —— distinct Execution.agentName（root trace），按出现次数降序。
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';
import { resolveUser } from '@/lib/auth/auth';
import { buildExecutionOwnershipWhere } from '@/lib/agent-ownership';
import { listWorkerExecutionTargets } from '@/lib/fault-injection/worker-protocol';
import { listClientTraceGenerationTargets } from '@/lib/engine/experiment/execution-targets';
import { listBenchmarkAdapters } from '@/lib/benchmark/adapter-registry';
import { listBenchmarkExecutionTargets } from '@/lib/benchmark/execution-targets';
import { canonicalExperimentAgentName } from '@/lib/engine/experiment/agent-identity';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const { username } = await resolveUser(req, url.searchParams.get('user'));
    const userFilter = username ? { user: username } : {};
    const userOwnershipWhere = await buildExecutionOwnershipWhere('user');

    const [grouped, faultInjectionTargets, genericTraceTargets, benchmarkTargets] = await Promise.all([
      prisma.execution.groupBy({
      by: ['agentName', 'framework'],
      where: {
        ...userFilter,
        isSubagent: false,
        agentName: { not: null },
        AND: [userOwnershipWhere],
      },
      _count: { agentName: true },
      orderBy: { _count: { agentName: 'desc' } },
      take: 200,
      }),
      listWorkerExecutionTargets(username),
      listClientTraceGenerationTargets(username),
      username
        ? Promise.all(listBenchmarkAdapters().map(async (manifest) => (
            (await listBenchmarkExecutionTargets(username, manifest)).map((target) => ({
              ...target,
              adapterKey: manifest.adapterKey,
            }))
          ))).then((groups) => groups.flat())
        : Promise.resolve([]),
    ]);

    type CandidateTarget = (typeof faultInjectionTargets)[number] & {
      supportsGenericTrace: boolean;
      supportsFaultInjection: boolean;
      supportsBenchmark: boolean;
      benchmarkKeys: string[];
      benchmarkUnavailableReason: string | null;
    };
    type Candidate = {
      name: string;
      traces: number;
      frameworks: Set<string>;
      targets: CandidateTarget[];
    };
    const byName = new Map<string, Candidate>();
    for (const row of grouped) {
      const framework = String(row.framework || '').trim();
      const name = canonicalExperimentAgentName(framework, String(row.agentName || ''));
      if (!name) continue;
      const current = byName.get(name) || {
        name,
        traces: 0,
        frameworks: new Set<string>(),
        targets: [],
      };
      current.traces += row._count.agentName;
      if (framework) current.frameworks.add(framework);
      byName.set(name, current);
    }
    const attachTarget = (
      target: (typeof faultInjectionTargets)[number],
      capability: 'generic' | 'fault-injection',
    ) => {
      const name = canonicalExperimentAgentName(target.platform, target.agent);
      if (!name || name === 'ras-judge') return;
      const current = byName.get(name) || {
        name,
        traces: 0,
        frameworks: new Set<string>(),
        targets: [],
      };
      current.frameworks.add(target.platform);
      const existing = current.targets.find((item) =>
        item.workerId === target.workerId && item.platform === target.platform);
      if (existing) {
        existing.supportsGenericTrace ||= capability === 'generic';
        existing.supportsFaultInjection ||= capability === 'fault-injection';
        const models = new Map(existing.models.map((model) => [model.id, model]));
        for (const model of target.models) models.set(model.id, model);
        existing.models = Array.from(models.values());
      } else {
        current.targets.push({
          ...target,
          supportsGenericTrace: capability === 'generic',
          supportsFaultInjection: capability === 'fault-injection',
          supportsBenchmark: false,
          benchmarkKeys: [],
          benchmarkUnavailableReason: '该执行目标未上报 Benchmark 所需能力',
        });
      }
      byName.set(name, current);
    };
    for (const target of genericTraceTargets) {
      attachTarget(target, 'generic');
    }
    for (const target of faultInjectionTargets) {
      attachTarget(target, 'fault-injection');
    }
    for (const candidate of byName.values()) {
      for (const target of candidate.targets) {
        const matchingBenchmarks = benchmarkTargets.filter((item) => (
          item.clientId === target.workerId
          && item.platform === target.platform
          && item.agents.includes(target.agent)
        ));
        if (!matchingBenchmarks.length) continue;
        for (const benchmark of matchingBenchmarks) {
          if (benchmark.ready && !target.benchmarkKeys.includes(benchmark.adapterKey)) {
            target.benchmarkKeys.push(benchmark.adapterKey);
          }
        }
        target.supportsBenchmark = target.benchmarkKeys.length > 0;
        target.benchmarkUnavailableReason = target.supportsBenchmark
          ? null
          : matchingBenchmarks.flatMap((item) => item.unavailableReasons).join('；') || 'Benchmark 执行目标未就绪';
      }
    }

    const agents = Array.from(byName.values())
      .sort((a, b) => b.traces - a.traces || b.targets.length - a.targets.length || a.name.localeCompare(b.name))
      .slice(0, 50)
      .map((item) => ({
        name: item.name,
        traces: item.traces,
        frameworks: Array.from(item.frameworks).sort(),
        executable: item.targets.length > 0,
        targets: item.targets.map((target) => ({
          workerId: target.workerId,
          host: target.host,
          hostname: target.hostname,
          platform: target.platform,
          agent: target.agent,
          models: target.models,
          lastSeenAt: target.lastSeenAt,
          supportsGenericTrace: target.supportsGenericTrace,
          supportsFaultInjection: target.supportsFaultInjection,
          supportsBenchmark: target.supportsBenchmark,
          benchmarkKeys: target.benchmarkKeys,
          benchmarkUnavailableReason: target.benchmarkUnavailableReason,
        })),
      }));

    return NextResponse.json({ agents });
  } catch (error) {
    console.error('[Experiment Agents Error]', error);
    return NextResponse.json({ error: 'Failed to load agents' }, { status: 500 });
  }
}
