import { getActiveConfig, getUserSettings } from '@/lib/storage/server-config';
import type { ModelConfig as OpencodeModelConfig } from '@/lib/engine/skill-generation/opencode-agent-cli/opencode-client';
import { isModelConnectionReady } from '@/lib/shared/model-connection';

/**
 * 服务端 ModelConfig（用户在 settings 里维护）→ opencode SDK 需要的 ModelConfig 形态。
 *
 * 字段映射：
 *   apiKey   → apiKey
 *   baseUrl  → baseURL
 *   model    → modelID
 *   provider → providerID（仅 default 配置带；用户自建配置没此字段，从 baseUrl 推断）
 *
 * 如果用户没设置 active config，返回 null，由 caller 决定是否走 env 兜底。
 */
export async function loadServerModelForUser(
  user: string,
): Promise<OpencodeModelConfig | null> {
  const cfg = await getActiveConfig(user);
  return mapServerModelConfig(cfg);
}

/**
 * Resolve one explicitly frozen server-side model configuration. This is used by
 * reproducible background evaluations so changing the active model later does not
 * silently change an already-created experiment.
 */
export async function loadServerModelForUserById(
  user: string,
  configId: string,
): Promise<OpencodeModelConfig | null> {
  const settings = await getUserSettings(user);
  const cfg = settings.configs.find((item) => item.id === configId) || null;
  return mapServerModelConfig(cfg);
}

function mapServerModelConfig(
  cfg: Awaited<ReturnType<typeof getActiveConfig>>,
): OpencodeModelConfig | null {
  if (!cfg || !isModelConnectionReady(cfg)) return null;

  // provider 字段只在 default 配置上存在；强转读一下
  const explicitProvider = (cfg as { provider?: string }).provider;
  const providerID = normalizeProviderID(explicitProvider || inferProviderFromBaseUrl(cfg.baseUrl));
  const modelID = cfg.model || defaultModelForProvider(providerID);

  return {
    providerID,
    modelID,
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl || defaultBaseUrlForProvider(providerID),
    headers: cfg.headers,
  };
}

/**
 * 用户存的 providerID 别名 → opencode 实际注册的 providerID。
 * 例如 UI 里选 "deepseek" 存到 DB，但 opencode 只认识 "deepseek-official"。
 */
const PROVIDER_ALIAS: Record<string, string> = {
  'deepseek': 'deepseek-official',
};

export function normalizeProviderID(providerID: string): string {
  return PROVIDER_ALIAS[providerID] ?? providerID;
}

/** 从 baseUrl 推断 opencode providerID。未识别时返回 'deepseek-official' 兜底。 */
export function inferProviderFromBaseUrl(baseUrl?: string): string {
  if (!baseUrl) return 'deepseek-official';
  const lower = baseUrl.toLowerCase();
  if (lower.includes('api.deepseek.com')) return 'deepseek-official';
  if (lower.includes('api.openai.com')) return 'openai';
  if (lower.includes('api.anthropic.com')) return 'anthropic';
  if (lower.includes('generativelanguage.googleapis.com')) return 'google';
  if (lower.includes('dashscope')) return 'qwen';
  if (lower.includes('moonshot')) return 'moonshot';
  // 兜底：当作 deepseek-official（OpenAI 兼容协议），由 baseURL 强制路由
  return 'deepseek-official';
}

function defaultBaseUrlForProvider(providerID: string): string | undefined {
  switch (providerID) {
    case 'deepseek':
    case 'deepseek-official':
      return 'https://api.deepseek.com';
    case 'openai':
      return 'https://api.openai.com/v1';
    case 'anthropic':
      return 'https://api.anthropic.com';
    default:
      return undefined;
  }
}

function defaultModelForProvider(providerID: string): string {
  switch (providerID) {
    case 'deepseek':
    case 'deepseek-official':
      return 'deepseek-v4-flash';
    case 'openai':
      return 'gpt-4o-mini';
    case 'anthropic':
      return 'claude-haiku-4-5-20251001';
    default:
      return 'deepseek-v4-flash';
  }
}
