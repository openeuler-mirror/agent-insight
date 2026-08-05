# 服务端 Judge

- 实现：`src/lib/fault-injection/judge.ts` · prompt：`src/prompts/fault-injection-judge.ts`
- 模型：用户 `getActiveConfig`
- 输入：`summarizeTrace(interactions)` + 可选 `injectionEvidence` + fault 元数据
- 评判主依据：**轨迹 / 终答 / 终态 workspace**；`injectionEvidence` 有遗留快照或 `fault.injection.applied` 事件时可选出现，缺省不当作必要条件
- 输出：`outcome` × `faultContainmentStatus`
  - `outcome`: `occurred` | `not_occurred`
  - `faultContainmentStatus`: `unresolved` | `recovered` | `prevented` | `inconclusive`
  - 合法组合：`occurred×unresolved|recovered`，`not_occurred×prevented|inconclusive`
  - 历史值 `no_trace` 读路径映射为 `inconclusive`（「证据不足」，不是「无轨迹」）
- 时机：采集成功后；支持 `rejudge`；未配模型 → `judge_skipped`
