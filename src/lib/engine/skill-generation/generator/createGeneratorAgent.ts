import { createDeepAgent, LocalShellBackend } from "deepagents";
import { MemorySaver } from "@langchain/langgraph";
import { createModel, type ModelOptions } from "@/lib/engine/skill-generation/shared/model";
import { GENERATOR_SYSTEM_PROMPT } from "@/lib/engine/skill-generation/generator/prompts";
import { join } from "node:path";
import { createFilesystemTools } from "@/lib/engine/skill-generation/generator/tools/files";
import { createSkillCreatorSubAgent } from "@/lib/engine/skill-generation/generator/subagents";
import { createLogger } from "@/lib/logger";

const logger = createLogger("skill-generation:generator-agent");

export function createGeneratorAgent(opts: {
  workspaceRoot: string;
} & ModelOptions) {
  logger.log("Creating generator agent", {
    workspaceRoot: opts.workspaceRoot,
    modelId: opts.modelId ?? null,
    baseUrl: opts.baseUrl ?? null,
  });
  const model = createModel(opts);
  const skillsDir = join(process.cwd(), "skills");
  
  // Define internal skills directory for sub-agents
  const internalSkillsDir = join(process.cwd(), "src/lib/engine/skill-generation/skills");
  const fsTools = createFilesystemTools(opts.workspaceRoot);
  const skillCreator = createSkillCreatorSubAgent(internalSkillsDir, [...fsTools]);

  logger.debug("Generator agent dependencies initialized", {
    skillsDir,
    internalSkillsDir,
    fsToolCount: fsTools.length,
  });

  return createDeepAgent({
    model,
    systemPrompt: GENERATOR_SYSTEM_PROMPT,
    skills: [skillsDir],
    subagents: [skillCreator],
    tools: [...fsTools],
    checkpointer: new MemorySaver(),
    interruptOn: {
      skill_write_file: {
        allowedDecisions: ["approve", "reject"],
        description: "Writing to file system. Please approve if the content looks correct.",
      },
    },
    backend: () =>
      new LocalShellBackend({
        rootDir: opts.workspaceRoot,
        inheritEnv: true,
      }),
  });
}
