# Insight Bridge

## 写入

- 本机 Worker 提交 `collect-result` → `ingestCollectAndJudge` → upsert `Session.interactions`（RawInteraction[]）
- FI markers → `src/lib/fault-injection/trace-markers.ts`（贴近 RasTraceMarker）
- Trace API 返回 interactions + FI markers（`source=fi`）+ 可选真 RAS markers（`source=ras`，只读拉取）
- Run 页 `AgentTraceView` **分源展示**：FI 归 FI、RAS 归 RAS，禁止把 FI 事件标成 RAS；注入流程可折叠（默认收起），完整链路区可滚动

**不再**把 FI 激活桥接成 `RasAnomalyEvent`，也**不**为进可靠性列表合成 `Execution`。注入观测以 FI Run / `FaultInjection*` + Session 为准；可靠性列表只索引平台真实上报的根 `Execution`（OTel / upload）。无行时排查客户端上报链路，不要用 FI collect 兜底造行。

服务端**不**直接打开本机 Worker 产物目录；权威交互数据以 POST body / ingest 为准。

## 观测入口

| 入口 | 路径 | 数据 |
|------|------|------|
| 故障注入 Run | `/agent-ras/fault-injection/runs/[runId]` | Session + FI markers；可并列真 RAS（独立来源） |
| 可靠性观测 | `/agent-ras/trace` / `[taskId]` | 根 Execution（平台上报）+ 可选真 RAS ① 事件 |

同 **Trace ID**（平台原生 session）可在两侧互跳以查看各自事件；**不**表示 FI 归属 RAS。用户归属必须一致。不要用独立 session 文件当对外关联键。
