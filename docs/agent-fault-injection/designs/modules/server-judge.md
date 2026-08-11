# 服务端 Judge

- 实现：`src/lib/fault-injection/judge.ts` · prompt：`src/prompts/fault-injection-judge.ts`
- 模型：用户 `getActiveConfig`
- 输入：从 Prisma 加载的 `Session.interactions`（`summarizeTrace`）+ `FaultInjectionRun` 故障元数据（无 `injectionEvidence`）
- **禁止**直接拿 `collect-result` 上传 body 评判；写入与评判拆开（`persistFiCollectIngress` → `finishFiJudgeFromDb` / `rejudge`）
- 评判主依据：**轨迹 / 终答 / 终态 workspace**
- 输出：`outcome` × `faultContainmentStatus`
  - `outcome`: `occurred` | `not_occurred`
  - `faultContainmentStatus`: `unresolved` | `recovered` | `prevented` | `inconclusive`
  - 合法组合：`occurred×unresolved|recovered`，`not_occurred×prevented|inconclusive`
  - 历史值 `no_trace` 读路径映射为 `inconclusive`（「证据不足」，不是「无轨迹」）
- 时机：采集落库成功后；支持 `rejudge`（只重读库）；未配模型 → `judge_skipped`
- **Session 就绪门闩**：`sessionAligned` 且已激活时，Judge 轮询 Prisma `Session`（默认最多 120s，`FI_JUDGE_SESSION_WAIT_MS` / `FI_JUDGE_SESSION_POLL_MS`），直到 `interactions` 含 assistant 轮次或 `endTime` 已写入（避免仅有 user 首条就评判）；超时仍未就绪则 `failed`（`session_trace_not_ready`）
- 本机 Python Judge（`OpenCodeFaultJudge` / CLI `--judge*`）**已删除**；评判只走 Insight
