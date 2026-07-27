# Pi Agent Trace 采集器：需求分析

## 1. 背景

本需求对应
[`openeuler/opensource-intern#158`](https://atomgit.com/openeuler/opensource-intern/issues/158)，
目标是在 openEuler 24.03 LTS SP4 上为 Pi Agent 提供可安装、可卸载、低开销且具备离线恢复能力的
Trace 采集器，并由 Agent Insight 服务端统一转换为 `ExecutionRecord`。

需求正文把 Pi 描述为内建 SubAgent 与 MCP 的 Agent。以
`@earendil-works/pi-coding-agent@0.82.1` 为基线核对后，实际接口边界如下：

- Pi Extension API 原生提供 session、agent、turn、message、tool、model 和 provider 事件。
- Pi 的官方 SubAgent 示例通过 `subagent` Tool 启动独立 `pi` 子进程，不存在原生
  `subagent_start` / `subagent_stop` Extension 事件。
- Pi 核心不内建 MCP。MCP 扩展最终仍表现为自定义 Tool，采集器只能依据稳定 Tool 命名或显式
  metadata 识别 `serverName`。
- 显式 Skill 调用可在 `input` 事件中识别 `/skill:<name>`；模型自动调用 Skill 时，稳定信号是
  `read` Tool 读取已加载 Skill 的 `SKILL.md`。

因此实现必须基于真实公开接口，不能伪造不存在的 Pi 事件。

## 2. 目标

1. 通过 Pi package 机制安装并自动加载采集扩展，同时提供等价的手工安装方式。
2. 采集 Agent、SubAgent、Skill、Tool、LLM 和 MCP 六类语义事件。
3. 在客户端先写本地 JSONL spool，再异步转换为 OTLP HTTP/JSON 上传。
4. 使用 API Key 的 SHA-256 前缀隔离 spool、checkpoint 和锁文件。
5. 网络失败、进程退出或服务端错误时不丢已落盘事件，并在恢复后避免重复上传。
6. 服务端通过专用 Pi Adapter 生成统一 `ExecutionRecord`，保持父子 Agent 与 Skill/Tool 归属。
7. 提供可复现的单元、集成、故障注入、安装/卸载、性能和长稳测试。

## 3. 非目标

- 不修改 Pi Agent 上游源码。
- 不把时间窗口猜测当作 SubAgent 父子关联依据。
- 不读取或上传模型供应商 API Key、Authorization header、Cookie 等凭据。
- 不为本需求修改 Prisma schema 或新增可视化页面。
- 不承诺识别未遵循本设计 MCP metadata 约定的任意第三方 Pi 扩展。
- 不在卸载时删除其他 Agent 框架的配置或 spool。

## 4. 角色与主要场景

### 4.1 Pi 用户

- 一键安装采集器，启动 Pi 后无需额外命令即可采集。
- 离线工作时正常使用 Pi，网络恢复后自动补传。
- 可完全卸载采集器，也可选择保留历史 spool。

### 4.2 Agent Insight 管理员

- 为不同账号生成不同 API Key，并确认本地数据目录相互隔离。
- 在服务端看到 Pi 会话、模型、Token、工具、Skill 和子 Agent 结构。
- 能通过稳定事件 ID 判断重传没有产生重复 interaction。

### 4.3 采集器维护者

- 使用固定 fixture 验证三层 SubAgent、五并发 SubAgent、显式/自动 Skill 和 MCP 成败路径。
- 在 openEuler 上采集启动、TTFT、RSS 和 8 小时 soak 证据。

## 5. 功能需求

### 5.1 安装与配置

- FR-001：Pi 基线为 `@earendil-works/pi-coding-agent@0.82.1`，兼容范围为
  `>=0.82.1 <0.83.0`；超出范围时提示而不静默运行。
- FR-002：一键安装将扩展、共享传输模块和配置写入
  `~/.agent-insight/collectors/pi-agent/`，再执行 `pi install <local-package>`。
- FR-003：手工安装只需准备同一 package 目录、设置 endpoint/API Key 并执行 `pi install`。
- FR-004：卸载只移除 Agent Insight 对应 package 登记和本采集器配置。

### 5.2 Agent 与 LLM

- FR-005：以 `ctx.sessionManager.getSessionId()` 为会话主键。
- FR-006：`before_agent_start` 记录 query、模型、provider 和已加载 Skill 清单。
- FR-007：每个 assistant `message_end` 记录一次 LLM span，usage 取 Pi 原生
  `input`、`output`、`cacheRead`、`cacheWrite`、`reasoning` 和 `totalTokens`。
- FR-008：`agent_end` / `agent_settled` 记录最终输出和汇总；`session_shutdown` 触发 flush。

### 5.3 SubAgent

- FR-009：识别官方示例 `subagent` Tool 的 `details.results`，以
  `parentSessionId + toolCallId + resultIndex/step` 生成确定性子会话 ID。
- FR-010：递归解析 `results[].messages[].details.results`，恢复任意实际存在的嵌套层级。
- FR-011：并发结果按各自 result index 和 Agent name 独立建 span，统一指向发起
  `subagent` Tool 的父 Agent。
- FR-012：子 Agent 内部 assistant/toolResult 消息转换为该子 Agent 的 LLM/Tool span。

### 5.4 Skill

- FR-013：`/skill:<name>` 记为 `triggerMode=explicit`。
- FR-014：读取 `before_agent_start.systemPromptOptions.skills` 建立 Skill path 索引；`read`
  命中对应 `SKILL.md` 时记为 `triggerMode=automatic`。
- FR-015：version 优先取 Skill frontmatter `version`；缺失时使用 Skill 文件内容 SHA-256
  前 12 位，明确标记 `versionSource=content_hash`。
- FR-016：Skill span 从触发开始，到当前 Agent turn 结束；其间 Tool/LLM span 以
  `parentSpanId` 关联 Skill。

### 5.5 Tool 与 MCP

- FR-017：`tool_execution_start` / `tool_execution_end` 按 `toolCallId` 配对，记录输入、
  输出、耗时、错误和 Tool 类型。
- FR-018：Tool 类型至少区分 `shell`、`file`、`search`、`mcp`、`subagent` 和 `custom`。
- FR-019：MCP Tool 名优先遵循 `mcp__<serverName>__<toolName>`；其次读取输入或结果
  metadata 中的 `serverName` / `server_name`，否则只作为普通 custom Tool。
- FR-020：输入、输出先递归脱敏，再按 Unicode code point 截断至 2000 字符。

### 5.6 可靠传输

- FR-021：事件先 append 到按日 JSONL spool，单行写入成功后才进入内存上传队列。
- FR-022：会话结束立即请求上传；空闲时每 5 分钟扫描，插件停用前在有界时间内 flush。
- FR-023：checkpoint 仅在服务端成功受理批次后原子推进；事件 ID 在重传时保持不变。
- FR-024：连续失败按 1、2、4、8、16 分钟指数退避并加入小幅 jitter，成功后复位。
- FR-025：保留期默认 7 天，仅清理 checkpoint 已越过的整行数据。

## 6. 安全与隐私

- API Key 只用于请求 header 和目录哈希，不写入事件、日志或 checkpoint。
- 默认脱敏 key：`api_key`、`apikey`、`authorization`、`token`、`secret`、`password`、
  `cookie`、`private_key`；同时处理常见 Bearer、OpenAI、GitHub 和云凭据文本模式。
- spool 目录权限为当前用户可读写；Unix 下创建时使用 `0700`，文件使用 `0600`。
- 采集器不阻止、修改或重试 Pi 的业务 Tool；采集失败必须 fail-open。
- 清理 spool 是显式卸载选项，默认卸载只停用采集并保留可恢复数据。

## 7. 性能需求

- NFR-001：Pi 冷启动增量 median 和 P95 均小于 200ms。
- NFR-002：相同模型、相同 prompt 的首 Token 时间增量小于 5%。
- NFR-003：稳定空闲 RSS 增量小于 50MB。
- NFR-004：事件 handler 不等待远端 HTTP；除 shutdown flush 外只做本地有界写入。
- NFR-005：连续运行 8 小时无单调 RSS 增长趋势、无未关闭 timer/lock。

## 8. 完成定义

- 37 条 AC 均在 phase3 验收矩阵中有实现位置、自动测试、真实运行证据和状态。
- 自动测试、lint 和 build 全部通过。
- openEuler 24.03 LTS SP4 上完成真实 Pi E2E、断网恢复、卸载重装和性能/长稳验证。
- Adapter golden test 证明 Pi OTLP 输入稳定转换为预期 `ExecutionRecord`。
- PR 只包含本需求设计、源码、测试和必要用户/开发者文档。
