import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { createLogger } from "@/lib/logger";

const logger = createLogger("skill-generation:model");

export interface ModelOptions {
  modelId?: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  /**
   * Explicit provider id from the saved ModelConfig (`anthropic` | `openai` |
   * `deepseek-official` | `siliconflow` | `custom` | ...).
   *
   * 当存在时优先用它来路由 client：只有 `anthropic` 走 ChatAnthropic，其余一律走
   * OpenAI-compatible（ChatOpenAI）。没传时退回旧的"看 modelId/baseUrl 里有没有
   * deepseek"启发式，保证老调用方不破。
   */
  provider?: string;
}

/**
 * 是否该走 OpenAI-compatible client（ChatOpenAI）。
 *
 * - 有显式 provider：`anthropic` → 否；其它任何值 → 是。涵盖 openai、deepseek-official、
 *   siliconflow、custom、以及用户自填的 OpenAI-compatible 网关。
 * - 没有 provider：用旧的 substring 启发式，避开把仅设 modelId="deepseek-chat" 的
 *   env 兜底场景搞坏。
 */
function shouldUseOpenAICompatible(opts: ModelOptions): boolean {
  if (opts.provider) {
    return opts.provider.toLowerCase() !== "anthropic";
  }
  const modelId = (opts.modelId ?? "").toLowerCase();
  return modelId.includes("deepseek") || (opts.baseUrl?.includes("deepseek") ?? false);
}

export function createModel(opts: ModelOptions) {
  const modelId = opts.modelId ?? "claude-3-5-sonnet-20241022";
  const temperature = opts.temperature ?? 0;
  const useOpenAI = shouldUseOpenAICompatible(opts);

  logger.debug("Creating model instance", {
    modelId,
    provider: opts.provider ?? null,
    client: useOpenAI ? "openai-compatible" : "anthropic",
    temperature,
    hasApiKey: Boolean(opts.apiKey),
    baseUrl: opts.baseUrl ?? null,
  });

  if (useOpenAI) {
    // baseURL 优先用 caller 给的；没给且 modelId 像 deepseek 才退回 deepseek 默认，
    // 否则不传 → ChatOpenAI 用 OpenAI 官方端点。这样注册的 openai/siliconflow/custom
    // provider 不会再被错误指向 api.deepseek.com。
    const fallbackBaseUrl = modelId.toLowerCase().includes("deepseek")
      ? "https://api.deepseek.com"
      : undefined;
    const baseURL = opts.baseUrl ?? fallbackBaseUrl;
    logger.log("Using OpenAI-compatible model client", { modelId, baseUrl: baseURL ?? "<openai-default>" });
    return new ChatOpenAI({
      modelName: modelId,
      apiKey: opts.apiKey,
      configuration: baseURL ? { baseURL } : undefined,
      temperature,
      streaming: true,
    });
  }

  logger.log("Using Anthropic model client", { modelId });
  return new ChatAnthropic({
    model: modelId,
    anthropicApiKey: opts.apiKey,
    temperature,
  });
}
