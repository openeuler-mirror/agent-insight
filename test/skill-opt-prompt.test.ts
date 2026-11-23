/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildSkillOptSystemPrompt } from "../src/lib/engine/general-agent/skill-opt-prompt";

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


test('user scope constrains evaluator repair suggestions', () => {
  const prompt = buildSkillOptSystemPrompt({ skillName: 'fixture', baseVersion: 0, checkedIssues: [], userFeedback: '只改 SKILL.md' });
  assert.match(prompt, /无法在限定范围内修复的问题应保留/);
});
