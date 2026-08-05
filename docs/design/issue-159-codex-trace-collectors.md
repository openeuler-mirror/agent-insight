# Codex CLI 与 IDE Extension Trace 采集器方案

关联 issue：[`openeuler/opensource-intern#159`](https://atomgit.com/openeuler/opensource-intern/issues/159)

## 1. 任务与目标

本方案为 Agent Insight 增加 Codex CLI 与 IDE Extension Trace 采集器。CLI 侧组合 Codex
lifecycle Hooks 与原生 OTel，IDE 侧通过 VSIX 接入 VS Code、Cursor 和 Windsurf，服务端将
Agent、SubAgent、Skill、Tool、LLM 和编辑器事件统一转换为 `ExecutionRecord`。

目标包括：

- 非破坏性注入 Codex CLI 11 类 Hook，并支持精确卸载和原配置恢复；
- 启用原生 OTel HTTP/JSON，由本地 relay 合并 Hook 生命周期与模型、Token、TTFT 指标；
- CLI 与 IDE 共用按 API Key 隔离的 durable spool、checkpoint、锁和上传器；
- 提供可安装 VSIX、状态栏、Settings、FileEdit 与 Terminal Shell Execution 采集；
- 只在存在明确活动 IDE turn 时归因编辑器事件；
- 通过专用 Codex Adapter 合并重复快照，保持其他 OTel 框架的原去重语义；
- 安装、卸载、重装与故障恢复不覆盖其他 Hook、OTel exporter 或 collector 配置。

## 2. 真实接口边界

实现基线为 `@openai/codex@0.145.0`；本地回归已覆盖 `0.146.0`，兼容范围为
`>=0.145.0 <0.147.0`。

- Codex 支持 `SessionStart`、`SessionEnd`、`UserPromptSubmit`、`PreToolUse`、
  `PostToolUse`、`PreCompact`、`PostCompact`、`SubagentStart`、`SubagentStop`、
  `PermissionRequest` 和 `Stop` 共 11 类 lifecycle Hook。
- 当前由 `command` Hook handler 执行；新增或变更的非托管 Hook 需要用户在 `/hooks` 中
  审查并信任。
- Hook 提供 session、turn、tool、subagent、prompt 和 result 生命周期，不提供完整 Token。
- 原生 OTel 的 `codex.sse_event(response.completed)`、`codex.turn_ttft`、
  `codex.tool_result` 和 `codex.api_request` 提供 Token、TTFT、时延与调用统计。
- `openai.chatgpt` 扩展不公开稳定私有接口。IDE Chat Trace 来自共享 Codex runtime 的
  Hooks/OTel，不读取闭源扩展 storage、webview、transcript 或内部进程。
- Cloud 关联只接受原生 OTel 实际提供的 `auth.agent_id` / `auth.task_id`；用户手工填写的 ID
  标记为 `source=user`，不作为自动采集字段。

## 3. 双通道架构

```text
Codex CLI / Codex IDE host
       |                         |
       | command Hooks           | native OTel HTTP/JSON
       v                         v
  hook-handler.cjs       127.0.0.1:<relay>/v1/logs
       |                         |
       +-----------> Codex relay <-----------+
                       |
        Hook lifecycle + OTel metrics merge
                       |
                       v
 ~/.agent-insight/otel_data/codex/<api-key-hash>/
       canonical JSONL + raw OTLP + checkpoint
                       |
                       v
 POST /api/ingest/otel/v1/traces
                       |
                       v
 Codex OtelTraceAdapter -> ExecutionRecord

VS Code / Cursor / Windsurf VSIX
       | loopback status + IDE events
       +-------------> Codex relay
```

Hooks 提供稳定的 session、turn、Tool 和 SubAgent 边界，OTel 提供模型、Token、TTFT、API
和 Tool 指标。relay 是唯一合并点与 uploader，避免 CLI 和 VSIX 重复上传。

主要代码布局：

```text
scripts/agent-trace-collectors/
├── shared/trace-transport.cjs
└── codex/
    ├── hook-handler.cjs
    ├── relay.cjs
    ├── codex-trace-core.cjs
    ├── config-core.cjs
    ├── install.{cjs,sh,ps1}
    ├── uninstall.cjs
    ├── self-check.cjs
    ├── build-vsix.cjs
    └── vscode-extension/
        ├── package.json
        ├── extension.cjs
        └── ide-trace-core.cjs

src/lib/ingest/otel/adapters/codex.ts
src/app/api/ingest/setup/codex/...
```

共享 transport 只承载无框架语义的可靠传输能力；Hook/OTel 合并与 Codex 事件解释保留在
Codex collector 和 Adapter 中。

## 4. Hook、OTel 与 relay

### 4.1 Hook 配置与信任

安装器结构化解析 `~/.codex/hooks.json`，向 11 个事件追加调用 Agent Insight handler 的
matcher group，并保留未知字段和其他 Hook。卸载标识使用规范化绝对 command 路径与 handler
内容 hash；Windows 使用 `commandWindows` 调用同一 Node handler。

写入通过临时文件、fsync 和原子 rename 完成。JSON 不合法时停止，不覆盖原文件。安装后
self-check 提示用户启动 Codex、执行 `/hooks`、核对来源并 Trust；信任状态由 Codex 维护，
安装器不写入信任 hash。

### 4.2 OTel managed block

安装器只在不存在 `[otel]`，或 exporter 明确为 `none` 且没有活动嵌套 exporter table 时
写入指向 loopback relay 的 managed block。已有非空 exporter 时返回 `otel_conflict`，不修改
`config.toml`。卸载只移除 managed block，并原样恢复安装前可安全替换的简单配置。

### 4.3 Hook handler

handler 从 stdin 读取最多 1 MiB JSON，验证事件名、session 和必需字段，从权限受限的 collector
config 读取 relay port 与 install secret，然后向 `/hook` 发起 150 ms loopback 请求。relay
不可达时使用 detached Node 拉起并进行有界重试。handler 始终 fail-open，不读取
`transcript_path` 内容，也不向 stdout 输出阻断指令。

### 4.4 会话状态机

```text
SessionStart -> session.open
UserPromptSubmit(turn_id) -> turn.open
Pre/Post Tool, Subagent, OTel events -> attach to open turn
Stop(turn_id) -> turn.closed + immediate flush
SessionEnd -> session.closed + immediate flush
```

OTel 没有 turn ID。relay 只在 conversation 中存在唯一 open turn 时自动归属；没有 open turn
时进入 session-level pending，多个 open turn 时保留 `turn_id=null` 并记录 ambiguity。

稳定 ID 以 session、turn、agent、Tool call 和事件来源字段生成。Hook 与 OTel 同时提供同一
Tool 时按 `call_id` 合并：Hook 提供参数、结果和生命周期，OTel 补充 duration、success、
MCP server 和 output。

### 4.5 OTel 事件映射

| `event.name` | 采集行为 |
| --- | --- |
| `codex.conversation_starts` | provider、model 和 session settings |
| `codex.user_prompt` | prompt 长度；默认内容为 `[REDACTED]` |
| `codex.turn_ttft` | 当前 turn TTFT |
| `codex.sse_event` + `response.completed` | LLM Token、TTFT 和 reasoning 计数 |
| `codex.api_request` | API latency、status、error 和可选 Cloud auth ids |
| `codex.tool_result` | Tool duration、success、output 和 MCP server |

Token 总量使用 `input_token_count + output_token_count`，cache/reasoning 作为 breakdown 保留；
不同语义的 `tool_token_count` 不覆盖模型总量。

## 5. Skill、SubAgent 与 Tool

### 5.1 Skill

- `UserPromptSubmit.prompt` 中的 `$name` 或 `/skill:name` 记为 explicit；
- Tool 参数中的规范化路径命中 `*/skills/<name>/SKILL.md` 时记为 automatic；
- version 优先取 SKILL.md frontmatter，缺失时使用内容 hash；
- Skill span 以当前 turn 为边界，活动期间的 Tool/LLM 通过 `parentSpanId` 归属该 Skill。

该实现使用 Codex 0.145.0 的公开 Hook/OTel 执行信号，不依赖内部 analytics fact。

### 5.2 SubAgent

根 session 使用 `session_id`，turn 使用 `turn_id`，子 Agent 使用 `agent_id`、`agent_type`
和 `agent_transcript_path`。若 Hook 提供 `parent_agent_id` 则直接使用；缺失时归属触发
`SubagentStart` 的当前 Agent/turn，并标记 `parentSource=current_active_agent`。

### 5.3 Tool

| Hook/OTel name | Agent Insight 类型 |
| --- | --- |
| `Bash`、`ShellCommand`、`exec_command` | `shell` |
| `apply_patch`、`Edit`、`Write` | `apply_patch` / `file_edit` |
| `FileSearch`、`read_file`、`grep`、`find` | `file_search` |
| `CodeInterpreter` | `code_interpreter` |
| `mcp__server__tool` 或 OTel `mcp_server` | `mcp` |
| `Agent`、`spawn_agent` | `subagent_tool` |
| 其他 | `custom` |

输入和输出递归脱敏并按 2000 字符截断。

## 6. VSIX 设计

VSIX 提供 enabled、endpoint、apiKey、relayPort、captureFileEdits、captureTerminal 和
`cloudAgentId` Settings，以及 Open Settings、Open Logs、Flush Spool、Link Cloud Agent、
Unlink Cloud Agent 命令。状态栏显示 connected、spooling、disabled 或 error。

扩展每秒查询 loopback `/status`。只有唯一 active turn 同时满足 IDE originator、workspace
与 Hook cwd 匹配且尚未 Stop，才允许 FileEdit/Terminal 归因；其余事件丢弃并增加本地
`unattributed` 计数。

FileEdit 只记录相对路径、range、rangeLength、insertedLength、timestamp 和 languageId，
不记录完整插入文本；同一文档 500 ms 内的变化合并。Terminal 优先使用
`onDidStartTerminalShellExecution` / `onDidEndTerminalShellExecution`，记录 commandLine、
terminal name、可用 cwd、duration 和 exitCode；API 不可用时记录 unsupported，不读取按键、
shell history 或终端输出。

## 7. 可靠传输与安全

```text
~/.agent-insight/otel_data/codex/<sha256(api-key)[0:12]>/
├── YYYY-MM-DD/events.jsonl
├── YYYY-MM-DD/raw-otel.jsonl
├── uploader-checkpoint.json
├── relay-state.json
└── relay.lock
```

- raw OTel 先落盘再返回 200，canonical event 写入后才推进 raw checkpoint；
- uploader 每 5 分钟完整扫描，Stop、SessionEnd 和 deactivate 触发立即扫描；
- 服务端 2xx 后才推进 canonical checkpoint；
- 429、5xx 和网络错误按 1、2、4、8、16 分钟退避；其他 4xx 停放；
- 稳定 eventId/spanId 与服务端去重共同保证重传幂等；
- handler 只向 `127.0.0.1` relay 发送，relay 使用随机 install secret 鉴权；
- API Key 只进入权限为 `0600` 的 collector config 和请求 header，不进入 Hook command、
  事件、日志、checkpoint 或资源 URL；
- 托管配置启用 `otel.log_user_prompt=true`，以保留用户任务边界和可读任务名；事件仍经过
  递归脱敏和长度限制。FileEdit 不上传完整文件，Terminal 不读取环境变量、输出和历史。

## 8. 安装、卸载与中央接入

Agent Insight 的三个用户入口均在现有框架列表末尾追加
`{ value: 'codex', label: 'Codex' }`：

- `src/app/(main)/accessconfig/install/page.tsx`
- `src/app/api/ingest/setup/route.ts`
- `src/app/api/ingest/setup/auto/route.ts`

中央 route 支持 Bash、PowerShell、空选择和 `frameworks` 预选；预选值只通过固定白名单
解析。框架专属 `GET /api/ingest/setup/codex` 默认返回 Bash，`x-platform: windows`
返回 PowerShell staging script，资源只从固定 allowlist 分发。

Bash 与 PowerShell 复用 `install.cjs`，执行版本检查、Hook/OTel 配置、relay/VSIX 安装、
self-check 和使用提示。本地 npm 包链通过
`scripts/install.js -> /api/setup/auto -> Codex installer`，已安装的本地 tarball 不被
registry 版本替换。

卸载只移除指向 Agent Insight handler 的 11 个 Hook、managed OTel block 和本 collector
配置，恢复可逆的原配置并在无 CLI/IDE lease 时退出 relay。默认保留 spool；`--purge`
只删除当前 API Key namespace。VSIX 使用三类编辑器的标准 Extensions 面板或 CLI 卸载。

## 9. 服务端 Adapter 与去重边界

Codex Adapter 匹配 `serviceName === "codex"`、`serviceName === "codex-cli"` 或
`agent.insight.framework === "codex"`，并执行：

1. 使用 Hook lifecycle 确定 query、result、SubAgent 和 Tool；
2. 使用 OTel LLM span 补充 model、provider、Token 和 TTFT；
3. 按活动 span 插入 Skill，保留 IDE FileEdit/Terminal 的 `source=ide`；
4. 将实际存在的 `auth.agent_id` / `auth.task_id` 写入可扩展 metadata；
5. 输出 `framework="codex"` 的统一 `ExecutionRecord`。

generic 与既有 OTel 框架对相同 key 继续保留首条。`OtelTraceAdapter` 提供可选的
`preprocessEvents`，只有 Codex Adapter 使用 raw session events，并按相同 `spanId` 的结束
时间保留最新快照。这一规则使 start/in-progress 事件可以由后续完成事件补齐，同时不改变
OpenCode、OpenClaw、Claude、Hermes、JiuwenSwarm、CodeAgent 和 generic OTel 的行为。

## 10. 验收与证据

验收覆盖以下链路：

- 三个中央入口的末尾追加、白名单、Bash/PowerShell 生成与语法；
- 安装指导 curl、中央 PowerShell、本地 npm tarball 和框架专属 setup；
- 11 类 Hook、原生 `/hooks` 信任、OTel relay、Hook/OTel 合并和 Codex-only 快照去重；
- Agent、SubAgent、Skill、Tool、MCP、模型、Token、TTFT 与 durable transport；
- 断网/HTTP 500 恢复、无重复上传、卸载重装和其他 Hook/OTel 配置保留；
- VS Code、Cursor、Windsurf 的 VSIX 安装、激活、状态栏、Settings、FileEdit、Terminal、
  卸载与重装；
- Windows 隔离用户、openEuler 真实模型、非 loopback 跨机上传和安装页浏览器验证；
- 目标测试、既有采集器回归、全仓测试基线、lint 基线、production build、
  `git diff --check` 和敏感信息扫描。

自动化与真实运行证据分别记录在：

- `test/codex-trace/reports/automated-tests.md`
- `test/codex-trace/reports/e2e.md`

## 11. 关键决策

| ID | 决策 | 原因 |
| --- | --- | --- |
| D-001 | Hooks + OTel 双通道 | Hook 无完整 Token，OTel 无完整 turn lifecycle |
| D-002 | loopback relay 作为唯一合并点和 uploader | CLI/IDE 共用 runtime 并避免重复 |
| D-003 | Hook 信任由用户通过 `/hooks` 完成 | 遵循 Codex 原生安全模型 |
| D-004 | 已有 OTel exporter 冲突时停止 | 不破坏现有 telemetry |
| D-005 | IDE Chat 使用共享 runtime | 闭源扩展无稳定私有接口 |
| D-006 | IDE 事件使用 active turn gate | 防止普通编辑和终端误归因 |
| D-007 | Cloud 只接受真实 OTel 标识 | 不伪造自动采集字段 |
| D-008 | Skill 使用公开 prompt/read 信号 | 不依赖内部 analytics fact |
| D-009 | latest-snapshot 仅在 Codex Adapter 生效 | 保持既有 OTel 框架语义不变 |
