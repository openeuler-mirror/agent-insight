# Insight Bridge

## 写入

- 本机 Worker（或 dry-run stub）提交 `collect-result` → `ingestCollectAndJudge` → upsert `Session.interactions`（RawInteraction[]）
- FI markers → `src/lib/fault-injection/trace-markers.ts`（贴近 RasTraceMarker）
- **激活成功后** → `src/lib/fault-injection/ras-bridge.ts` 写入 `RasAnomalyEvent`
  - `payload.source = "fault_injection"`（诚实标注：来自故障注入，不是环内 detector）
  - `anomalyKind` 由 FI fault id 映射（如 `thinking-dead-loop` → `llm_thinking_dead_loop`）
  - Dry-run / stub **不**写 RasAnomalyEvent
- Trace API 返回 interactions + markers + judge；可靠性观测读 RasAnomalyEvent

服务端**不**直接打开本机 `artifactDir`；权威交互数据以 POST body / ingest 为准。

## 观测入口

| 入口 | 路径 | 数据 |
|------|------|------|
| 故障注入 Run | `/agent-ras/fault-injection/runs/[runId]` | Session + FI markers |
| 可靠性观测 | `/agent-ras/trace` / `[taskId]` | RasAnomalyEvent（+ 可选 Execution） |

同 `sessionTaskId` 可在两侧互跳。用户归属必须一致（FI `user` = 登录观测所用账号），否则列表按 API Key / 登录用户过滤后不可见。

## 历史回填

```bash
DATABASE_URL="file:$HOME/.agent-insight/data/witty_insight.db" \
FI_RAS_BRIDGE_USER="you@example.com" \
FI_RAS_BRIDGE_RUN_IDS="ras-...,ras-..." \
npx tsx scripts/backfill-fi-ras-bridge.ts
```
