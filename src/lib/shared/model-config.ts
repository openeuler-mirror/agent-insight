import fs from 'fs';
import path from 'path';

export const DEFAULT_CACHE_READ_RATIO = 0.1;
export const DEFAULT_CACHE_CREATION_RATIO = 1.25;

export interface ModelPricing {
  inputTokenPrice: number;   // $ per million tokens
  outputTokenPrice: number;  // $ per million tokens
  cacheReadInputTokenPrice?: number;      // $ per million tokens (defaults to inputTokenPrice * DEFAULT_CACHE_READ_RATIO)
  cacheCreationInputTokenPrice?: number;  // $ per million tokens (defaults to inputTokenPrice * DEFAULT_CACHE_CREATION_RATIO)
}

// Built-in pricing per million tokens
// Keys are used as prefixes for matching versioned model names
const BUILTIN_MODEL_PRICING: Record<string, ModelPricing> = {
  // Claude
  'claude-opus-4-6':   { inputTokenPrice: 5, outputTokenPrice: 25, cacheReadInputTokenPrice: 0.50, cacheCreationInputTokenPrice: 6.25 },
  'claude-sonnet-4-6': { inputTokenPrice: 3, outputTokenPrice: 15, cacheReadInputTokenPrice: 0.30, cacheCreationInputTokenPrice: 3.75 },
  // DeepSeek
  'deepseek-chat':     { inputTokenPrice: 0.28, outputTokenPrice: 0.42, cacheReadInputTokenPrice: 0.028 },
  'deepseek-reasoner': { inputTokenPrice: 0.28, outputTokenPrice: 0.42, cacheReadInputTokenPrice: 0.028 },
  // MiniMax (via OpenCode)
  'minimax-m2.5-free': { inputTokenPrice: 0, outputTokenPrice: 0 },
};

// Built-in context window sizes (max tokens)
const BUILTIN_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-6':   1000000,
  'claude-sonnet-4-6': 1000000,
  'deepseek-chat':     128000,
  'deepseek-reasoner': 128000,
  'minimax-m2.5-free': 196608,
};

const CUSTOM_MODELS_PATH = path.join(process.cwd(), 'custom-models.json');

let customPricingCache: Record<string, ModelPricing> = {};
let customContextWindowCache: Record<string, number> = {};
let customPricingMtime: number = -1;

function loadCustomModels(): { pricing: Record<string, ModelPricing>; contextWindows: Record<string, number> } {
  try {
    const mtime = fs.statSync(CUSTOM_MODELS_PATH).mtimeMs;
    if (mtime === customPricingMtime) return { pricing: customPricingCache, contextWindows: customContextWindowCache };
    const raw = JSON.parse(fs.readFileSync(CUSTOM_MODELS_PATH, 'utf-8'));
    const entries: Record<string, ModelPricing> = {};
    const ctxWindows: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key.startsWith('_')) continue; // skip meta keys like _readme
      const v = value as Record<string, unknown>;
      if (typeof v.inputTokenPrice === 'number' && typeof v.outputTokenPrice === 'number') {
        entries[key] = v as unknown as ModelPricing;
      }
      if (typeof v.contextWindow === 'number') {
        ctxWindows[key] = v.contextWindow;
      }
    }
    customPricingCache = entries;
    customContextWindowCache = ctxWindows;
    customPricingMtime = mtime;
  } catch (e) {
    if (e instanceof SyntaxError) {
      console.warn('[model-config] Failed to parse custom-models.json:', e.message);
    }
    customPricingCache = {};
    customContextWindowCache = {};
    customPricingMtime = -1;
  }
  return { pricing: customPricingCache, contextWindows: customContextWindowCache };
}

function findByPrefix<T>(modelName: string, table: Record<string, T>): T | null {
  if (table[modelName]) return table[modelName];
  const sorted = Object.entries(table).sort((a, b) => b[0].length - a[0].length);
  for (const [key, value] of sorted) {
    if (modelName.startsWith(key)) return value;
  }
  return null;
}

export type PricingSource = 'default' | 'custom';

export interface ModelPricingResult {
  pricing: ModelPricing;
  source: PricingSource;
}

export function getModelPricing(modelName: string): ModelPricingResult | null {
  // Custom pricing takes precedence over built-in
  const { pricing: customPricing } = loadCustomModels();
  const custom = findByPrefix(modelName, customPricing);
  if (custom) return { pricing: custom, source: 'custom' };
  const builtin = findByPrefix(modelName, BUILTIN_MODEL_PRICING);
  if (builtin) return { pricing: builtin, source: 'default' };
  return null;
}

export interface ModelContextWindowResult {
  contextWindow: number;
  source: PricingSource;
}

export function getModelContextWindow(modelName: string): ModelContextWindowResult | null {
  const { contextWindows } = loadCustomModels();
  const customCw = findByPrefix(modelName, contextWindows);
  if (customCw != null) return { contextWindow: customCw, source: 'custom' };
  const builtinCw = findByPrefix(modelName, BUILTIN_CONTEXT_WINDOWS);
  if (builtinCw != null) return { contextWindow: builtinCw, source: 'default' };
  return null;
}

export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  pricing: ModelPricing,
  cacheReadTokens?: number,
  cacheCreationTokens?: number,
): number {
  const cacheRead = cacheReadTokens ?? 0;
  const cacheCreate = cacheCreationTokens ?? 0;
  const cacheReadPrice = pricing.cacheReadInputTokenPrice ?? pricing.inputTokenPrice * DEFAULT_CACHE_READ_RATIO;
  const cacheCreatePrice = pricing.cacheCreationInputTokenPrice ?? pricing.inputTokenPrice * DEFAULT_CACHE_CREATION_RATIO;
  return (
    inputTokens * pricing.inputTokenPrice +
    cacheRead * cacheReadPrice +
    cacheCreate * cacheCreatePrice +
    outputTokens * pricing.outputTokenPrice
  ) / 1_000_000;
}
