import { test } from "node:test";
import assert from "node:assert/strict";
import { extractRealUserInput } from "../src/lib/engine/evaluation/semantic-dataset-match";

test("extractRealUserInput falls back to raw input when no model is configured", async () => {
  const raw = "skill: repo-debug\nanalysis mode enabled\n请帮我分析这个仓库里的构建失败原因";
  const result = await extractRealUserInput(raw, null);

  assert.equal(result.normalized_input, raw);
  assert.equal(result.confidence, 0);
  assert.deepEqual(result.ignored_parts, []);
});

test("extractRealUserInput falls back to raw search-mode input when no model is configured", async () => {
  const raw = `[search-mode]
MAXIMIZE SEARCH EFFORT. Launch multiple background agents IN PARALLEL:
- explore agents (codebase patterns, file structures, ast-grep)
- librarian agents (remote repos, official docs, GitHub examples)
Plus direct tools: Grep, ripgrep (rg), ast-grep (sg)
NEVER stop at first result - be exhaustive.

---

查询114.11.14.15的cpu信号`;
  const result = await extractRealUserInput(raw, null);

  assert.equal(result.normalized_input, raw);
  assert.equal(result.confidence, 0);
  assert.deepEqual(result.ignored_parts, []);
});
