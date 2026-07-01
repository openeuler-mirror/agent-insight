// 用「本次实现的库代码」（非 spike .mjs）对真实 vLLM 源做一次端到端验证：
//   拉 /metrics → 解析归一(prom-text) → 聚合+诊断(infra/diagnose) → 打印 verdict + findings
//
//   node --import tsx scripts/infra-vllm-probe.ts [target] [samples] [intervalMs]
//   VLLM_TARGET=http://100.125.177.5:8000 node --import tsx scripts/infra-vllm-probe.ts
//
import { setTimeout as sleep } from 'node:timers/promises';

import { aggregate, diagnose } from '@/lib/infra/diagnose';
import { histAvg, histQuantile } from '@/lib/ingest/vllm/prom-text';
import { scrapeVllmTarget } from '@/lib/ingest/vllm/scrape';
import type { InfraMetricSample } from '@/lib/infra/types';

const target = process.argv[2] || process.env.VLLM_TARGET || 'http://100.125.177.5:8000';
const samples = Number(process.argv[3] || 3);
const intervalMs = Number(process.argv[4] || 2500);

const ICON: Record<string, string> = { critical: '🔴', warn: '🟡', healthy: '🟢', info: 'ℹ️ ' };

async function main(): Promise<void> {
  console.log(`== vLLM infra 实测探针 ==\n源: ${target}  采样: ${samples}×${intervalMs}ms\n`);

  const series: InfraMetricSample[] = [];
  for (let i = 0; i < samples; i++) {
    const snap = await scrapeVllmTarget(target);
    series.push(snap);
    const ttft = snap.histograms['vllm:time_to_first_token_seconds'];
    console.log(
      `  [#${i + 1}] model=${snap.model} running=${snap.gauges['vllm:num_requests_running']} ` +
      `waiting=${snap.gauges['vllm:num_requests_waiting']} ` +
      `kv=${((snap.gauges['vllm:kv_cache_usage_perc'] ?? 0) * 100).toFixed(1)}% ` +
      `ttft_avg=${ttft ? (histAvg(ttft) ?? 0).toFixed(3) : 'n/a'}s ` +
      `ttft_p95=${ttft ? (histQuantile(ttft, 0.95) ?? 0).toFixed(3) : 'n/a'}s`,
    );
    if (i < samples - 1) await sleep(intervalMs);
  }

  const res = diagnose(aggregate(series));
  console.log(`\n── 诊断结论 ──`);
  console.log(`VERDICT: ${res.verdict.toUpperCase()}   主瓶颈: ${res.bottleneck}   model: ${res.inputs.model}`);
  console.log(
    `信号: gen_tok/s=${res.inputs.genTokPerS.toFixed(1)} prompt_tok/s=${res.inputs.promptTokPerS.toFixed(1)} ` +
    `prefix_hit(lifetime)=${res.inputs.prefixHitLifetime != null ? (res.inputs.prefixHitLifetime * 100).toFixed(1) + '%' : 'n/a'} ` +
    `kv_peak=${res.inputs.kvPeakPerc.toFixed(1)}% preempt=${res.inputs.preemptRate.toFixed(2)}/s`,
  );
  for (const x of res.findings) {
    console.log(`\n${ICON[x.sev] ?? ''} [${x.cls}] ${x.title}`);
    console.log(`   证据: ${x.evidence}`);
    console.log(`   诊断: ${x.diagnosis}`);
    if (x.remediation.length) console.log(`   建议: ${x.remediation.map((r) => '• ' + r).join('\n         ')}`);
  }
}

main().catch((e) => {
  console.error('探针失败:', e instanceof Error ? e.message : e);
  process.exit(1);
});
