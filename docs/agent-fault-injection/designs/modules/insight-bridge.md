# Insight Bridge

## 写入

- 本机 Worker 提交 `collect-result` → `persistFiCollectIngress`（只更新 `FaultInjectionRun`）→ `finishFiJudgeFromDb`（只读 Prisma 再 Judge）
- FI markers → `src/lib/fault-injection/trace-markers.ts`（贴近 RasTraceMarker）
- Trace API / Run 页读已落库 `Session.interactions`（⓪ join）+ `FaultInjectionRun.markersJson` + 可选真 RAS（只读拉取）
- Run 页 `AgentTraceView` **分源展示**：FI 归 FI、RAS 归 RAS，禁止把 FI 事件标成 RAS；注入流程可折叠（默认收起），完整链路区可滚动

**不再**把 FI 激活桥接成 `RasAnomalyEvent`，也**不**为进可靠性列表合成 `Execution`（`ingestCollectAndJudge` 不得调用 `saveExecutionRecord`）。注入观测以 FI Run / `FaultInjection*` + Session 为准（③ Judge / Run 页）；可靠性列表与 `/agent-ras/trace` 主树只索引平台真实上报的根 `Execution`（OpenCode：Insight 插件 + uploader → `/api/ingest/upload`；其它平台：OTLP 等）。无行时排查 **Insight 采集器**，不要用 FI collect 兜底造行。

**原则**：`agent_ras` / `agent_fault_injection` 仓包不负责 Trace 观测，只报自身事件；完整链路一律由 agent-insight 接入。新平台同此边界。

服务端**不**直接打开本机 Worker 产物目录。`collect-result` POST body **仅作 Run 字段写入入口**（markers / 激活 / `sessionTaskId`）；**不**写/覆盖 `Session.interactions`。**FI Run / Judge / rejudge 一律只读 Prisma**（`Session`⓪ + `FaultInjectionRun`），不以上传 body 作为评判/展示真源。

## 观测入口

| 入口 | 路径 | 数据 |
|------|------|------|
| 故障注入 Run | `/agent-ras/fault-injection/runs/[runId]` | Session + **FI markers** + 并列真 **RAS markers**（分源；前端展示不变） |
| 可靠性观测 | `/agent-ras/trace` / `[taskId]` | 根 Execution（**Insight 平台采集器**上报）+ **真 RAS ①** 事件叠点（前端展示不变） |

同 **Trace ID**（平台原生 session）可在两侧互跳以查看各自事件；**不**表示 FI 归属 RAS。用户归属必须一致。不要用独立 session 文件当对外关联键。
