import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { runStructureLint } from "@/lib/engine/skill-generation/evaluator/runners/structureLinter";
import { runTriggerEval } from "@/lib/engine/skill-generation/evaluator/runners/triggerEval";
import { runE2EEval } from "@/lib/engine/skill-generation/evaluator/runners/e2eRunner";
import { generateRecommendations } from "@/lib/engine/skill-generation/evaluator/runners/recommender";
import type { SkillSpec } from "@/lib/engine/skill-generation/types";
import type { ModelOptions } from "@/lib/engine/skill-generation/shared/model";
import { createLogger } from "@/lib/logger";

const logger = createLogger("skill-generation:evaluator-tools");

export function createGenericEvaluatorTools(modelOptions: ModelOptions) {
  const structure_lint = tool(
    async ({ skillPath }: { skillPath: string }) => {
      logger.log("Running structure_lint", { skillPath });
      return await runStructureLint(skillPath);
    },
    {
      name: "structure_lint",
      description: "Check the skill directory structure and required files.",
      schema: z.object({
        skillPath: z.string().describe("The absolute path to the skill directory."),
      }),
    }
  );

  const trigger_eval = tool(
    async ({ skillPath, spec }: { skillPath: string; spec: SkillSpec }) => {
      logger.log("Running trigger_eval", {
        skillPath,
        skillName: spec.name,
        triggerScenarios: spec.triggerScenarios.length,
      });
      return await runTriggerEval(skillPath, spec, modelOptions);
    },
    {
      name: "trigger_eval",
      description: "Evaluate the skill triggering accuracy using generated queries.",
      schema: z.object({
        skillPath: z.string().describe("The absolute path to the skill directory."),
        spec: z.any().describe("The SkillSpec object."),
      }),
    }
  );

  const e2e_eval = tool(
    async ({ skillPath, spec, iteration }: { skillPath: string; spec: SkillSpec; iteration: number }) => {
      logger.log("Running e2e_eval", {
        skillPath,
        skillName: spec.name,
        iteration,
        testCaseCount: spec.testCases.length,
      });
      return await runE2EEval(skillPath, spec, iteration, modelOptions);
    },
    {
      name: "e2e_eval",
      description: "Run end-to-end test cases to verify skill functionality.",
      schema: z.object({
        skillPath: z.string().describe("The absolute path to the skill directory."),
        spec: z.any().describe("The SkillSpec object."),
        iteration: z.number().describe("The current iteration number."),
      }),
    }
  );

  const generate_recommendations = tool(
    async ({ structure, trigger, e2e, spec }: { structure: any; trigger: any; e2e: any; spec: SkillSpec }) => {
      logger.log("Running generate_recommendations", {
        skillName: spec.name,
        structureIssueCount: Array.isArray(structure?.issues) ? structure.issues.length : 0,
        triggerPassRate: trigger?.passRate ?? null,
        e2ePassRate: e2e?.passRate ?? null,
      });
      return await generateRecommendations({
        structure,
        trigger,
        e2e,
        spec,
        modelOptions,
      });
    },
    {
      name: "generate_recommendations",
      description: "Generate improvement recommendations based on evaluation results.",
      schema: z.object({
        structure: z.any(),
        trigger: z.any(),
        e2e: z.any(),
        spec: z.any().describe("The SkillSpec object."),
      }),
    }
  );

  return [structure_lint, trigger_eval, e2e_eval, generate_recommendations];
}
