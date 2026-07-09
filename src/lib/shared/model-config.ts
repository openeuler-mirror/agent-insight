import fs from 'fs';
import path from 'path';
import DEFAULT_MODELS from './default-models.json';

export const DEFAULT_CACHE_READ_RATIO = 0.1;
export const DEFAULT_CACHE_CREATION_RATIO = 1.25;

export interface ModelPricing {
  inputTokenPrice: number;   // $ per million tokens
  outputTokenPrice: number;  // $ per million tokens
  cacheReadInputTokenPrice?: number;      // $ per million tokens (defaults to inputTokenPrice * DEFAULT_CACHE_READ_RATIO)
  cacheCreationInputTokenPrice?: number;  // $ per million tokens (defaults to inputTokenPrice * DEFAULT_CACHE_CREATION_RATIO)
}

// 内置默认单价 / 上下文窗——从 default-models.json 派生（不再写死在代码里）。
// 键为模型名前缀（最长前缀优先匹配）；自定义单价（custom-models.json）会按前缀覆盖此处。
export const BUILTIN_MODEL_PRICING: Record<string, ModelPricing> = {};
export const BUILTIN_CONTEXT_WINDOWS: Record<string, number> = {};
for (const [key, raw] of Object.entries(DEFAULT_MODELS as unknown as Record<string, Record<string, number>>)) {
  if (key.startsWith('_')) continue; // 跳过 _readme / _source 等元信息
  const v = raw;
  if (typeof v.inputTokenPrice === 'number' && typeof v.outputTokenPrice === 'number') {
    const p: ModelPricing = { inputTokenPrice: v.inputTokenPrice, outputTokenPrice: v.outputTokenPrice };
    if (typeof v.cacheReadInputTokenPrice === 'number') p.cacheReadInputTokenPrice = v.cacheReadInputTokenPrice;
    if (typeof v.cacheCreationInputTokenPrice === 'number') p.cacheCreationInputTokenPrice = v.cacheCreationInputTokenPrice;
    BUILTIN_MODEL_PRICING[key] = p;
  }
  if (typeof v.contextWindow === 'number') BUILTIN_CONTEXT_WINDOWS[key] = v.contextWindow;
}

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

export interface CustomModelEntry extends ModelPricing {
  contextWindow?: number;
}

/** 读取当前自定义单价表（供「模型单价」管理界面展示）。 */
export function getCustomModels(): { pricing: Record<string, ModelPricing>; contextWindows: Record<string, number> } {
  return loadCustomModels();
}

/**
 * 覆写自定义单价表 custom-models.json（供「模型单价」管理界面保存）。
 * 写后置 mtime=-1，确保下次 getModelPricing/getModelContextWindow 重新加载最新内容。
 */
export function writeCustomModels(models: Record<string, CustomModelEntry>): void {
  const out: Record<string, unknown> = {
    _readme: '模型单价（USD / 百万 token）。由「模型注册 → 模型单价」界面维护；缺该文件时相应模型成本按 0 计并在仪表盘告警。',
  };
  for (const [key, v] of Object.entries(models)) {
    if (!key || key.startsWith('_')) continue;
    const entry: Record<string, number> = {
      inputTokenPrice: v.inputTokenPrice,
      outputTokenPrice: v.outputTokenPrice,
    };
    if (v.cacheReadInputTokenPrice != null) entry.cacheReadInputTokenPrice = v.cacheReadInputTokenPrice;
    if (v.cacheCreationInputTokenPrice != null) entry.cacheCreationInputTokenPrice = v.cacheCreationInputTokenPrice;
    if (v.contextWindow != null) entry.contextWindow = v.contextWindow;
    out[key] = entry;
  }
  fs.writeFileSync(CUSTOM_MODELS_PATH, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  customPricingMtime = -1;
}
