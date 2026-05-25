import { runTrial } from "@/lib/engine/skill-generation/evaluator/trial/spawnTrialAgent";
import type { SkillSpec } from "@/lib/engine/skill-generation/types";
import { createModel, type ModelOptions } from "@/lib/engine/skill-generation/shared/model";
import { join } from "node:path";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createLogger } from "@/lib/logger";

const logger = createLogger("skill-generation:e2e-eval");

export async function runE2EEval(skillPath: string, spec: SkillSpec, iteration: number, modelOptions: ModelOptions) {
  logger.log("Starting e2e evaluation", {
    skillPath,
    skillName: spec.name,
    iteration,
    testCaseCount: spec.testCases.length,
  });
  const perEval: any[] = [];
  let passedCount = 0;

  for (let i = 0; i < spec.testCases.length; i++) {
    const tc = spec.testCases[i];
    const sandboxDir = join(skillPath, "evals", `iteration-${iteration}`, `test-${i}`);
    logger.debug("Running e2e test case", {
      testIndex: i,
      prompt: tc.prompt,
      expectationCount: tc.expectations.length,
      sandboxDir,
    });

    const result = await runTrial({
      skillPath,
      evalPrompt: tc.prompt,
      sandboxDir,
      modelId: modelOptions.modelId || "claude-3-5-sonnet-20241022",
      apiKey: modelOptions.apiKey,
      baseUrl: modelOptions.baseUrl,
    });

    // Use LLM to grade the output based on expectations
    const graderModel = createModel(modelOptions);
    const expectationsList = tc.expectations.map(e => `- ${e}`).join("\n");
    const gradingPrompt = `
用户提示词: ${tc.prompt}
Agent 输出: ${JSON.stringify(result.transcript.messages[result.transcript.messages.length - 1].content)}
预期目标:
${expectationsList}

针对每个预期目标，判断其是否达成。
返回一个 JSON 对象数组：{ "text": string, "passed": boolean, "evidence": string }。
语言要求：请使用中文编写证据（evidence）文本。
`;

    const gradingResponse = await graderModel.invoke([
      new SystemMessage("你是一名资深的评分专家。除非明确要求，否则请使用中文回复。"),
      new HumanMessage(gradingPrompt)
    ]);

    let expectations: any[] = [];
    try {
      // Extract JSON from response
      const jsonStr = (gradingResponse.content as string).match(/\[[\s\S]*\]/)?.[0] || "[]";
      expectations = JSON.parse(jsonStr);
    } catch (e) {
      logger.warn("Failed to parse grading response", {
        testIndex: i,
        error: (e as Error).message,
      });
      expectations = tc.expectations.map(text => ({ text, passed: false, evidence: "Failed to parse grader response" }));
    }

    const allPassed = expectations.every(e => e.passed);
    if (allPassed) passedCount++;
    logger.log("Completed e2e test case", {
      testIndex: i,
      passed: allPassed,
      durationMs: result.durationMs,
    });

    perEval.push({
      evalId: i,
      prompt: tc.prompt,
      passed: allPassed,
      expectations,
      durationMs: result.durationMs,
      tokens: 0, // Not easily available from current invoke result without more complex parsing
    });
  }

  const summary = {
    passRate: spec.testCases.length > 0 ? passedCount / spec.testCases.length : 1,
    perEval,
  };
  logger.log("Completed e2e evaluation", {
    skillPath,
    skillName: spec.name,
    iteration,
    passRate: summary.passRate,
    passedCount,
  });
  return summary;
}
