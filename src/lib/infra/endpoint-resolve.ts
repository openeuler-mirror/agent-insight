// 从 OpenCode 上报链路解析每条记录命中的「真实推理源 URL」=关联键。
// 真相（spike 07 真机验证 34/34）：URL 不在上报数据里，但插件 `config` hook 收到的整份 cfg
// 写成 `config.redacted` 事件入 spool，其中 provider.<id>.options.baseURL 未被打码 → 可取出。

import { normalizeEndpoint } from '@/lib/ingest/vllm/scrape';

interface ProviderOptions {
  baseURL?: string;
}
interface ProviderEntry {
  baseURL?: string;
  options?: ProviderOptions;
}
export interface ConfigRedactedEvent {
  kind?: string;
  payload?: {
    type?: string;
    config?: { provider?: Record<string, ProviderEntry> };
  };
}

/** 从 spool 事件里建 providerID → baseURL 映射（取最后一次出现）。 */
export function buildProviderEndpointMap(events: ConfigRedactedEvent[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const e of events) {
    if (e.kind === 'event' && e.payload?.type === 'config.redacted') {
      const prov = e.payload.config?.provider ?? {};
      for (const [id, p] of Object.entries(prov)) {
        const url = p?.options?.baseURL ?? p?.baseURL;
        if (url) map[id] = url;
      }
    }
  }
  return map;
}

/** 把 baseURL 归一成关联键 scheme://host:port（剔除 path/query/凭证）。非法 URL → null。 */
export function normalizeEndpointUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    return normalizeEndpoint(raw);
  } catch {
    return null;
  }
}

/** 给一条带 providerID 的记录解析真实 endpoint（关联键）；解析不到返回 null（不编造）。 */
export function resolveRecordEndpoint(
  record: { providerID?: string | null },
  map: Record<string, string>,
): string | null {
  if (!record.providerID) return null;
  return normalizeEndpointUrl(map[record.providerID] ?? null);
}
