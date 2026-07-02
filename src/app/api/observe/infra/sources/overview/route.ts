// 所有源的概览：每源取最近若干采样 → 聚合诊断 → verdict + 关键 SLI（用已落库的数据，不发网络）。

import { NextResponse } from 'next/server';

import { aggregate, diagnose } from '@/lib/infra/diagnose';
import { latestSamples, listSourceModels } from '@/lib/infra/store';
import { prismaRaw } from '@/lib/storage/prisma';
import type { HardwareProfile } from '@/lib/infra/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  const sources = await prismaRaw.infraSource.findMany({ orderBy: { createdAt: 'desc' } });

  const overview = await Promise.all(
    sources.map(async (s) => {
      const models = await listSourceModels(s.id);
      // 多模型源：概览卡用「最忙的那个模型」代表（每模型取最近样本，按并发挑）。
      let primaryModel: string | null = null;
      if (models.length > 1) {
        const latestPerModel = await Promise.all(models.map(async (m) => (await latestSamples(s.id, 1, m))[0]));
        const busiest = latestPerModel.filter(Boolean).sort((x, y) => (y!.gauges['vllm:num_requests_running'] ?? 0) - (x!.gauges['vllm:num_requests_running'] ?? 0))[0];
        primaryModel = busiest?.model ?? models[0];
      } else if (models.length === 1) {
        primaryModel = models[0];
      }

      const samples = await latestSamples(s.id, 5, primaryModel ?? undefined);
      // push 源最近 60s 没新样本 = collector 没在推（poller 不拉 push 源）
      const lastMs = samples.length ? samples[samples.length - 1].tsMs : null;
      const stalePush = s.kind === 'push' && (lastMs == null || Date.now() - lastMs > 60_000);
      if (samples.length === 0) {
        return { source: s, hasData: false, lastSampleMs: null, verdict: null, bottleneck: null, slis: null, models, primaryModel, stalePush };
      }
      const hw: HardwareProfile | undefined = s.memBandwidthGBs != null
        ? { name: s.hardwareName ?? 'custom', memBandwidthGBs: s.memBandwidthGBs }
        : undefined;
      const res = diagnose(aggregate(samples), hw);
      const a = res.inputs;
      return {
        source: s,
        hasData: true,
        models,
        primaryModel,
        stalePush,
        lastSampleMs: samples[samples.length - 1].tsMs,
        verdict: res.verdict,
        bottleneck: res.bottleneck,
        slis: {
          runningPeak: a.runningPeak,
          waitingPeak: a.waitingPeak,
          kvPeakPerc: a.kvPeakPerc,
          genTokPerS: a.genTokPerS,
          ttftP95: a.ttftP95,
          itlP95: a.itlP95,
          prefixHit: a.prefixHitWindow ?? a.prefixHitLifetime,
          preemptRate: a.preemptRate,
        },
      };
    }),
  );

  // collector 要推到的本服务地址 = 部署后固定的 AGENT_INSIGHT_HOST（不是每源手填）。
  let host = process.env.AGENT_INSIGHT_HOST || 'http://localhost:3000';
  if (!/^https?:\/\//.test(host)) host = `http://${host}`;
  const ingestEndpoint = `${host.replace(/\/$/, '')}/api/ingest/otel/v1/metrics`;

  return NextResponse.json({ overview, ingestEndpoint });
}
