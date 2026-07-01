// 对一个 vLLM 源做一次「拉取 → 诊断」并产出适合前端/API 的摘要。
// 复用 Path A 拉取器 + 源无关诊断内核；fetch 可注入便于测试。

import { setTimeout as sleep } from 'node:timers/promises';

import { aggregate, diagnose } from '@/lib/infra/diagnose';
import { scrapeVllmTargetModels } from '@/lib/ingest/vllm/scrape';
import type { Finding, HardwareProfile, InfraMetricSample, Verdict } from '@/lib/infra/types';

export interface InfraSli {
  runningPeak: number;
  waitingPeak: number;
  kvPeakPerc: number;
  genTokPerS: number;
  ttftP95: number | null;
  itlP95: number | null;
  prefixHit: number | null;
  preemptRate: number;
}

export interface InfraDiagnosisSummary {
  target: string;
  model: string | null;
  verdict: Verdict;
  bottleneck: string;
  slis: InfraSli;
  findings: Finding[];
  samples: number;
  tsMs: number;
}

export interface DiagnoseTargetOptions {
  samples?: number;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  hardwareProfile?: HardwareProfile;
  /** 多模型源时只诊断该 model；省略则单模型直接用、多模型取最忙的。 */
  model?: string;
}

/** 拉 N 次目标 /metrics（间隔 intervalMs），聚合诊断，返回摘要。 */
export async function diagnoseTarget(
  target: string,
  opts: DiagnoseTargetOptions = {},
): Promise<InfraDiagnosisSummary> {
  const { samples = 1, intervalMs = 2000, fetchImpl, hardwareProfile, model } = opts;
  const n = Math.max(1, samples);

  const series: InfraMetricSample[] = [];
  let lastErr: unknown = null;
  for (let i = 0; i < n; i++) {
    try {
      const perModel = await scrapeVllmTargetModels(target, { fetchImpl });
      // 指定 model 取该模型；否则单模型直接用，多模型取并发最高的那个
      const chosen = model
        ? perModel.find((s) => s.model === model)
        : perModel.length <= 1
          ? perModel[0]
          : [...perModel].sort((x, y) => (y.gauges['vllm:num_requests_running'] ?? 0) - (x.gauges['vllm:num_requests_running'] ?? 0))[0];
      if (chosen) series.push(chosen);
    } catch (e) {
      lastErr = e; // 单次抓取失败（如瞬时超时）不放弃，继续用拿到的样本诊断
    }
    if (i < n - 1) await sleep(intervalMs);
  }
  if (series.length === 0) {
    throw lastErr instanceof Error ? lastErr : new Error('所有采样均失败');
  }

  const result = diagnose(aggregate(series), hardwareProfile);
  const a = result.inputs;
  return {
    target,
    model: result.inputs.model,
    verdict: result.verdict,
    bottleneck: result.bottleneck,
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
    findings: result.findings,
    samples: series.length,
    tsMs: series[series.length - 1].tsMs,
  };
}
