# Pi Agent Trace 采集器方案

关联 issue：[`openeuler/opensource-intern#158`](https://atomgit.com/openeuler/opensource-intern/issues/158)

## 1. 任务与目标

本方案为 Agent Insight 增加 Pi Agent 0.82.x Trace 采集器，使 Pi 在不修改上游源码的前提下，
能够采集 Agent、SubAgent、Skill、Tool、LLM 和 MCP 语义，并统一转换为
`ExecutionRecord`。

目标包括：

- 通过 Pi package 机制安装并自动加载采集扩展，同时提供 Bash、PowerShell 和手工安装方式；
- 事件先写入本地 JSONL spool，再通过 OTLP HTTP/JSON 异步上传；
- 使用 API Key 的 SHA-256 前缀隔离 spool、checkpoint 和进程锁；
- 网络失败、进程退出或服务端错误时保留已落盘事件，恢复后避免重复上传；
- 通过专用 Pi Adapter 保留父子 Agent、Skill、Tool、LLM 和 MCP 的归属关系；
- 安装、卸载、重装与清理操作不影响其他 Agent 框架或其他 API Key namespace。

## 2. 真实接口边界

实现基线为 `@earendil-works/pi-coding-agent@0.82.1`，兼容范围为
`>=0.82.1 <0.83.0`，Node.js 要求 `>=22.19.0`。

- Pi Extension API 原生提供 session、agent、turn、message、tool、model 和 provider 事件。
- Pi 的官方 SubAgent 示例通过 `subagent` Tool 启动独立 `pi` 子进程，不存在原生
  `subagent_start` / `subagent_stop` Extension 事件。
- Pi 核心不内建 MCP。MCP 扩展表现为自定义 Tool，采集器依据稳定 Tool 命名或显式
  metadata 识别 `serverName`。
- 显式 Skill 调用从 `input` 事件中的 `/skill:<name>` 识别；自动调用 Skill 以 `read` Tool
  读取已加载 Skill 的 `SKILL.md` 为稳定执行信号。

采集器不修改 Pi 上游源码，不使用时间窗口猜测 SubAgent 父子关系，不修改 Prisma schema，
也不为未遵循命名或 metadata 契约的任意第三方扩展猜测 MCP server。

## 3. 总体架构

```text
Pi Extension API
  session / agent / message / tool / model
                    |
                    v
        Pi event normalizer
  explicit parent ids + stable event ids
                    |
                    v
 ~/.agent-insight/otel_data/pi-agent/<api-key-hash>/
  events JSONL + checkpoint + process lock
                    |
          bounded async uploader
                    |
                    v
 POST /api/ingest/otel/v1/traces (OTLP HTTP/JSON)
                    |
                    v
 Pi OtelTraceAdapter -> ExecutionRecord -> database
```

事件 handler 只完成本地有界写入，不等待 Agent Insight 服务端。上传器从 checkpoint 之后
读取完整 JSONL 行，构造 OTLP batch 并异步发送。

主要代码布局：

```text
scripts/agent-trace-collectors/
├── shared/trace-transport.cjs
└── pi-agent/
    ├── package.json
    ├── extensions/pi-agent-insight.ts
    ├── lib/pi-trace-core.cjs
    ├── install.cjs
    ├── install.sh
    ├── install.ps1
    └── scripts/{self-check,uninstall}.cjs

src/lib/ingest/otel/adapters/pi-agent.ts
src/app/api/ingest/setup/pi-agent/...
```

共享 transport 只包含 JSONL、锁、checkpoint、重试、HTTP、保留期和脱敏等无框架语义的
能力；Pi 事件解释保留在 Pi collector 与 Adapter 中。

## 4. 事件与数据映射

本地事件使用版本化 envelope：

```json
{
  "schemaVersion": 1,
  "eventId": "sha256-stable-id",
  "framework": "pi-agent",
  "apiKeyHash": "12-hex",
  "sessionId": "pi-session-id",
  "traceId": "32-hex",
  "spanId": "16-hex",
  "parentSpanId": "16-hex-or-null",
  "kind": "agent|subagent|skill|tool|llm|mcp",
  "phase": "start|end|snapshot",
  "timestamp": "RFC3339",
  "attributes": {}
}
```

`eventId` 只使用 session、kind、Pi `toolCallId`、turn index、message timestamp、phase
和子结果 index 等稳定字段，重传时保持不变。

| Pi 事件 | 采集行为 |
| --- | --- |
| `session_start` | 初始化 session state、根 Agent span 和周期 uploader |
| `input` | 保存 `/skill:<name>` 显式触发信号，不修改用户输入 |
| `before_agent_start` | 保存 query、模型、provider 和 Skill 路径索引 |
| `agent_start` | 开始 Agent activity |
| assistant `message_end` | 生成 LLM snapshot，读取原生 usage、model、provider 和 stopReason |
| `tool_execution_start/end` | 按 `toolCallId` 合并 Tool 生命周期、参数、结果、耗时和错误 |
| `turn_end` | 关闭当前 turn 的活动 Skill 并更新聚合 |
| `agent_end` | 提取最后 assistant 文本作为 result |
| `agent_settled` | 触发非阻塞立即上传 |
| `model_select` | 更新后续 LLM span 的 model/provider |
| `session_shutdown` | 写入 Agent end、停止 timer 并执行有界 flush |

文本只提取 `TextContent.text`；图片记录 MIME type 和数量，不上传 base64；reasoning 内容不
上传，只记录 `usage.reasoning`。Token 使用 Pi 原生 `input`、`output`、`cacheRead`、
`cacheWrite`、`reasoning` 和 `totalTokens`，服务端总量以 `totalTokens` 为准。

## 5. SubAgent、Skill、Tool 与 MCP

### 5.1 SubAgent

官方 `subagent` Tool 的 `details.results[]` 包含 agent、task、messages、usage、model、
stopReason、exitCode 和可选 step。采集器按以下规则还原：

1. 记录发起 `subagent` 的 Tool span；
2. 使用 `parentSessionId + toolCallId + resultIndex + step + agent` 生成确定性子会话 ID；
3. 子 Agent 的 `parentSpanId` 指向发起者 Agent 或活动 Skill；
4. 递归解析子结果中的 assistant、ToolCall、toolResult 和嵌套 `details.results`；
5. 使用子结果汇总与 assistant 明细交叉校验 usage，避免双计。

父上下文来自结构化结果；并发结果按 result index 和 Agent name 分离，不依赖时间或 cwd。

### 5.2 Skill

- `/skill:<name>` 创建 `triggerMode=explicit` 的 Skill span；
- `read` Tool 命中 `before_agent_start.systemPromptOptions.skills` 中的规范化 `SKILL.md`
  路径时创建 `triggerMode=automatic` 的 Skill span；
- version 优先取 frontmatter，其次 package version，再使用文件内容 SHA-256 前 12 位；
- Skill span 以当前 turn 为边界，活动期间的 Tool/LLM 通过 `parentSpanId` 归属该 Skill。

### 5.3 Tool 与 MCP

| 类型 | 名称或信号 |
| --- | --- |
| `shell` | `bash`、`shell`、`terminal` |
| `file` | `read`、`write`、`edit`、`ls`、`find`、`grep` |
| `search` | `search`、`web_search`、`grep`、`find` |
| `subagent` | `subagent` |
| `mcp` | `mcp__<server>__<tool>` 或显式 `serverName` metadata |
| `custom` | 其他 Tool |

Tool 输入和输出先递归脱敏，再按 Unicode code point 截断至 2000 字符。MCP 缺少稳定命名
和 metadata 时按普通 custom Tool 处理。

## 6. 可靠传输与安全

```text
~/.agent-insight/otel_data/pi-agent/<sha256(api-key)[0:12]>/
├── YYYY-MM-DD/events.jsonl
├── uploader-checkpoint.json
└── uploader.lock
```

- JSONL 每行以换行符结束，reader 不消费尾部 torn line；
- 锁通过原子创建，只有确认原 PID 不存在后才回收陈旧锁；
- checkpoint 通过临时文件、fsync 和原子 rename 更新；
- 每批默认最多 100 个事件或 512 KiB，HTTP 2xx 后才推进 checkpoint；
- 429、5xx 和网络错误按 1、2、4、8、16 分钟退避，成功后复位；
- 会话结束触发立即扫描，后台每 5 分钟完整扫描；
- 默认保留 7 天，只清理 checkpoint 已越过的完整行。

API Key 只用于请求 header 和目录哈希，不进入事件、日志、checkpoint 或资源 URL。对象 key
和字符串均执行凭据脱敏；Unix 目录和配置分别使用 `0700`、`0600`。采集失败 fail-open，
不阻断或重试 Pi 的业务 Tool。

## 7. 安装、卸载与中央接入

Agent Insight 的三个用户入口均在现有框架列表末尾追加
`{ value: 'pi-agent', label: 'Pi Agent' }`：

- `src/app/(main)/accessconfig/install/page.tsx`
- `src/app/api/ingest/setup/route.ts`
- `src/app/api/ingest/setup/auto/route.ts`

中央 route 支持 Bash、PowerShell、空选择和 `frameworks` 预选；预选值只通过固定白名单
解析。框架专属 `GET /api/ingest/setup/pi-agent` 默认返回 Bash，`x-platform: windows`
返回 PowerShell staging script，资源只从固定 allowlist 分发。

Bash 与 PowerShell 复用跨平台 Node 安装核心，执行版本检查、资源复制、权限配置、
`pi install` 和 self-check。本地 npm 包链通过
`scripts/install.js -> /api/setup/auto -> Pi installer`，已安装的本地 tarball 不被 registry
版本替换。

卸载先执行 `pi remove <absolute-local-package-path>`，再移除 collector 配置与 package；默认
保留 spool。`--purge` 只删除当前 API Key namespace，`--purge-all` 需要显式确认，且不扫描
或修改其他框架目录。

## 8. 服务端 Adapter

Pi Adapter 匹配 `serviceName === "pi-agent"` 或
`agent.insight.framework === "pi-agent"`，并执行：

1. 按时间和 spanId 稳定排序、去重；
2. 提取根 Agent 的 query、model、provider、result 和 latency；
3. 按 `parentSpanId` 构建 SubAgent、Skill、Tool 和 MCP 树；
4. LLM interaction 使用 Pi 原生 usage；
5. 顶层 Token 对叶子 LLM 求和，避免重复累计 Agent/SubAgent 汇总；
6. 输出 `framework="pi-agent"` 的统一 `ExecutionRecord`。

## 9. 验收与证据

验收覆盖以下链路：

- 三个中央入口的末尾追加、白名单、Bash/PowerShell 生成与语法；
- 安装指导 curl、中央 PowerShell、本地 npm tarball 和框架专属 setup；
- Extension 状态机、SubAgent 递归、Skill 归属、Tool/MCP、原生 Token 和 durable transport；
- 断网/HTTP 500 恢复、无重复上传、双 API Key 隔离、scoped purge 和卸载重装；
- 服务端 Adapter、registry、OTel 聚合和 SQLite 持久化；
- Windows 隔离用户、openEuler 真实模型、非 loopback 跨机上传和安装页浏览器验证；
- 目标测试、既有采集器回归、全仓测试基线、lint 基线、production build、
  `git diff --check` 和敏感信息扫描。

自动化与真实运行证据分别记录在：

- `test/pi-agent-trace/reports/automated-tests.md`
- `test/pi-agent-trace/reports/e2e.md`

## 10. 关键决策

| ID | 决策 | 原因 |
| --- | --- | --- |
| D-001 | 使用 Pi 0.82.1 公开 Extension API | 不实现上游不存在的 Hook |
| D-002 | 从 `details.results` 递归还原 SubAgent | 使用显式父上下文覆盖嵌套与并发 |
| D-003 | MCP 使用命名或 metadata 契约 | Pi 核心没有 MCP 事件 |
| D-004 | 自动 Skill 以读取 `SKILL.md` 为信号 | 公开、稳定且可复现 |
| D-005 | 客户端 canonical event + 服务端 OTLP Adapter | 复用统一摄入层 |
| D-006 | API Key hash 隔离本地状态 | 防止多账号串数据 |
| D-007 | 不修改 Prisma schema | 现有 `ExecutionRecord` 可表达目标数据 |
