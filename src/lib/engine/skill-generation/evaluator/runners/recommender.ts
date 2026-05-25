import { createModel, type ModelOptions } from "@/lib/engine/skill-generation/shared/model";
import type { SkillSpec } from "@/lib/engine/skill-generation/types";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createLogger } from "@/lib/logger";

const logger = createLogger("skill-generation:recommender");

export async function generateRecommendations(args: {
  structure: any;
  trigger: any;
  e2e: any;
  spec: SkillSpec;
  modelOptions: ModelOptions;
}) {
  logger.log("Generating recommendations", {
    skillName: args.spec.name,
    structureIssues: Array.isArray(args.structure?.issues) ? args.structure.issues.length : 0,
    triggerPassRate: args.trigger?.passRate ?? null,
    e2ePassRate: args.e2e?.passRate ?? null,
  });
  const model = createModel(args.modelOptions);
  
  const prompt = `
技能规范 (Skill Spec): ${JSON.stringify(args.spec)}
评估结果:
- 结构问题: ${JSON.stringify(args.structure.issues)}
- 触发通过率: ${args.trigger.passRate}
- 触发失败的查询: ${JSON.stringify(args.trigger.failedQueries)}
- 端到端 (E2E) 通过率: ${args.e2e.passRate}
- 端到端 (E2E) 详情: ${JSON.stringify(args.e2e.perEval)}

根据这些结果，提供改进技能的具体建议。
返回一个 JSON 对象数组：{ "priority": "high" | "medium" | "low", "target": "frontmatter" | "body" | "scripts" | "references" | "evals", "suggestion": string }。
语言要求：请使用中文编写建议（suggestion）文本。
`;

  const response = await model.invoke([
    new SystemMessage("你是一名技能优化专家。除非明确要求，否则请使用中文回复。"),
    new HumanMessage(prompt)
  ]);

  try {
    const jsonStr = (response.content as string).match(/\[[\s\S]*\]/)?.[0] || "[]";
    const parsed = JSON.parse(jsonStr);
    logger.log("Generated recommendations successfully", {
      recommendationCount: Array.isArray(parsed) ? parsed.length : 0,
    });
    return parsed;
  } catch (e) {
    logger.warn("Failed to parse recommendations JSON, using fallback", {
      error: (e as Error).message,
    });
    return [{ priority: 'medium', target: 'body', suggestion: 'Improve overall quality based on failed tests.' }];
  }
}
