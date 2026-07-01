// 制造一段轻量负载，同时用「本次实现的库代码」采样 + 诊断真实 vLLM 源。
// 目的：在真机上看到指标随负载变化、诊断内核给出非 idle 的真实结论。
// 对共享卡保持克制：并发与 token 量都适度。
//
//   node --import tsx scripts/infra-vllm-loadcheck.ts [conc] [maxTokens]
//
import { setTimeout as sleep } from 'node:timers/promises';

import { aggregate, diagnose } from '@/lib/infra/diagnose';
import { histAvg, histQuantile } from '@/lib/ingest/vllm/prom-text';
import { scrapeVllmTarget } from '@/lib/ingest/vllm/scrape';
import type { InfraMetricSample } from '@/lib/infra/types';

const BASE = process.env.VLLM_TARGET || 'http://100.125.177.5:8000';
const MODEL = process.env.VLLM_MODEL || 'Qwen3-Coder-30B-A3B-Instruct-FP8';
const conc = Number(process.argv[2] || 12);
const maxTokens = Number(process.argv[3] || 256);

const ICON: Record<string, string> = { critical: '🔴', warn: '🟡', healthy: '🟢', info: 'ℹ️ ' };

async function oneRequest(i: number): Promise<void> {
  try {
    await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: `Write a short paragraph about the number ${i}, then count from 1 to 20.` }],
        max_tokens: maxTokens,
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(120000),
    });
  } catch {
    /* 单条失败不影响整体压测/采样 */
  }
}

async function main(): Promise<void> {
  console.log(`== vLLM 轻量负载实测 ==\n源: ${BASE}  并发: ${conc}  max_tokens: ${maxTokens}\n`);

  // 背景发起并发请求
  const load = Promise.all(Array.from({ length: conc }, (_, i) => oneRequest(i)));

  // 负载期间采样
  const series: InfraMetricSample[] = [];
  for (let i = 0; i < 8; i++) {
    const snap = await scrapeVllmTarget(BASE).catch(() => null);
    if (snap) {
      series.push(snap);
      const ttft = snap.histograms['vllm:time_to_first_token_seconds'];
      const itl = snap.histograms['vllm:inter_token_latency_seconds'];
      console.log(
        `  [#${i + 1}] running=${snap.gauges['vllm:num_requests_running']} ` +
        `waiting=${snap.gauges['vllm:num_requests_waiting']} ` +
        `kv=${((snap.gauges['vllm:kv_cache_usage_perc'] ?? 0) * 100).toFixed(1)}% ` +
        `gen_tok=${snap.counters['vllm:generation_tokens_total'] ?? 0} ` +
        `ttft_p95=${ttft ? (histQuantile(ttft, 0.95) ?? 0).toFixed(2) : 'n/a'}s ` +
        `itl_avg=${itl ? ((histAvg(itl) ?? 0) * 1000).toFixed(1) : 'n/a'}ms`,
      );
    }
    await sleep(1500);
  }
  await load;

  const res = diagnose(aggregate(series));
  console.log(`\n── 诊断结论(负载窗口) ──`);
  console.log(`VERDICT: ${res.verdict.toUpperCase()}   主瓶颈: ${res.bottleneck}`);
  console.log(
    `信号: gen_tok/s=${res.inputs.genTokPerS.toFixed(1)} running_peak=${res.inputs.runningPeak} ` +
    `kv_peak=${res.inputs.kvPeakPerc.toFixed(1)}% itl_p95=${res.inputs.itlP95 != null ? (res.inputs.itlP95 * 1000).toFixed(1) + 'ms' : 'n/a'} ` +
    `prefix_hit_window=${res.inputs.prefixHitWindow != null ? (res.inputs.prefixHitWindow * 100).toFixed(1) + '%' : 'n/a'}`,
  );
  for (const x of res.findings) {
    console.log(`\n${ICON[x.sev] ?? ''} [${x.cls}] ${x.title}`);
    console.log(`   证据: ${x.evidence}`);
    if (x.remediation.length) console.log(`   建议: ${x.remediation.map((r) => '• ' + r).join('\n         ')}`);
  }
}

main().catch((e) => {
  console.error('负载实测失败:', e instanceof Error ? e.message : e);
  process.exit(1);
});
