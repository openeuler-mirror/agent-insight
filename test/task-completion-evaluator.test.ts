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

test("parseLooseJson prefers a later json fence over an earlier plain code fence", () => {
  const parsed = parseLooseJson(`
Now I can verify the parent-child relationships from the y-coordinates:

\`\`\`
mysqld\`make_join_statistics (733ms, 75.47%)
│   ├─ test_quick_select (255ms, 26.25%)
│   └─ row_search_for_mysql (478ms, 49.21%)
\`\`\`

Given all this analysis, here's my evaluation:

\`\`\`json
{
  "score": 0.65,
  "is_correct": true,
  "reason": "基本完成火焰图分析，但核心结论表达存在偏差。",
  "key_point_findings": [
    {
      "content": "I/O 热点集中在 make_join_statistics",
      "covered": true,
      "coverage_status": "covered",
      "severity": "low",
      "explanation": "识别了热点位置"
    }
  ]
}
\`\`\`
`);

  assert.equal(parsed?.score, 0.65);
  assert.equal(parsed?.is_correct, true);
  assert.equal(Array.isArray(parsed?.key_point_findings), true);
});
