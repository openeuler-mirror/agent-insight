---
title: "Trace 落盘机制与 Hermes 文件膨胀历史分析"
description: "区分 Hermes 文件膨胀的历史原因、已实现的增量上报与分片读取，以及仍需评估的输入字段重复问题。"
keywords: ["Agent Insight", "Hermes", "Trace 存储", "OpenTelemetry", "数据膨胀"]
changefreq: monthly
---

# Trace 落盘机制与 Hermes 文件膨胀历史分析

> 历史样本来自 2026-06-16/17 的本地排查；2026-10-27 重新核对源码。历史文件大小和放大倍数不是当前版本的性能测量。

## 实现状态

| 原问题 | 当前源码状态 | 阅读方式 |
| --- | --- | --- |
| 每完成一个 span 都重发整个 root snapshot | `scripts/hermes_agent_insight_plugin.py` 的 `_complete()` 已向 `_DeltaExporter` 提交单个 span，并以 `rootId:spanId` 标识本地待发送项 | 第 2、4.2 节保留原问题和改造原因；不能继续把全量 snapshot 当作当前实现 |
| 所有会话写同一个日文件 | `src/lib/ingest/claude-otel/spool.ts` 已按日期和 session 分片；consumer/discovery 兼容发现旧日文件 | 第 4.4 节为已实现机制 |
| 整文件读入和 checkpoint 超出文件长度 | `readNewLinesSince` 使用固定缓冲分块读取，发现 cursor 超出文件大小时从 0 开始 | 不再列为尚未实施的基础改造 |
| API 请求 history 双字段保存 | `pre_api_request()` 仍把 `request_messages` 同时写入 `llm.input_messages` 和 `input.value` | 仍有重复来源；实际空间开销需要按当前裁剪、去重和消费流程重测 |

增量发送仍允许网络失败后的重试，不等于端到端恰好一次。输入 history 的收敛可能影响调试回放和输入展示，必须明确调用方并回归验证后再实施；本文只更新说明，不调整采集行为。

## 1. Trace 数据为什么要先落盘

下面用排查涉及的两类管道解释持久化缓冲的作用，不代表所有框架或新协议入口的完整清单。绝对路径为历史默认目录示例，实际位置由运行根和 spool 配置决定：

```mermaid
flowchart LR
  subgraph opencode["OpenCode 管道"]
    OC["OpenCode plugin"] --> OCS["~/.agent-insight/otel_data/opencode"]
    OCS --> OCU["opencode_uploader_client.js"]
    OCU --> UP["/api/ingest/upload"]
    UP --> DB["Execution / Session"]
  end

  subgraph otel["通用 OTel 管道"]
    CC["ClaudeCode OTel logs"] --> LOGS["/api/ingest/otel/v1/logs"]
    HM["Hermes OTel traces"] --> TRACES["/api/ingest/otel/v1/traces"]
    LOGS --> CS["~/.agent-insight/otel_data/claude/YYYY-MM-DD/sessions/<session>/logs.jsonl"]
    TRACES --> TS["~/.agent-insight/otel_data/traces/YYYY-MM-DD/sessions/<session>/traces.jsonl"]
    CS --> CONSUMER["OTelConsumer"]
    TS --> CONSUMER
    CONSUMER --> DB
  end
```

`otel_data` 不是最终展示数据，它是采集端和落库端之间的缓冲队列。真正用于页面展示的是 `Execution` / `Session` 里的归一化结果。

### 1.1 落盘的目的

落盘主要解决四个问题：

1. **快速响应 exporter**
   OTel endpoint 收到数据后只做校验、归一化、append spool，然后返回 `200 accepted`。聚合、去重、写库、评估都放到后台，避免 exporter POST 被长时间阻塞。

2. **崩溃恢复**
   如果 Next 进程在接收后、聚合前重启，已经 append 到 spool 的事件还能由 `OTelConsumer` 继续处理。否则“HTTP 已返回成功但数据还没入库”的窗口会丢数据。

3. **聚合碎片事件**
   OTel 上报的是 span/event，不是页面能直接展示的一条完整 trace。后台 consumer 需要按 `sessionId` 聚合、排序、dedupe，再生成 `ExecutionRecord`。

4. **抗重试和削峰**
   exporter 超时或网络波动会重发。spool + 后台聚合允许系统在后处理阶段去重，不把所有重活压在 HTTP 请求里。

### 1.2 能不能取消落盘

可以，但要明确牺牲什么。

| 方案 | 优点 | 代价 | 判断 |
| --- | --- | --- | --- |
| 纯内存队列 | 没有文件膨胀和文件读取问题 | 进程重启/HMR/崩溃会丢 accepted 但未入库的数据；长 debounce 不可靠 | 不建议作为主链路 |
| 请求内直接落库 | 实现直观，页面可见最快 | 大 trace 会拖慢 POST，exporter 超时重试，容易重复上报和雪崩 | 不建议回退 |
| 文件 spool | 简单、无新增依赖、可恢复 | 要处理分片、retention、checkpoint、流式读取 | 当前保留，已实现分片与分块读取 |
| DB/队列表 raw event queue | 查询、去重、清理更结构化 | 需要 schema 设计；SQLite 高频写可能锁表/膨胀 | 中长期可评估 |

结论：**保留持久化缓冲，持续检查其分片、读取和保留策略。** 历史问题来自通用 traces 共用日文件和整文件读取；这两项基础机制已经调整，不能由旧问题推断当前仍需重新改造同一部分。

## 2. Hermes 数据文件为什么异常大

2026-06-16/17 排查的旧版服务端文件：

`~/.agent-insight/otel_data/traces/2026-06-16/traces.jsonl`

在一次排查中有约 `407` 条事件、约 `89.9MB` 内容。字段体积最大的两个 attribute 是：

| 字段 | 体积 | 原因 |
| --- | ---: | --- |
| `llm.input_messages` | 约 `40.95MB` | 每个 API span 存完整 request history |
| `input.value` | 约 `40.56MB` | 同一份 request history 又被存了一份 |

这两个字段合计超过 90%。同时，`407` 条事件里只有 `54` 个唯一 `sessionId + spanId`，重复率约 `86.7%`。去重后约 `10.9MB`，实际写了约 `89.9MB`，重复上传放大约 `8.25x`。

所以 Hermes 变大的根因是三层叠加：

1. **完整 history 太大**
   `request_messages` 不是本轮用户输入，而是完整上下文：system prompt、skills、历史 user/assistant、tool result、当前输入。agent 跑得越久，这个字段越大。

2. **同一份 history 双写**
   Hermes 插件在 API span 里同时写：

   ```python
   "llm.input_messages": kwargs.get("request_messages"),
   "input.value": kwargs.get("request_messages"),
   ```

   `input.value` 被主链路视图拿来找 user 输入，但它不需要完整 history。

3. **snapshot 重复上报**
   当时 Hermes 每完成一个 span，会把 root 下所有已完成 spans 重新组成 snapshot 上传；当时服务端直接 append，老 span 因此反复进入 `traces.jsonl`。当前已采用单 span 增量提交，不能继续套用这一旧行为。

## 3. 为什么 OpenCode 没有同样的问题

以下比较针对当时的 OpenCode upload 链路，不能推广为所有版本或 OTLP 入口都没有文件膨胀风险。差异在存储形态，而不是没有 history：

1. OpenCode uploader 最后上传的是整理后的 `interactions` 事件流，而不是每个 API span 都嵌完整 LLM request history。
2. OpenCode 的历史由 user / assistant / tool call / tool result 这些 interaction 串起来，不需要在每次 LLM 调用里重复存一份完整 `messages`。
3. OpenCode uploader 有 session signature/checkpoint，已上传过的 session 版本会跳过。
4. OpenCode 有 `AGENT_INSIGHT_MAX_TOOL_IO`、`AGENT_INSIGHT_MAX_EVENT_STRING` 这类字段裁剪。
5. OpenCode 走 `/api/ingest/upload` quick save 到 `Execution`，`otel_data/opencode` 只是本地队列，不是通用 traces 日文件。

## 4. Hermes 应该怎么改

当时提出三层改造：输入字段、插件发送方式、服务端 spool。其中增量发送和服务端分片读取已落地；下面保留原因并说明状态。

### 4.1 插件端修输入字段

目标：保留链路主视图需要的信息，同时避免每个 span 内嵌完整 history。

建议：

1. `input.value` 只存本轮用户输入，或 `request_messages` 的最后一条 user message。
2. `llm.input_messages` 不在每个 `api.*` span 都存完整 history。
3. 如果 UI 需要展示 LLM input history，可以改成以下任一方式：
   - 只在 `llm.*` 容器 span 上存一份；
   - 只保留尾部 N 条消息；
   - 以 `max_input_chars` 截断；
   - 只存摘要或引用。
4. 增加元信息：
   - `llm.input_messages.message_count`
   - `llm.input_messages.original_chars`
   - `llm.input_messages.truncated`

这些是待评估的方案，不是当前配置。修改前需要核对主视图、LLM 输入回放和诊断对字段的依赖，验证 user、assistant、tool、token、latency 及调试证据保持可用后再实施。

### 4.2 插件端从 snapshot 改成 delta 上报

旧实现上传 root 的累计 snapshot；当前 `_complete()` 已改为提交单个完成的 span，等价结构如下：

```python
self.exporter.submit(f"{root_id}:{span['spanId']}", self._payload(root_id, [span]))
```

当前本地 spool 文件名由 `rootId:spanId` 的稳定哈希产生，避免不同 pending span 共用同一个 root 文件。

这减少了正常完成路径中的累计 snapshot 重发；失败重试仍可能产生重复提交，服务端仍需按其去重与更新契约处理。

### 4.3 服务端修 traces spool 组织和读取

这是和“落盘”直接相关的治理点，不能只靠 Hermes 插件端止血。

本次修复前的问题（旧日文件仍作为 legacy 兼容读取）：

`~/.agent-insight/otel_data/traces/YYYY-MM-DD/traces.jsonl`

把所有通用 OTel traces 都写进一个日文件。文件大后会出现两个问题：

1. 聚合某个 session 时需要扫描巨大文件，成本高。
2. 当时读取函数里存在整文件读取路径，大文件可能触发 Node 字符串大小限制或内存问题。

当时提出的改造项（已实现部分见第 4.4 节）：

1. **不要所有 trace 共用一个日文件**
   改成更细粒度分片，例如：

   ```text
   otel_data/traces/YYYY-MM-DD/HH/traces.jsonl
   ```

   或：

   ```text
   otel_data/traces/YYYY-MM-DD/<sessionId>.jsonl
   ```

   如果按 session 分片，聚合单个 session 最直接；如果担心文件数过多，可先按小时分片。

2. **读取必须流式化**
   `readOtelTraceEventsForSession` 和 `readNewLinesSince` 不应再整读文件到字符串。需要逐行扫描、边读边过滤 `sessionId`。

3. **checkpoint 要能处理文件重建/截断**
   如果 `cursor.bytes > 当前文件大小`，应认为文件被 truncate/recreate，自动 invalidate 或从 0 重新读，并打 warning。

4. **服务端 append 前做兜底裁剪**
   即使客户端没修，也不能让单个 attribute 无限进入 spool。服务端应对 `input.value`、`llm.input_messages`、`output.value`、`tool.output` 设硬上限。

5. **retention / compact 必须可观测**
   已处理的历史 spool 应按保留窗口归档或删除，consumer 日志里要能看到压缩/清理结果。

### 4.4 本次已落地的服务端改动

本次先落地服务端 spool 组织方式，目标是让 ClaudeCode logs 和 Hermes/通用 OTel traces 都不再堆到同一个日文件：

```text
otel_data/claude/YYYY-MM-DD/sessions/<safe-session>/logs.jsonl
otel_data/traces/YYYY-MM-DD/sessions/<safe-session>/traces.jsonl
```

兼容策略：

1. 新写入按 `sessionId` 分片，并对路径段做安全化处理，避免特殊字符或过长 sessionId 直接进入路径。
2. 文件发现改为递归查找 `logs.jsonl` / `traces.jsonl`，所以历史的 `YYYY-MM-DD/logs.jsonl` / `YYYY-MM-DD/traces.jsonl` 仍会被 consumer 读取。
3. `readOtelTraceEventsForSession`、`readClaudeOtelEventsForSession` 和 `readNewLinesSince` 改为分块读取，不再把整个 JSONL 文件一次性读成字符串。
4. 当 checkpoint 的 `bytes` 大于当前文件大小时，视为文件被删除重建或截断，下一次读取会从 0 开始，cursor 保存也允许回退到本次实际读取位置。

这一步调整了服务端共用日文件和 checkpoint 超界的处理；插件端单 span 增量发送也已实现。history 双字段保存仍存在，需结合当前版本测量其影响，不能沿用旧样本的放大倍数。

## 5. 后续评估顺序

1. **先测量当前版本并确认字段调用方**
   固定插件、服务端版本和 Trace 样例，统计原始上报、spool 与最终展示的体积和内容；核对 history 双字段对回放、诊断和页面的用途。

2. **有证据后再收敛输入字段**
   若确认冗余且可兼容，选择单份保存、裁剪或引用方案；验证完整调用链与必要调试证据后再修改。

3. **回归已有增量发送与分片读取**
   覆盖发送重试、重启恢复、历史日文件兼容、checkpoint 超界和长会话；不重复规划已实现的基础改造。

4. **最后评估是否改成 DB/raw-event queue**
   如果文件 spool 仍然难维护，再讨论引入表结构或队列。这个属于更大架构改造，不建议作为当前止血第一步。

## 6. 当前结论

`otel_data` 的存在是为了异步化、恢复和削峰，不建议简单取消。

旧样本的放大由 history 双写、累计 snapshot 重发和共用日文件共同造成。当前已实现单 span 增量发送、服务端 session 分片及分块读取；history 双字段仍需评估。后续是否调整字段或存储，应以当前版本测量和功能兼容验证为依据。
