# QwenPaw Trace 采集器：Phase 1 需求分析

版本：v1.0
最后更新：2026-09-06

> 文档类型：Phase1 需求分析规格（IR）
> 关联项目：agent-insight
> 状态：基于当前 QwenPaw collector 1.0.0 刷新

## 1. 目标

为 QwenPaw 增加 Agent Insight Trace 采集能力，在不修改 QwenPaw 源码的前提下，通过
QwenPaw 插件、Hook、Middleware 和运行时补丁采集真实对话链路，并统一转换为
`ExecutionRecord`。

核心目标包括：

- 同一 QwenPaw 对话每次提问都会生成独立 Agent Insight Trace；
- 详情页仍按 `AGENT -> TASK -> AGENT` 树展示子 Agent 关系，列表层只按问题粒度拆分 Trace；
- `AGENT` 列展示 QwenPaw Agent 配置中的真实名称，例如 `Default`；
- 用户问题从真实输入消息中提取，不能把 system prompt、assistant 历史或完整 LLM payload
  误当成用户问题；
- 子 Agent、嵌套子 Agent 和跨 Agent 委派在详情页按 `AGENT -> TASK -> AGENT` 树展示；
- 数据先写入本地 durable spool，再通过 OTLP HTTP/JSON 上传到 Agent Insight。

## 2. 功能需求

| 编号 | 能力 | 验收口径 |
|-|-|-|
| FR-001 | 插件安装 | 安装指导页选择 `QwenPaw` 后，脚本下载 collector zip、安装 Python 包并注册 QwenPaw 插件 |
| FR-002 | 对话身份 | 使用 QwenPaw `ctx.session_id` 和 `ctx.root_session_id` 作为会话与根会话事实源 |
| FR-003 | 多轮对话 | 同一 `root_session_id` 的每轮输入进入独立 Trace，每轮只插入一次 USER |
| FR-004 | 真实 Agent 名 | 优先读取 `ctx.agent_config.name`，保留 `qwenpaw.agent_id` 作为稳定 ID |
| FR-005 | 用户问题 | 支持 QwenPaw Message、TextBlock、dict/list 和历史 Python repr，只读取 `user/human` 消息 |
| FR-006 | LLM | 记录 model、provider、输入、输出、Token、耗时、错误和 ReAct step |
| FR-007 | Tool/Skill/MCP | 记录名称、参数、结果、状态、耗时、exit code、Skill version 和 MCP server/tool |
| FR-008 | 子 Agent 树 | 将 `spawn_subagent`、batch/fork、`chat_with_agent`、`submit_to_agent` 规范化为 `task` 调用 |
| FR-009 | 标题生成 | 自动标题 LLM 归入真实对话上下文，但不能单独创建独立 Trace |
| FR-010 | 可靠上传 | 本地 spool 按 API Key 隔离，支持后台上传、重试、进程退出 flush 和重复上传去重 |
| FR-011 | 历史修复 | 只对 spool 中可恢复真实 USER 的记录做幂等回填，无法恢复时不猜造问题 |

## 3. 事实与约束

- QwenPaw 插件通过 `plugin.json` 和 `backend.py` 加载，运行时 Hook 必须继承 QwenPaw
  `HookBase`，否则真实 `HookRegistry` 会拒绝注册。
- QwenPaw 上游源码不在 Agent Insight 修改范围内，所有采集能力必须通过插件、Hook、
  Middleware 或可逆 monkey patch 完成。
- QwenPaw LLM 输入中可能包含 Python 对象字符串，例如 `Message(role='user',
  content=[TextBlock(text='...')])`，不能用 `eval` 解析。
- 部分 LLM span 可能在根 Agent Hook 缺失或旧版数据中独立出现。新版采集器需要在 LLM span
  写入 `qwenpaw.user_input`，服务端 Adapter 也需要支持历史 `input.value` 解析。
- 内部 Python 模块不能命名为 `qwenpaw`，否则会与真实 QwenPaw 包发生导入冲突。Agent Insight
  collector 的内部模块名固定为 `qwenpaw_insight`，公开平台名仍为 `qwenpaw` / `QwenPaw`。
- 不新增数据库 schema，不改变外部 HTTP API，复用现有 OTLP ingest、Execution 存储和 Trace
  树组件。

## 4. 非目标

- 不修改 QwenPaw 源码，不要求用户改业务代码。
- 不从 LLM 回复、标题或 system prompt 猜测用户问题。
- 不用 30 秒时间窗口把多个 QwenPaw 对话合并为 Trace。
- 不把子 Agent 当成 Trace 列表里的额外根任务展示，默认列表只展示根对话。
- 不处理没有真实 session、Agent 或父子字段的旧 `unknown` 数据合并。
- 不新增一套专用 UI，继续使用现有 `AGENT/TASK/LLM/TOOL` 树组件。

## 5. 风险

- QwenPaw 内部模块路径可能随版本变化：所有 monkey patch 都必须可选、可逆、fail-open。
- 标题生成、后台任务和普通对话都可能调用 LLM：需要明确 `qwenpaw.internal_operation`，防止内部
  LLM 生成独立 Trace。
- 子 Agent 委派返回值格式可能不稳定：优先使用显式 `qwenpaw.delegation.children`，文本中的
  session 标记仅作为补充。
- 历史数据缺少根 session 或 Agent 名称时无法可靠回填：只能报告，不做启发式合并。
- 多账号或多服务端切换时可能混用本地缓存：spool 必须按 API Key 摘要隔离。

## 6. 验收范围

验收覆盖 Python collector、服务端 Adapter、安装脚本、setup 路由、存储刷新和 UI 数据契约：

- Hook 能被真实 `HookRegistry` 接受；
- 两轮消息使用同一 session 时会生成两条 Trace、两个 turn、两个 USER；
- 新建第二个 QwenPaw 对话会再新增对应 Trace；
- `agentName=Default`，同时保留 `agent_id=default`；
- 无 Agent span 的历史 LLM 数据能从 Python repr 输入中提取真实 USER；
- system、assistant、tool 历史消息不会被误判为用户问题；
- 单子 Agent、batch、fork、跨 Agent、三层嵌套和后台延迟完成都能建树；
- 安装包、安装脚本、文档和 UI 中只出现 `qwenpaw` / `QwenPaw` 命名。
