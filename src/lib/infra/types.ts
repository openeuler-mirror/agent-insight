// 统一的「AI 推理 infra 层」内部模型，源无关：Path A（拉 Prometheus 文本）与
// Path C（推 OTLP）都归一到 InfraMetricSample，再喂给同一个诊断内核。

export interface HistogramBucket {
  /** Prometheus 累计桶上界；+Inf 桶用 Infinity 表示。 */
  le: number;
  /** 累计计数（<= le 的样本数）。 */
  count: number;
}

export interface Histogram {
  buckets: HistogramBucket[];
  sum: number;
  count: number;
}

/** 一次采样 = 某个推理源在 T 时刻的状态。 */
export interface InfraMetricSample {
  tsMs: number;
  /** 采集路径标识，如 vllm-pull / vllm-otlp-push。 */
  source: string;
  /** 采集目标（scrape 地址或 collector 标识）。 */
  target: string;
  model: string | null;
  gauges: Record<string, number>;
  /** 累计值；rate 在查询/聚合时算。 */
  counters: Record<string, number>;
  histograms: Record<string, Histogram>;
  /** num_requests_waiting_by_reason 的 reason→值拆分。 */
  waitingByReason: Record<string, number>;
}

// vLLM V1 实测指标名（以真机为准，勿照搬文档默认名）。Path A/C 共用这套规范键。
export const VLLM_GAUGES = [
  'vllm:num_requests_running',
  'vllm:num_requests_waiting',
  'vllm:kv_cache_usage_perc',
] as const;

export const VLLM_COUNTERS = [
  'vllm:prompt_tokens_total',
  'vllm:generation_tokens_total',
  'vllm:num_preemptions_total',
  'vllm:prefix_cache_queries_total',
  'vllm:prefix_cache_hits_total',
  'vllm:estimated_flops_per_gpu_total',
  'vllm:estimated_read_bytes_per_gpu_total',
  'vllm:estimated_write_bytes_per_gpu_total',
] as const;

export const VLLM_HISTOGRAMS = [
  'vllm:time_to_first_token_seconds',
  'vllm:inter_token_latency_seconds',
  'vllm:request_time_per_output_token_seconds',
  'vllm:e2e_request_latency_seconds',
  'vllm:request_queue_time_seconds',
  'vllm:request_prefill_time_seconds',
  'vllm:request_inference_time_seconds',
] as const;

export const VLLM_WAITING_BY_REASON = 'vllm:num_requests_waiting_by_reason';

// ---- 诊断内核的类型 -------------------------------------------------------

export type Severity = 'critical' | 'warn' | 'healthy' | 'info';
export type Verdict = 'idle' | 'healthy' | 'degraded' | 'critical';
export type FindingClass = 'idle' | 'queue' | 'kv' | 'cache' | 'bandwidth' | 'headroom';

export interface Finding {
  sev: Severity;
  cls: FindingClass;
  title: string;
  /** 触发该结论的原始读数。 */
  evidence: string;
  diagnosis: string;
  remediation: string[];
}

/** 源的硬件画像；诊断阈值按它调（不写死某张卡）。 */
export interface HardwareProfile {
  name: string;
  /** 显存/统一内存带宽，GB/s。decode 带宽判别用。 */
  memBandwidthGBs: number;
  memGB?: number;
}

/** aggregate() 把一段时间窗的快照压成一组诊断输入信号。 */
export interface DiagnoseInputs {
  hadLoad: boolean;
  runningPeak: number;
  runningAvg: number;
  waitingPeak: number;
  kvPeakPerc: number;
  preemptRate: number;
  genTokPerS: number;
  promptTokPerS: number;
  prefixHitWindow: number | null;
  prefixHitLifetime: number | null;
  ttftP95: number | null;
  ttftAvg: number | null;
  itlP95: number | null;
  itlAvg: number | null;
  tpotP95: number | null;
  queueP95: number | null;
  queueAvg: number | null;
  prefillP95: number | null;
  prefillAvg: number | null;
  e2eP95: number | null;
  model: string | null;
}

export interface DiagnoseResult {
  verdict: Verdict;
  bottleneck: FindingClass | 'none';
  findings: Finding[];
  inputs: DiagnoseInputs;
}
