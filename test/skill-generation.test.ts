import assert from "node:assert/strict";
import test from "node:test";
import { createSupervisorAgent } from "@/lib/engine/skill-generation/supervisor/createSupervisorAgent";
import type { SkillSpec } from "@/lib/engine/skill-generation/types";

test("skill-generation supervisor: createSupervisorAgent should return a compiled graph", () => {
  const agent = createSupervisorAgent({ apiKey: "dummy" });
  assert.ok(agent);
  assert.equal(typeof agent.invoke, "function");
});

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? "";

test(
  "skill-generation e2e: generate linux cpu diagnosis skill using deepseek",
  {
    timeout: 600_000,
    skip: DEEPSEEK_API_KEY ? false : "DEEPSEEK_API_KEY not set; skipping real e2e",
  },
  async () => {
    const { generateSkill } = await import("@/lib/engine/skill-generation/index");

    const spec: SkillSpec = {
      name: "linux-cpu-diagnosis",
      intent: "帮我升成一个诊断linux CPU故障的skills",
      triggerScenarios: ["CPU usage is high", "System is lagging", "CPU load average is high"],
      expectedOutput: "A set of scripts and a SKILL.md to diagnose CPU issues",
      testCases: [
        {
          prompt: "How to check which process is consuming most CPU?",
          expectations: ["Suggests using top or ps", "Explains how to interpret the output"],
        },
      ],
    };

    const modelOptions = {
      modelId: "deepseek-chat",
      apiKey: DEEPSEEK_API_KEY,
      baseUrl: "https://api.deepseek.com",
    };

    const finalState = await generateSkill(spec, modelOptions);

    assert.ok(finalState && Array.isArray(finalState.messages));
    console.log("E2E Test Final Messages Count:", finalState.messages.length);
  },
);

