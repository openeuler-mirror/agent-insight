import { createDeepAgent, LocalShellBackend } from "deepagents";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createModel } from "@/lib/engine/skill-generation/shared/model";
import { createLogger } from "@/lib/logger";

const logger = createLogger("skill-generation:trial");

/**
 * 为单个 eval prompt 启动一个隔离的 trial agent，
 * 它在系统提示里加载被测 SKILL.md 全文。
 */
export async function runTrial(args: {
  skillPath: string;
  evalPrompt: string;
  sandboxDir: string;
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
}) {
  logger.log("Starting eval trial", {
    skillPath: args.skillPath,
    sandboxDir: args.sandboxDir,
    modelId: args.modelId,
    timeoutMs: args.timeoutMs ?? 90_000,
  });
  const skillMdPath = join(args.skillPath, "SKILL.md");
  let skillBody = "";
  if (existsSync(skillMdPath)) {
    skillBody = readFileSync(skillMdPath, "utf-8");
  } else {
    logger.warn("SKILL.md not found for trial, using fallback text", { skillMdPath });
    skillBody = "# Skill missing\n\nThe SKILL.md file was not generated yet.";
  }

  const model = createModel({
    modelId: args.modelId,
    apiKey: args.apiKey,
    baseUrl: args.baseUrl,
  });

  const trialAgent = createDeepAgent({
    model,
    systemPrompt: [
      "你是一个得力的助手。",
      "以下技能已加载，当相关时你应该参考它：",
      "---",
      skillBody,
      "---",
      "输出格式：",
      "- 如果你的输出包含代码或 JSON 数据，必须使用 Markdown 代码块（例如 ```json\n...\n``` 或 ```python\n...\n```）进行格式化，以便前端显示。",
      "语言要求：",
      "- 除非用户明确要求使用其他语言，否则对于所有面向用户的自然语言文本，请使用中文回复。",
    ].join("\n"),
    backend: () => new LocalShellBackend({ rootDir: args.sandboxDir }),
  });

  const startedAt = Date.now();
  const result = await Promise.race([
    trialAgent.invoke({
      messages: [{ role: "user", content: args.evalPrompt }],
    }, { recursionLimit: 50 }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("trial-timeout")), args.timeoutMs ?? 90_000)
    ),
  ]);

  const output = {
    transcript: result,
    durationMs: Date.now() - startedAt,
  };
  logger.log("Completed eval trial", {
    skillPath: args.skillPath,
    sandboxDir: args.sandboxDir,
    durationMs: output.durationMs,
  });
  return output;
}
