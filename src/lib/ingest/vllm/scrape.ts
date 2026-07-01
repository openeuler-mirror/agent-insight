// Path A 拉取器：定时 GET 某个 vLLM 源的 `/metrics` → 解析 → 归一到 InfraMetricSample。
// fetch 可注入便于测试；endpoint 归一（剔除 query/内联凭证）= session↔infra 的关联键。

import { normalize, normalizeByModel, parsePromText } from '@/lib/ingest/vllm/prom-text';
import type { InfraMetricSample } from '@/lib/infra/types';

/** 源身份 = scheme://host:port（剔除 path/query/内联凭证）。用作关联真实 URL 的稳定键。 */
export function normalizeEndpoint(raw: string): string {
  const u = new URL(raw);
  return `${u.protocol}//${u.host}`;
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
}

/** 拉一次目标的 /metrics 并归一成一条 InfraMetricSample。 */
export async function scrapeVllmTarget(target: string, opts: ScrapeOptions = {}): Promise<InfraMetricSample> {
  const { timeoutMs = 8000, tsMs = Date.now(), fetchImpl = fetch } = opts;
  const url = metricsUrl(target);

  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
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
  const { timeoutMs = 8000, tsMs = Date.now(), fetchImpl = fetch } = opts;
  const url = metricsUrl(target);

  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
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
