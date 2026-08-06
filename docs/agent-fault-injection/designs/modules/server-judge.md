# 服务端 Judge

- 实现：`src/lib/fault-injection/judge.ts` · prompt：`src/prompts/fault-injection-judge.ts`
- 模型：用户 `getActiveConfig`
- 输入：`summarizeTrace(interactions)` + fault 元数据（**不再**接收 `injectionEvidence`）
- 评判主依据：**轨迹 / 终答 / 终态 workspace**
- 输出：`outcome` × `faultContainmentStatus`
  - `outcome`: `occurred` | `not_occurred`
  - `faultContainmentStatus`: `unresolved` | `recovered` | `prevented` | `inconclusive`
  - 合法组合：`occurred×unresolved|recovered`，`not_occurred×prevented|inconclusive`
  - 历史值 `no_trace` 读路径映射为 `inconclusive`（「证据不足」，不是「无轨迹」）
- 时机：采集成功后；支持 `rejudge`；未配模型 → `judge_skipped`
- 本机 Python Judge（`OpenCodeFaultJudge` / CLI `--judge*`）**已删除**；评判只走 Insight
