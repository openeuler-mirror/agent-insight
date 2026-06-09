import assert from "node:assert/strict";
import test from "node:test";

import { buildSkillOptSystemPrompt } from "../src/lib/engine/general-agent/skill-opt-prompt";
import {
  buildSkillOptIssueScope,
  resolveSkillOptScopeLimits,
} from "../src/lib/engine/general-agent/skill-opt-scope";

test("skill-opt prompt: includes skill name + base version in header", () => {
  const out = buildSkillOptSystemPrompt({
    skillName: "pdf-extractor",
    baseVersion: 3,
    checkedIssues: [],
    userFeedback: "",
  });
  assert.match(out, /pdf-extractor/);
  assert.match(out, /v3/);
});

test("skill-opt prompt: renders issues sorted by severity (high → medium → low)", () => {
  const out = buildSkillOptSystemPrompt({
    skillName: "demo",
    baseVersion: 1,
    checkedIssues: [
      { id: "iss_low", severity: "low", summary: "low one" },
      { id: "iss_high", severity: "high", summary: "high one" },
      { id: "iss_med", severity: "medium", summary: "med one" },
    ],
    userFeedback: "",
  });
  const idxHigh = out.indexOf("iss_high");
  const idxMed = out.indexOf("iss_med");
  const idxLow = out.indexOf("iss_low");
  assert.ok(idxHigh > -1 && idxMed > -1 && idxLow > -1, "all issue ids must appear");
  assert.ok(idxHigh < idxMed, "high must come before medium");
  assert.ok(idxMed < idxLow, "medium must come before low");
});

test("skill-opt prompt: omits feedback section when feedback is empty/whitespace", () => {
  const a = buildSkillOptSystemPrompt({
    skillName: "demo", baseVersion: 1, checkedIssues: [], userFeedback: "",
  });
  const b = buildSkillOptSystemPrompt({
    skillName: "demo", baseVersion: 1, checkedIssues: [], userFeedback: "   \n\t  ",
  });
  assert.ok(!a.includes("用户附加诉求"), "empty string should not render feedback header");
  assert.ok(!b.includes("用户附加诉求"), "whitespace-only should not render feedback header");
});

test("skill-opt prompt: includes evidence in issue rendering when provided", () => {
  const out = buildSkillOptSystemPrompt({
    skillName: "demo",
    baseVersion: 1,
    checkedIssues: [{ id: "iss_1", severity: "high", summary: "S", evidence: "trace tr_xyz" }],
    userFeedback: "",
  });
  assert.match(out, /证据：trace tr_xyz/);
});

test("skill-opt prompt: empty input shows guidance banner instead of editing", () => {
  const out = buildSkillOptSystemPrompt({
    skillName: "demo", baseVersion: 1, checkedIssues: [], userFeedback: "",
  });
  // 应该提示 agent 不要直接动文件
  assert.match(out, /既没勾选 issue 也没填诉求/);
});

test("skill-opt prompt: contains prevalence + in-place-edit guidance", () => {
  const out = buildSkillOptSystemPrompt({
    skillName: "demo", baseVersion: 1,
    checkedIssues: [{ id: "iss_1", severity: "high", summary: "S" }],
    userFeedback: "",
  });
  // prevalence 提示
  assert.match(out, /prevalence/);
  // 禁止建副本目录
  assert.match(out, /\.draft|\.new|\.bak/);
});

test("skill-opt prompt: includes 修改总结 template with stable section headers", () => {
  // 前端会按"## 修改总结"等小节标题字面量定位 agent 输出，所以这些标题不能漂移。
  const out = buildSkillOptSystemPrompt({
    skillName: "demo", baseVersion: 1,
    checkedIssues: [{ id: "iss_1", severity: "high", summary: "S" }],
    userFeedback: "",
  });
  assert.match(out, /## 修改总结/);
  assert.match(out, /### 已解决的优化点/);
  assert.match(out, /### 暂未处理/);
  assert.match(out, /### 改动要点/);
});

test("skill-opt prompt: scopes a large issue set to selected issues and lists deferred ids", () => {
  const checkedIssues = [
    { id: "iss_low", severity: "low" as const, summary: "low", occurrence: 1 },
    { id: "iss_high", severity: "high" as const, summary: "high", occurrence: 1 },
    { id: "iss_med", severity: "medium" as const, summary: "medium", occurrence: 4 },
  ];
  const optimizationScope = buildSkillOptIssueScope(checkedIssues, { maxOpportunities: 2 });
  const out = buildSkillOptSystemPrompt({
    skillName: "demo",
    baseVersion: 1,
    checkedIssues,
    userFeedback: "",
    optimizationScope,
  });

  assert.match(out, /本轮优化范围/);
  assert.match(out, /最多处理 2 个 issue，最多触达 5 个文件/);
  assert.match(out, /iss_high/);
  assert.match(out, /iss_med/);
  assert.match(out, /延后到后续轮次：`iss_low`/);
  assert.doesNotMatch(out, /### `iss_low`/);
});

test("skill-opt scope limits: env defaults and request overrides are configurable", () => {
  const env = {
    SKILL_OPT_MAX_OPPORTUNITIES: "7",
    SKILL_OPT_MAX_FILES: "4",
  };

  assert.deepEqual(resolveSkillOptScopeLimits(undefined, env), {
    maxOpportunities: 7,
    maxFiles: 4,
  });
  assert.deepEqual(resolveSkillOptScopeLimits({ maxOpportunities: 2 }, env), {
    maxOpportunities: 2,
    maxFiles: 4,
  });
  assert.deepEqual(resolveSkillOptScopeLimits({ maxFiles: "6" }, env), {
    maxOpportunities: 7,
    maxFiles: 6,
  });
});

test("skill-opt prompt: lists concrete SKILL.md edit regions when scope has skill content", () => {
  const skillContent = `---
name: demo
description: demo skill
tags: [demo]
---

# demo

## Examples

见 examples/。
`;
  const checkedIssues = [
    { id: "iss_example", severity: "high" as const, summary: "缺少示例", category: "examples" },
  ];
  const optimizationScope = buildSkillOptIssueScope(
    checkedIssues,
    { maxOpportunities: 1 },
    skillContent,
  );
  const out = buildSkillOptSystemPrompt({
    skillName: "demo",
    baseVersion: 1,
    checkedIssues,
    userFeedback: "",
    optimizationScope,
  });

  assert.match(out, /本轮允许编辑区域/);
  assert.match(out, /SKILL\.md:section:Examples/);
  assert.match(out, /只允许修改以上 frontmatter 字段或 markdown 标题段落/);
});
