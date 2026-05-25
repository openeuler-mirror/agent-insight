import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLooseJson } from "../src/lib/engine/evaluation/task-completion-json";

test("parseLooseJson repairs unescaped quotes inside JSON string values", () => {
  const parsed = parseLooseJson(`\`\`\`json
{
  "score": 0.98,
  "is_correct": true,
  "reason": "故障链路略有表述差异（"XFS数据块读取失败"vs"XFS force shutdown"），但核心传导路径一致",
  "key_point_findings": [
    {
      "content": "故障对象确认为磁盘/dev/sdx",
      "covered": true,
      "severity": "low",
      "explanation": "实际输出明确提及"
    }
  ]
}
\`\`\``);

  assert.equal(parsed?.score, 0.98);
  assert.equal(parsed?.is_correct, true);
  assert.equal(parsed?._json_repaired, true);
  assert.match(String(parsed?.reason), /XFS force shutdown/);
  assert.equal(Array.isArray(parsed?.key_point_findings), true);
});
