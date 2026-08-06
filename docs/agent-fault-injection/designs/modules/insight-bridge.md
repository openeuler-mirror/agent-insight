# Insight Bridge

## 写入

- 本机 Worker 提交 `collect-result` → `ingestCollectAndJudge` → upsert `Session.interactions`（RawInteraction[]）
- FI markers → `src/lib/fault-injection/trace-markers.ts`（贴近 RasTraceMarker）
- Trace API 返回 interactions + markers + judge

**不再**把 FI 激活桥接成 `RasAnomalyEvent`。注入观测以 FI Run / `FaultInjection*` + Session 为准；可靠性观测以正常轨迹上报（`Execution`）为准。无轨迹时应排查上报链路，而不是用合成异常兜底进列表。

服务端**不**直接打开本机 `artifactDir`；权威交互数据以 POST body / ingest 为准。

## 观测入口

| 入口 | 路径 | 数据 |
|------|------|------|
| 故障注入 Run | `/agent-ras/fault-injection/runs/[runId]` | Session + FI markers |
| 可靠性观测 | `/agent-ras/trace` / `[taskId]` | Execution（+ 可选真 RAS ① 事件） |

同 `sessionTaskId` 可在两侧互跳（观测侧需已有轨迹上报）。用户归属必须一致。
