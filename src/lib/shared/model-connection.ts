export interface ModelConnectionConfig {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  headers?: Record<string, string>;
}

const FORBIDDEN_CUSTOM_HEADERS = new Set([
  '__proto__',
  'connection',
  'constructor',
  'content-length',
  'host',
  'prototype',
  'transfer-encoding',
]);

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function supportsCustomHeaders(config: ModelConnectionConfig): boolean {
  return config.provider === 'custom';
}

export function isModelConnectionReady(
  config: ModelConnectionConfig | null | undefined,
): boolean {
  if (!config) return false;
  if (supportsCustomHeaders(config)) {
    return Boolean(config.baseUrl?.trim() && config.model?.trim());
  }
  return Boolean(config.apiKey?.trim());
}

export function normalizeCustomHeaders(
  headers: Record<string, string> | null | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  if (Array.isArray(headers) || typeof headers !== 'object') {
    throw new Error('Custom headers must be a JSON object');
  }
  const normalized: Record<string, string> = {};
  const seen = new Set<string>();

  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim();
    const value = typeof rawValue === 'string' ? rawValue : '';
    if (!name && !value) continue;
    if (!name || !HEADER_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid HTTP header name: ${rawName || '(empty)'}`);
    }
    if (!value.trim() || /[\r\n]/.test(value)) {
      throw new Error(`Invalid value for HTTP header: ${name}`);
    }
    const lowerName = name.toLowerCase();
    if (FORBIDDEN_CUSTOM_HEADERS.has(lowerName)) {
      throw new Error(`HTTP header is managed by the transport and cannot be configured: ${name}`);
    }
    if (seen.has(lowerName)) {
      throw new Error(`Duplicate HTTP header name: ${name}`);
    }
    seen.add(lowerName);
    normalized[name] = value;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function getOpenAICompatibleClientConfig(config: ModelConnectionConfig): {
  apiKey: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
} {
  return {
    apiKey: config.apiKey?.trim() || 'no-api-key-required',
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    ...(config.headers && Object.keys(config.headers).length > 0
      ? { defaultHeaders: config.headers }
      : {}),
  };
}
