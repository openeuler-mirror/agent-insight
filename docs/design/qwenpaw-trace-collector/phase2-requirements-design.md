# QwenPaw Trace 采集器：Phase 2 需求设计

版本：v1.0
最后更新：2026-09-06

> 文档类型：Phase2 需求设计规格（DS）
> 关联项目：agent-insight
> 状态：基于当前 QwenPaw collector 1.0.0 刷新

## 1. 总体架构

```text
QwenPaw plugin loader
  plugin.json -> backend.py
        |
        v
qwenpaw_insight Collector
  HookBase runtime hooks + Tool Middleware + reversible patches
        |
        v
OTLP span builder -> durable spool -> background uploader
        |
        v
POST /api/ingest/otel/v1/traces
        |
        v
QwenPaw OtelTraceAdapter -> ExecutionRecord -> Agent Trace tree
```

采集端只负责把 QwenPaw 运行事实编码为 OTLP span。服务端 Adapter 负责会话聚合、用户问题提取、
子 Agent 树规范化、Token 汇总和 `ExecutionRecord` 生成。Trace UI 继续消费统一
Interaction，不增加 QwenPaw 专用渲染分支。

## 2. Python 采集器

源码目录为 `scripts/qwenpaw-collector/`。公开 Python 包名为 `agent-insight-qwenpaw`，
命令行为 `agent-insight-qwenpaw`，内部模块名为 `qwenpaw_insight`。

| 模块 | 职责 |
|-|-|
| `backend.py` | QwenPaw 插件入口，注册 startup/runtime/middleware/shutdown/uninstall hook |
| `qwenpaw_insight/cli.py` | 安装、卸载、状态查看和插件目录注册 |
| `qwenpaw_insight/config.py` | 环境变量、插件配置、默认 spool 和日志路径 |
| `qwenpaw_insight/collector.py` | session/span registry、turn 状态、父子关系和采集 API |
| `qwenpaw_insight/hooks.py` | 继承 QwenPaw `HookBase` 的根 Agent 与 cleanup hook |
| `qwenpaw_insight/middleware.py` | Tool 调用、输出、exit code 和错误采集 |
| `qwenpaw_insight/patches.py` | LLM、MCP、子 Agent、Skill、Cron 和标题生成可逆补丁 |
| `qwenpaw_insight/messages.py` | QwenPaw 消息结构和 Python repr 的角色感知用户输入提取 |
| `qwenpaw_insight/otlp.py` | OTLP HTTP/JSON payload 与 span 属性编码 |
| `qwenpaw_insight/exporter.py` | 本地 spool、后台上传、`.sent` 标记、重试和 flush |
| `qwenpaw_insight/sanitize.py` | API Key、token、password、secret 等敏感字段脱敏 |

安装后 QwenPaw plugins 目录中的插件结构为：

```text
agent-insight-qwenpaw/
├── plugin.json
├── backend.py
├── config.json
└── qwenpaw_insight/
```

## 3. 会话、Trace 和 turn

QwenPaw 会话身份只使用真实字段：

- `ctx.session_id`：当前 Agent 或子 Agent 会话 ID；
- `ctx.root_session_id`：整棵调用树的根会话 ID；
- `ctx.agent_id`：稳定 Agent ID；
- `ctx.agent_config.name`：页面展示的真实 Agent 名称。

Trace ID 由 `root_session_id + qwenpaw.turn_id` 稳定派生：

```text
traceId = stable_hex("agent-insight:qwenpaw:trace:" + root_session_id + ":" + qwenpaw.turn_id, 32)
```

同一根会话下每轮请求生成新的 `qwenpaw.turn_id`，格式为：

```text
<root_session_id>:<session_id>:turn:<turn_index>
```

根 Agent、LLM、Tool、Skill 和子 Agent 在同一轮内共享同一个 `qwenpaw.trace_key`。每轮开始时
只重置本轮 token、ReAct step、输出和结束标记，不清除对话身份、父子关系或 Agent 名称。服务端
Adapter 以 `qwenpaw.turn_id` 去重 USER；历史数据没有 turn id 时使用 USER 文本做兼容去重。

## 4. 用户问题提取

采集端和服务端共用同一口径：只读取显式 `user` 或 `human` 角色消息。优先级为：

1. `qwenpaw.user_input`；
2. 标准消息字段，如 `gen_ai.input.messages`、`input.messages`、`request.messages`；
3. 历史 `input.value` 中的 QwenPaw Python repr。

Python repr 解析只识别已知片段，例如 `role='user'`、`role="human"` 和
`TextBlock(text='...')`。解析器禁止 `eval`，只做受限字符串扫描和转义还原。system、
assistant、tool 消息不参与 query 提取。

根 Agent span 保留完整 `input.value` 作为详情，同时写入独立的 `qwenpaw.user_input`。LLM
fallback 即使没有根 Agent span，也会在 LLM span 中写入同一字段，保证服务端能插入 USER。

## 5. Span 语义

统一资源和基础属性：

- `service.name=qwenpaw`
- `agent.insight.framework=qwenpaw`
- `session.id=<root_session_id>`
- `qwenpaw.session_id`
- `qwenpaw.root_session_id`
- `qwenpaw.parent_session_id`
- `qwenpaw.agent_id`
- `qwenpaw.agent.name`
- `qwenpaw.turn_id`

| span | 关键属性 |
|-|-|
| Agent | `gen_ai.span.kind=AGENT`、`input.value`、`qwenpaw.user_input`、`output.value`、`qwenpaw.latency_ms` |
| LLM | `gen_ai.span.kind=LLM`、`llm.model_name`、`qwenpaw.provider`、`input.value`、`output.value`、Token |
| Tool | `gen_ai.span.kind=TOOL`、`tool.name`、`tool.input`、`tool.output`、`tool.status`、`tool.exit_code` |
| Skill | Tool span 上增加 `skill.name`、`skill.version`、`skill.trigger`、`skill.input/output` |
| MCP | Tool span 上增加 `mcp.server.name`、`mcp.tool.name`、`mcp.arguments/result`、`protocol=mcp` |
| Cron | `cron.job_id`、`cron.job_name`、`cron.trigger`、`cron.status` |
| Session end | `qwenpaw.session.end=true`、`qwenpaw.completed_at` |

内容字段写入前先脱敏，再按 `max_content_chars` 截断，默认 2000 字符。Token 使用 provider 返回的
`input_tokens`、`output_tokens`、`reasoning_tokens` 和 `total_tokens`，缺失 total 时按可用字段求和。

## 6. 子 Agent 建树

采集端识别以下委派入口：

- `spawn_subagent`
- batch/fork 子任务
- `chat_with_agent`
- `submit_to_agent`

当子会话 ID 生成或请求构造发生时，collector 记录：

- `qwenpaw.parent_session_id`
- `qwenpaw.root_session_id`
- `qwenpaw.delegation.kind`
- `qwenpaw.delegation.children`
- `qwenpaw.delegation.description`
- `qwenpaw.delegation.target_agent`

服务端 Adapter 将委派 Tool 规范化为 Agent Insight 的 `task` tool call：

```json
{
  "subagent_session_id": "child-session-id",
  "subagent_type": "subagent-or-agent-name",
  "description": "delegated task",
  "delegation_kind": "spawn|batch|fork|chat_with_agent|submit_to_agent"
}
```

子 Agent 的 LLM、Tool、Skill 和 MCP span 统一携带自己的 `qwenpaw.session_id` 与直接父
`qwenpaw.parent_session_id`。服务端根据直接父关系递归建树，不通过时间窗口猜测父子关系。

临时子 Agent 显示为 `<真实 Agent 名> · Subagent` 或 `<真实 Agent 名> · Fork Subagent`。调用其他
已配置 Agent 时，显示目标 Agent 的真实配置名。

## 7. 标题生成与孤立 LLM

QwenPaw 的自动标题生成会调用 LLM，但它不是用户对话的根任务。采集器通过
`chat_id -> chat.session_id` 将该 LLM 放进真实会话上下文，并写入：

- `qwenpaw.internal_operation=title_generation`
- `qwenpaw.title_generation=true`
- `qwenpaw.chat_id`

服务端 Adapter 对“只有标题生成 span”的批次返回 `null`，不创建独立 Trace。无法取得真实 session
的孤立 LLM 被采集端标记为 orphan 或直接跳过，不再按时间窗口创建 `unknown/qwenpaw-*` Trace。

## 8. 可靠传输与安全

默认本地路径：

```text
~/.agent-insight/otel_data/qwenpaw/<api-key-hash-8>/
```

上传策略：

- span 结束后编码为 OTLP delta payload 并写入本地 spool；
- 后台线程定时扫描，并在 session end、进程退出时执行有界 flush；
- HTTP 2xx 后写入 `.sent` 标记，避免重复上传；
- 网络错误、408、429、5xx 使用指数退避重试；
- 401/403 等认证问题保留数据并写日志，等待用户修复配置。

API Key 只用于请求 header 和 spool 子目录摘要，不写入事件内容、日志或文件名。采集异常必须
fail-open，不能阻断 QwenPaw 对话、工具调用或子 Agent 执行。

## 9. 服务端 Adapter

`src/lib/ingest/otel/adapters/qwenpaw.ts` 匹配：

- `serviceName === "qwenpaw"`；
- `agent.insight.framework === "qwenpaw"`；
- 或存在 `qwenpaw.session_id`。

聚合行为：

1. 按 `startTimeMs` 排序；
2. 过滤只包含内部标题生成的批次；
3. 识别根 Agent、子 Agent、LLM、Tool、Skill、MCP、Cron 和 session end；
4. 按用户输入优先级确定 query；
5. 每个 turn 显式插入一次根 USER；
6. LLM 映射为 assistant interaction；
7. 委派 Tool 映射为 `task` tool call，供 `buildAgentCallTree` 构建子 Agent 树；
8. Token 汇总以 LLM span 为准，避免 Agent 容器重复计数；
9. 对 `QwenPaw Session` 占位 query 设置 `force_query_update=true`，重聚合后可刷新真实问题。

通用 framework descriptor 为：

```text
id=qwenpaw
label=QwenPaw
platform=qwenpaw
onboard=plugin
skills=true
subagentTree=true
skillScope=session
```

## 10. 历史数据回填

回填脚本只扫描 `framework=qwenpaw` 且满足以下条件之一的记录：

- interactions 中没有根 USER；
- query 为 `QwenPaw Session`。

脚本从 Agent Insight 自己保留的 `traces.jsonl` 和 `.processed` spool 重聚合并写库，默认
dry-run，传入 `--apply` 才修改数据库。spool 已丢失、或数据中不存在真实 USER 时只报告
`missing-spool`/`skipped`，不会从 assistant 回复猜造用户问题。
