// 接入源注册表：从 session 见过的 (endpoint, model) 自动带出候选源，探测 /metrics
// 判定是否为可观测的 vLLM 源（可达 + 有 vllm: 指标），供「一键导入」。

import { metricsUrl, normalizeEndpoint } from '@/lib/ingest/vllm/scrape';
import { parsePromText } from '@/lib/ingest/vllm/prom-text';

export interface EndpointRow {
  endpoint: string | null;
  model?: string | null;
}

export interface SourceCandidate {
  endpoint: string;
  models: string[];
  /** 用过该 endpoint 的执行条数。 */
  count: number;
}

/** 从执行记录里聚合出候选源（按归一后的 endpoint 分组）。 */
export function deriveCandidates(rows: EndpointRow[]): SourceCandidate[] {
  const byEndpoint = new Map<string, { models: Set<string>; count: number }>();
  for (const r of rows) {
    if (!r.endpoint) continue;
    let key: string;
    try {
      key = normalizeEndpoint(r.endpoint);
    } catch {
      continue; // 非法 URL 跳过
    }
    const entry = byEndpoint.get(key) ?? { models: new Set<string>(), count: 0 };
    entry.count += 1;
    if (r.model) entry.models.add(r.model);
    byEndpoint.set(key, entry);
  }
  return [...byEndpoint.entries()]
    .map(([endpoint, v]) => ({ endpoint, models: [...v.models], count: v.count }))
    .sort((a, b) => b.count - a.count);
}

export interface ProbeResult {
  endpoint: string;
  reachable: boolean;
  /** 探测到的 vllm: 指标族数量（可达时）。 */
  metricCount: number;
  model: string | null;
  error?: string;
}

/** 探测一个候选源的 /metrics：可达且有 vllm: 指标 = 可观测源。 */
export async function probeEndpoint(
  endpoint: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const { fetchImpl = fetch, timeoutMs = 8000 } = opts;
  const url = metricsUrl(endpoint);
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { endpoint, reachable: false, metricCount: 0, model: null, error: `HTTP ${res.status}` };
    const text = await res.text();
    const parsed = parsePromText(text);
    let model: string | null = null;
    const families = new Set<string>();
    for (const s of parsed.samples) {
      if (s.name.startsWith('vllm:')) families.add(s.name.replace(/_(bucket|sum|count|created)$/, ''));
      if (s.labels.model_name) model = s.labels.model_name;
    }
    return { endpoint, reachable: families.size > 0, metricCount: families.size, model };
  } catch (e) {
    return { endpoint, reachable: false, metricCount: 0, model: null, error: e instanceof Error ? e.message : String(e) };
  }
}
