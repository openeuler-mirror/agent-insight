import assert from "node:assert/strict";
import test from "node:test";
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSupervisorAgent } from "@/lib/engine/skill-generation/supervisor/createSupervisorAgent";
import type { SkillSpec } from "@/lib/engine/skill-generation/types";

test("skill-generation supervisor: createSupervisorAgent should return a compiled graph", (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-generation-test-'));
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
  const agent = createSupervisorAgent({ apiKey: "dummy", workspaceRoot });
  assert.ok(agent);
  assert.equal(typeof agent.invoke, "function");
});

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? "";

test(
  "skill-generation e2e: generate linux cpu diagnosis skill using deepseek",
  {
    timeout: 600_000,
    skip: process.env.RUN_SKILL_GENERATION_E2E !== '1'
      ? 'Set RUN_SKILL_GENERATION_E2E=1 to enable real model calls'
      : DEEPSEEK_API_KEY ? false : "DEEPSEEK_API_KEY not set; skipping real e2e",
  },
  async (t) => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-generation-e2e-'));
    t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
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
      workspaceRoot,
      modelId: "deepseek-chat",
      apiKey: DEEPSEEK_API_KEY,
      baseUrl: "https://api.deepseek.com",
    };

    const finalState = await generateSkill(spec, modelOptions);

    assert.ok(finalState && Array.isArray(finalState.messages));
    console.log("E2E Test Final Messages Count:", finalState.messages.length);
  },
);
