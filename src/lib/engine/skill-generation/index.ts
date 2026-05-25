import { createSupervisorAgent } from "@/lib/engine/skill-generation/supervisor/createSupervisorAgent";
import type { SkillSpec } from "@/lib/engine/skill-generation/types";
import type { ModelOptions } from "@/lib/engine/skill-generation/shared/model";
import { Callback4AgentInsight } from "@/lib/engine/skill-generation/callback";
import { createLogger } from "@/lib/logger";
import { config } from "@/lib/engine/skill-generation/config";
import { langfuseSpanProcessor } from "@/lib/engine/skill-generation/instrumentation";

const logger = createLogger("skill-generation:index");

export interface GenerationOptions extends ModelOptions {
  enableEvaluation?: boolean;
  workspaceRoot?: string;
  sessionId?: string;
}

async function flushLangfuse() {
  if (config.langfuse.enabled) {
    await langfuseSpanProcessor.forceFlush();
  }
}

export async function generateSkill(spec: SkillSpec, options?: GenerationOptions) {
  logger.log("Starting non-stream skill generation", {
    skillName: spec.name,
    enableEvaluation: options?.enableEvaluation ?? false,
    workspaceRoot: options?.workspaceRoot ?? null,
  });
  const app = createSupervisorAgent(options);
  const callback = new Callback4AgentInsight(options?.sessionId);
  const langfuseHandler = callback.getLangfuseHandler();

  const initialMessage = `Please generate a skill for the following specification: ${JSON.stringify(spec)}`;

  const callbacks = langfuseHandler ? [callback, langfuseHandler] : [callback];

  const finalState = await app.invoke({
    messages: [{ role: "user", content: initialMessage }],
  }, {
    recursionLimit: 500,
    callbacks,
  });

  await flushLangfuse();

  logger.log("Completed non-stream skill generation", {
    skillName: spec.name,
    hasFinalState: Boolean(finalState),
  });

  return finalState;
}

/**
 * 流式生成 Skill，支持异步迭代输出 agent 的执行过程
 */
export async function* generateSkillStream(spec: SkillSpec, options?: GenerationOptions) {
  logger.log("Starting stream skill generation", {
    skillName: spec.name,
    enableEvaluation: options?.enableEvaluation ?? false,
    workspaceRoot: options?.workspaceRoot ?? null,
  });
  const app = createSupervisorAgent(options);
  const callback = new Callback4AgentInsight(options?.sessionId);
  const langfuseHandler = callback.getLangfuseHandler();

  const initialMessage = `Please generate a skill for the following specification: ${JSON.stringify(spec)}`;

  const callbacks = langfuseHandler ? [callback, langfuseHandler] : [callback];

  const stream = await app.stream({
    messages: [{ role: "user", content: initialMessage }],
  }, {
    streamMode: ["values", "updates", "messages"],
    callbacks,
    recursionLimit: 500,
  });

  try {
    for await (const chunk of stream) {
      logger.debug("Yielding stream chunk", {
        skillName: spec.name,
        chunkType: Array.isArray(chunk) ? "array" : typeof chunk,
      });
      yield chunk;
    }
  } finally {
    await flushLangfuse();
    logger.log("Completed stream skill generation", { skillName: spec.name });
  }
}

// Export everything for external use
export * from "./types";
export { createSupervisorAgent } from "./supervisor/createSupervisorAgent";
