# LlamaIndex Trace 采集器：Phase 2 需求设计

## 1. 总体架构

```text
LlamaIndex Dispatcher
  ├─ SpanHandler：run/step/tool 等结构与父子关系
  └─ EventHandler：LLM/Retrieval/Synthesis/legacy Agent 语义富化
          ↓ bounded queue（业务线程只入队）
  OTLP encoder → immutable spool batch → uploader worker
          ↓ POST + x-witty-api-key
  /api/ingest/otel/v1/traces
          ↓ llamaindex normalizer/adapter
  ExecutionRecord + interactions → 既有 Agent Trace 树
```

## 2. Python 采集器

源码目录为 `scripts/llamaindex_extension/`，与第三方框架采集标准中的 `scripts/<framework>_extension/` 路径一致；模块名为 `agent_insight_llamaindex`。Agent Insight npm tarball 安装服务端并携带采集器源码，setup API 将运行时归档直接部署到 `~/.agent-insight/collectors/llamaindex/current/`，不使用 Python 包管理器。

| 模块 | 职责 |
|-|-|
| `config.py` | 环境变量、显式配置、默认目录、校验 |
| `serialization.py` | 安全序列化、模型/usage/node 提取、内容截断 |
| `span_handler.py` | LlamaIndex span → 内部 span draft；exit/drop 后入队 |
| `event_handler.py` | 将 start/end event 富化到所属 span |
| `otlp.py` | 内部 span → OTLP/HTTP JSON |
| `spool.py` | 原子写 immutable batch、容量约束、恢复和 ACK 删除 |
| `uploader.py` | writer/uploader 后台线程、触发策略、指数退避 |
| `instrumentation.py` | 幂等注册、flush、shutdown、context manager |
| `cli.py` | configure/status/run/uninstall --purge |

### 2.1 关联策略

- 直接使用 Dispatcher 传入的 `id_`、`parent_id`；内部为每个 LlamaIndex span 创建稳定 OTel spanId，根 span 创建 traceId。
- `active_span_id` 基于 ContextVar，async task 与 FunctionTool 的线程执行器会复制上下文；因此并发 Tool/子 Workflow 自动挂到正确父节点。
- workflow run span 是会话根；若用户调用的是无 Workflow 的独立 Retriever/LLM，则创建隐式 session 根。
- `session.id` 优先取 `instrument(session_id=...)`/环境上下文，其次取 workflow run id，最后取 traceId。
- Multi-Agent handoff 按 `current_agent_name` 切分 agent segment；agents-as-tools/nested workflow 保留真实嵌套父子关系。

### 2.2 Span 语义

统一资源属性：`service.name=llamaindex`、`agent.insight.framework=llamaindex`、采集器版本。统一 span 属性：

- `agent.insight.span.kind`: `agent|llm|tool|retriever|synthesizer|workflow|workflow_step`
- `session.id`、`agent.name`、`agent.task`、`tool.name`、`tool.arguments`、`tool.output`
- `gen_ai.request.model`、`gen_ai.provider.name`、`gen_ai.usage.input_tokens`、`gen_ai.usage.output_tokens`
- `input.value`、`output.value`、`retrieval.nodes`、`workflow.step.name`、`error.type/message`

所有内容类字段经过统一 `max_content_chars` 截断；被截断时增加 `<attribute>.truncated=true` 和原始字符数。

## 3. spool 与上传

- writer 将若干完成 span 编码为一个 OTLP JSON payload，写临时文件后 `os.replace` 为 `.ready`，保证崩溃后只看见完整批次。
- uploader 逐个读取 `.ready`，成功 HTTP 2xx 后删除；失败保留原文件。文件名包含创建时间、进程随机前缀和递增序号，多个进程不会覆盖。
- 重启即扫描历史 `.ready`，构成批次级断点续传；服务端按稳定 traceId/spanId 去重。
- 触发：batch 数量、flush interval、session end/显式 flush、进程 shutdown。
- 重试：`min(max_delay, base * 2^attempt)` 加 full jitter；401/403 进入低频重试并记录鉴权错误，其他 4xx 按配置隔离为 `.rejected`，5xx/网络错误继续重试。
- 容量：按最老优先清理已拒绝文件；未上传 `.ready` 默认不丢，超过硬上限后新事件降级丢弃并增加 drop counter。

## 4. 服务端

### 4.1 归一化

新增 `src/lib/ingest/otel/llamaindex.ts`：按 resource `service.name=llamaindex` 或 `agent.insight.framework=llamaindex` 检测，保留 `agent/llm/tool/chain/span` 类型、status、父子 ID、usage 和截断标记。`normalize.ts` 在 Langfuse 之后、通用 normalizer 之前分流。

### 4.2 聚合

新增 `otel/adapters/llamaindex.ts`：

- root agent/workflow span确定 query、final result、起止时间与模型。
- LLM span映射 assistant interaction；Tool span附着到父 LLM/Agent interaction。
- 子 Agent 映射为 `task` tool call + `role=subagent` interaction，复用 `deriveSubagentExecutions` 建树。
- Retriever/Synthesizer/Workflow step 映射为 `role=trace, trace_kind=chain`，复用 UI 已有 Chain 展示。
- Token 只累计叶子 LLM span，避免 agent/workflow 容器重复统计。

新增 framework adapter descriptor：`id=llamaindex`、`onboard=plugin`、`skills/subagentTree=true`。`data-service` 的子树允许集合加入 `llamaindex`。

### 4.3 既有模型最小扩展

扩展 `RawInteraction` 支持 `trace_kind/name/args/output/status`；`interactionToEvents` 将 `role=trace && trace_kind=chain` 转为 Chain event。不新增数据库列，原始数据继续存入 Session interactions JSON。

## 5. 安装与清理

- 安装：`/api/ingest/setup` 与 `/api/ingest/setup/auto` 下载服务端提供的运行时归档，经暂存目录校验后替换 `~/.agent-insight/collectors/llamaindex/current/`；指定 Python 只用于版本、LlamaIndex 可用性检查、解压和配置。
- 配置：CLI `configure` 写 `~/.agent-insight/llamaindex.json`（0600）；`run -- python app.py` 只为子进程注入专用 bootstrap。
- 资源：`/api/ingest/setup/llamaindex-collector` 只读返回白名单内的采集器源文件，不包含测试、缓存或 npm 外部资源。
- 卸载：安装器生成 `uninstall_llamaindex_collector.sh/.ps1`，默认删除 LlamaIndex 采集器源码、环境入口和 profile 注册并保留 Trace；`--purge`/`-Purge` 额外删除 LlamaIndex config/spool，不操作共享 `.env` 或其他采集器。

## 6. 安全与性能

- API Key 仅进入请求头和 0600 配置，日志只显示后四位；异常不得打印 header/payload。
- 默认不记录对象 repr 中的私有字段；字典键命中 password/token/secret/api_key 自动脱敏。
- Handler 捕获所有自身异常并 fail-open；业务调用不等待磁盘或网络。
- 队列、batch、单字段、单 payload 与 spool 总量均有界。
