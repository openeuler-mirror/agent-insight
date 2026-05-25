import { type SubAgent } from "deepagents";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@/lib/logger";

const logger = createLogger("skill-generation:subagents");

export function createSkillCreatorSubAgent(skillsRoot: string, tools: any[] = []): SubAgent {
  const skillCreatorPath = join(skillsRoot, "skill-creator", "SKILL.md");
  let systemPrompt = "你是一个技能创建（skill creator）Agent。除非明确要求，否则请使用中文回复。";
  let description = "创建和改进 Agent 技能。";

  logger.debug("Initializing skill-creator subagent", {
    skillsRoot,
    skillCreatorPath,
    toolCount: tools.length,
  });

  try {
    const content = readFileSync(skillCreatorPath, "utf-8");
    // Extract description from frontmatter if possible, otherwise use a default
    const match = content.match(/description:\s*(.*)/);
    if (match) {
      description = match[1].trim();
    }
    systemPrompt = content;
  } catch (error) {
    logger.error("Failed to read skill-creator SKILL.md", {
      skillCreatorPath,
      error: (error as Error).message,
    });
  }

  return {
    name: "skill-creator",
    description: description,
    systemPrompt: systemPrompt,
    tools: tools, 
  };
}
