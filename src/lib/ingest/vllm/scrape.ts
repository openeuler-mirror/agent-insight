// Path A 拉取器：定时 GET 某个 vLLM 源的 `/metrics` → 解析 → 归一到 InfraMetricSample。
// fetch 可注入便于测试；endpoint 归一（剔除 query/内联凭证）= session↔infra 的关联键。

import { normalize, normalizeByModel, parsePromText } from '@/lib/ingest/vllm/prom-text';
import type { InfraMetricSample } from '@/lib/infra/types';

// 「功能性尾段」：同一个推理实例的不同入口，去掉它们之后剩下的 path 才是实例身份。
//   /spark/qwen35/metrics 与 /spark/qwen35/v1/chat/completions → 都是 /spark/qwen35
const METRICS_SUFFIX = /\/metrics\/?$/i;
const OPENAI_SUFFIX = /\/v\d+(\/chat)?(\/completions)?\/?$/i;

/**
 * 源身份键：剔除 query/内联凭证，并剥掉功能性尾段，保留「实例路径」。
 *
 * 裸机源没有实例路径 → 退化成 scheme://host:port（与历史行为逐字一致）：
 *   http://h:8000/metrics · http://h:8000/v1 · http://h:8000  → http://h:8000
 * 网关托管的源保留实例路径，否则同网关的多个实例会撞成同一个身份：
 *   https://gw/spark/qwen35/metrics · https://gw/spark/qwen35/v1 → https://gw/spark/qwen35
 *   http://gw:8088/v2/infer/<uuid>/metrics                      → http://gw:8088/v2/infer/<uuid>
 *
 * 关键约束：metrics 地址与 agent 侧 baseURL 必须归到同一个键，否则 session↔infra 关联对不上。
 */
export function normalizeEndpoint(raw: string): string {
  const u = new URL(raw);
  const path = u.pathname.replace(/\/+$/, '').replace(METRICS_SUFFIX, '').replace(OPENAI_SUFFIX, '');
  return `${u.protocol}//${u.host}${path}`;
}

/** 把一个源地址规整成它的 `/metrics` 抓取 URL（剔除凭证/query）。 */
export function metricsUrl(target: string): string {
  const u = new URL(target);
  u.username = '';
  u.password = '';
  u.search = '';
  u.hash = '';
  if (!u.pathname.endsWith('/metrics')) {
    u.pathname = u.pathname.replace(/\/+$/, '') + '/metrics';
  }
  return u.toString();
}

export interface ScrapeOptions {
  timeoutMs?: number;
  tsMs?: number;
  /** 注入用，测试时替换真实网络；默认全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 抓取时附加的鉴权 header，如 { Authorization: 'bearer xxx' }。源上配了才有。 */
  headers?: Record<string, string>;
}

/** 拉一次目标的 /metrics 并归一成一条 InfraMetricSample。 */
export async function scrapeVllmTarget(target: string, opts: ScrapeOptions = {}): Promise<InfraMetricSample> {
  const { timeoutMs = 8000, tsMs = Date.now(), fetchImpl = fetch, headers } = opts;
  const url = metricsUrl(target);

  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`scrape ${url} failed: HTTP ${res.status}`);
  }
  const text = await res.text();
  return normalize(parsePromText(text), {
    source: 'vllm-pull',
    target: normalizeEndpoint(target),
    tsMs,
  });
}

/** 拉一次目标的 /metrics，按 model_name 拆成「每模型一条」InfraMetricSample。 */
export async function scrapeVllmTargetModels(target: string, opts: ScrapeOptions = {}): Promise<InfraMetricSample[]> {
  const { timeoutMs = 8000, tsMs = Date.now(), fetchImpl = fetch, headers } = opts;
  const url = metricsUrl(target);

  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`scrape ${url} failed: HTTP ${res.status}`);
  }
  const text = await res.text();
  return normalizeByModel(parsePromText(text), {
    source: 'vllm-pull',
    target: normalizeEndpoint(target),
    tsMs,
  });
}
