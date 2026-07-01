// 瓶颈诊断内核（项目核心价值）：纯函数、源无关 —— Path A（拉）/ Path C（推）共用一份。
// 心智模型：prefill 计算受限、decode 显存带宽受限；TTFT≈prefill、TPOT≈decode。
// 规则在 .spike/infra-observability/03-diagnose.mjs 上跨 idle/queue/kv/preempt/cache/bandwidth 真机验证。

import { histAvg, histQuantile } from '@/lib/ingest/vllm/prom-text';
import type {
  DiagnoseInputs,
  DiagnoseResult,
  Finding,
  FindingClass,
  HardwareProfile,
  InfraMetricSample,
  Severity,
} from '@/lib/infra/types';

/** 默认硬件画像 = NVIDIA GB10（LPDDR5X 统一内存 ~273GB/s，decode 几乎总是带宽受限）。 */
export const GB10: HardwareProfile = { name: 'NVIDIA GB10', memBandwidthGBs: 273, memGB: 128 };

// SLO 经验阈值（交互场景，可随硬件/流量校准）。
const SLO = { ttftP95: 0.5, itlP95: 0.25, kvWarn: 80, kvCrit: 90, prefixWarn: 0.5 };

/** 把一段窗口的快照（或单个快照）聚合成诊断输入信号。 */
export function aggregate(snapshots: InfraMetricSample | InfraMetricSample[]): DiagnoseInputs {
  const arr = Array.isArray(snapshots) ? snapshots : [snapshots];
  if (arr.length === 0) throw new Error('aggregate: 至少需要一个快照');
  const first = arr[0];
  const last = arr[arr.length - 1];

  const series = (k: string): number[] => arr.map((s) => s.gauges[k] ?? 0);
  const peak = (k: string): number => Math.max(...series(k));
  const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

  const dt = Math.max(1e-3, (last.tsMs - first.tsMs) / 1000);
  const dCounter = (k: string): number => (last.counters[k] ?? 0) - (first.counters[k] ?? 0);
  const genTokPerS = dCounter('vllm:generation_tokens_total') / dt;
  const promptTokPerS = dCounter('vllm:prompt_tokens_total') / dt;
  const preemptRate = dCounter('vllm:num_preemptions_total') / dt;

  const dPrefixQ = dCounter('vllm:prefix_cache_queries_total');
  const dPrefixH = dCounter('vllm:prefix_cache_hits_total');
  const prefixHitWindow = dPrefixQ > 0 ? dPrefixH / dPrefixQ : null;
  const lifeQ = last.counters['vllm:prefix_cache_queries_total'] ?? 0;
  const prefixHitLifetime = lifeQ > 0 ? (last.counters['vllm:prefix_cache_hits_total'] ?? 0) / lifeQ : null;

  const H = last.histograms;
  const sec = (h: string, q: number): number | null => histQuantile(H[h], q);

  return {
    hadLoad: peak('vllm:num_requests_running') > 0 || genTokPerS > 1,
    runningPeak: peak('vllm:num_requests_running'),
    runningAvg: avg(series('vllm:num_requests_running').filter((x) => x > 0)),
    waitingPeak: peak('vllm:num_requests_waiting'),
    kvPeakPerc: peak('vllm:kv_cache_usage_perc') * 100,
    preemptRate,
    genTokPerS,
    promptTokPerS,
    prefixHitWindow,
    prefixHitLifetime,
    ttftP95: sec('vllm:time_to_first_token_seconds', 0.95),
    ttftAvg: histAvg(H['vllm:time_to_first_token_seconds']),
    itlP95: sec('vllm:inter_token_latency_seconds', 0.95),
    itlAvg: histAvg(H['vllm:inter_token_latency_seconds']),
    tpotP95: sec('vllm:request_time_per_output_token_seconds', 0.95),
    queueP95: sec('vllm:request_queue_time_seconds', 0.95),
    queueAvg: histAvg(H['vllm:request_queue_time_seconds']),
    prefillP95: sec('vllm:request_prefill_time_seconds', 0.95),
    prefillAvg: histAvg(H['vllm:request_prefill_time_seconds']),
    e2eP95: sec('vllm:e2e_request_latency_seconds', 0.95),
    model: last.model,
  };
}

/** 信号 → 瓶颈类别 → 处置建议。hw 决定带宽类阈值与建议措辞。 */
export function diagnose(a: DiagnoseInputs, hw: HardwareProfile = GB10): DiagnoseResult {
  const f: Finding[] = [];
  const add = (
    sev: Severity,
    cls: FindingClass,
    title: string,
    evidence: string,
    diagnosis: string,
    remediation: string[] = [],
  ): void => {
    f.push({ sev, cls, title, evidence, diagnosis, remediation });
  };
  const f2 = (x: number | null | undefined, d = 2): string => (x == null ? 'n/a' : x.toFixed(d));

  if (!a.hadLoad) {
    add('info', 'idle', '空载 / 无活跃推理', `running_peak=${a.runningPeak} gen_tok/s=${a.genTokPerS.toFixed(0)}`,
      '窗口内无活跃请求，无可定位的瓶颈。若用于基线巡检可忽略。');
    return { verdict: 'idle', bottleneck: 'none', findings: f, inputs: a };
  }

  // 排队 / 容量
  if (a.waitingPeak > 0 && (a.queueP95 ?? 0) > (a.prefillP95 ?? 0)) {
    add('critical', 'queue', '排队受限(容量不足，非算得慢)',
      `waiting_peak=${a.waitingPeak} queue_p95=${f2(a.queueP95)}s prefill_p95=${f2(a.prefillP95)}s`,
      '请求在 WAITING 阶段积压，排队时间已超过 prefill 时间 —— 到达速率 > 服务能力，瓶颈是容量而非单请求计算。',
      ['横向扩副本 / 负载均衡', '考虑 prefill-decode 分离(PD disaggregation)', '按 num_requests_waiting 做自动扩缩(而非按 GPU util)']);
  } else if ((a.ttftP95 ?? 0) > SLO.ttftP95 && (a.queueP95 ?? 0) > 0.2 && (a.prefillP95 ?? 0) < (a.queueP95 ?? 0)) {
    add('warn', 'queue', 'TTFT 高，但根因是排队不是 prefill',
      `ttft_p95=${f2(a.ttftP95)}s queue_p95=${f2(a.queueP95)}s prefill_p95=${f2(a.prefillP95)}s`,
      '负载下 TTFT 抬升主要来自排队等待，prefill 本身不慢 —— 别去优化 prefill，该扩容。',
      ['扩副本 / 提高并发调度能力']);
  }

  // KV 压力
  if (a.kvPeakPerc >= SLO.kvCrit) {
    add('critical', 'kv', 'KV cache 压力(显存不够撑 batch)',
      `kv_peak=${a.kvPeakPerc.toFixed(1)}% waiting_peak=${a.waitingPeak} preempt_rate=${a.preemptRate.toFixed(2)}/s`,
      'KV cache 接近占满，batch 受显存上限制约，并发与吞吐被压制，排队请求会击穿 TTFT SLO。',
      ['启用 FP8 KV cache(约省一半)', '提高 --gpu-memory-utilization(权重有余量时 0.90→0.95)', '降低 --max-model-len / 限制最大输出', '增加副本', '启用/扩大 prefix caching']);
  } else if (a.kvPeakPerc >= SLO.kvWarn) {
    add('warn', 'kv', 'KV cache 偏高(接近压力区)',
      `kv_peak=${a.kvPeakPerc.toFixed(1)}%`,
      'KV 占用进入预警区，流量再涨可能触发抢占/排队。',
      ['提前规划 FP8 KV / 扩容', '观察 num_preemptions_total 是否开始 >0']);
  }

  // 抢占 / 抖动
  if (a.preemptRate > 0) {
    add('critical', 'kv', '发生抢占(KV 过载，重算拉高 TPOT 尾延迟)',
      `preempt_rate=${a.preemptRate.toFixed(2)}/s tpot_p95=${f2(a.tpotP95, 3)}s`,
      'KV 过度占用导致运行中的序列被驱逐并重算(或换出)，直接抬高 TPOT 的 p95/p99 抖动。',
      ['同 KV 压力处置：减小 batch/上下文、量化 KV、加显存/副本']);
  }

  // prefix cache 效率
  const hit = a.prefixHitWindow ?? a.prefixHitLifetime;
  if (hit != null && hit < SLO.prefixWarn) {
    add('warn', 'cache', 'Prefix cache 命中率低',
      `hit_rate=${(hit * 100).toFixed(1)}%`,
      '提示词复用差，重复在做 prefill 计算，浪费算力、抬高 TTFT。',
      ['让共享前缀(system/few-shot)前置、稳定', '增大 prefix cache', '排查每请求是否带了易变内容打断缓存']);
  } else if (hit != null && hit >= 0.8) {
    add('healthy', 'cache', 'Prefix cache 命中率优秀',
      `hit_rate=${(hit * 100).toFixed(1)}%`,
      'prefix 复用很好，大量 prefill 被缓存吸收，显著省算力、降 TTFT。这是当前服务的优势项。');
  }

  // decode 带宽受限 vs prefill 计算受限
  const itl = a.itlP95 ?? a.itlAvg;
  if (itl != null) {
    if (itl > SLO.itlP95) {
      add('warn', 'bandwidth', 'Decode 显存带宽受限(TPOT 偏高)',
        `itl_p95=${itl.toFixed(3)}s (SLO ${SLO.itlP95}s) gen_tok/s=${a.genTokPerS.toFixed(0)} hw=${hw.name}@${hw.memBandwidthGBs}GB/s`,
        `逐 token 解码偏慢，decode 阶段受统一内存/HBM 带宽制约。${hw.name} 带宽 ~${hw.memBandwidthGBs}GB/s，这是预期主瓶颈区。`,
        ['权重量化(FP8) + FP8 KV cache 减少每 token 读取字节', '增大 decode batch 提升带宽利用', '投机解码(speculative decoding)', '更高带宽硬件(若需更高单流速度)']);
    } else {
      add('healthy', 'bandwidth', 'Decode 速度健康',
        `itl_p95=${itl.toFixed(3)}s gen_tok/s=${a.genTokPerS.toFixed(0)}`,
        '逐 token 延迟在交互 SLO 内，解码带宽充裕。');
    }
  }

  // 利用率 / 余量 —— 修复点：只有在没有任何 warn/critical 时才报「有余量」，
  // 否则会出现「Decode 带宽受限」与「有余量」自相矛盾地并存（spike 待办小修）。
  const hasActionable = f.some((x) => x.sev === 'critical' || x.sev === 'warn');
  if (!hasActionable && a.waitingPeak === 0 && a.kvPeakPerc < SLO.kvWarn && a.preemptRate === 0 &&
      (a.ttftP95 == null || a.ttftP95 < SLO.ttftP95 * 4)) {
    add('info', 'headroom', '有余量(未饱和)',
      `running_peak=${a.runningPeak} kv_peak=${a.kvPeakPerc.toFixed(1)}% waiting=0 preempt=0`,
      '无排队、KV 远未占满、无抢占 —— 当前负载下基础设施有明显余量，可承接更高并发或增大 batch 提升吞吐。',
      ['可调高 --max-num-seqs 提吞吐', '若追求成本效率，可在该卡上叠加更多并发/合并服务']);
  }

  // 总评：取最严重的可执行类别。
  const order: Record<Severity, number> = { critical: 3, warn: 2, healthy: 1, info: 0 };
  const actionable = f.filter((x) => x.sev === 'critical' || x.sev === 'warn');
  actionable.sort((x, y) => order[y.sev] - order[x.sev]);
  const bottleneck: FindingClass | 'none' = actionable[0]?.cls ?? 'none';
  const verdict: DiagnoseResult['verdict'] =
    actionable.length === 0 ? 'healthy' : actionable[0].sev === 'critical' ? 'critical' : 'degraded';

  return { verdict, bottleneck, findings: f, inputs: a };
}
