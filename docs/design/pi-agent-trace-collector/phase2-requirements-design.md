# Pi Agent Trace 采集器：需求设计

## 1. 总体架构

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

采集器不在 Pi handler 中直接等待 Agent Insight 服务端。事件先完成本地 durable append，
上传器再从 checkpoint 之后读取完整行、构造 OTLP batch 并发送。

## 2. 代码布局

```text
scripts/agent-trace-collectors/
├── shared/
│   └── trace-transport.cjs
└── pi-agent/
    ├── package.json
    ├── extensions/pi-agent-insight.ts
    ├── lib/pi-trace-core.cjs
    ├── install.cjs
    └── uninstall.cjs

src/lib/ingest/otel/adapters/pi-agent.ts
src/app/api/ingest/setup/pi-agent/...

test/
├── pi-agent-collector.test.ts
├── pi-agent-adapter.test.ts
├── trace-transport.test.ts
└── pi-agent-trace/
    ├── README.md
    ├── fixtures/
    └── performance/
```

共享传输模块只包含无框架语义的 JSONL、锁、checkpoint、重试、HTTP、保留期和脱敏能力。
Pi 事件解释全部留在 `pi-trace-core.cjs` 与扩展入口中。

## 3. 规范化事件

本地 JSONL 使用版本化 envelope：

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

`eventId` 输入只使用稳定业务字段，例如 session、kind、Pi `toolCallId`、turn index、
message timestamp、phase 和子结果 index。重传不重新生成 ID。

## 4. Pi 事件映射

| Pi 事件 | 采集行为 |
|---|---|
| `session_start` | 初始化 session state、Agent root span 和周期 uploader |
| `input` | 保存原始 `/skill:<name>` 信号，不修改用户输入 |
| `before_agent_start` | 保存 query、system prompt Skill 索引、模型/provider |
| `agent_start` | 开始 Agent activity |
| `message_end` assistant | 生成 LLM snapshot，读取原生 usage/model/provider/stopReason |
| `tool_execution_start` | 保存 Tool start，记录参数摘要和父 Skill/Agent |
| `tool_execution_end` | 生成 Tool end，记录结果、耗时和 error |
| `turn_end` | 关闭本 turn 活跃 Skill，更新会话聚合 |
| `agent_end` | 提取最后 assistant 文本作为 result |
| `agent_settled` | 触发非阻塞立即上传 |
| `model_select` | 更新后续 LLM span 的 model/provider |
| `session_shutdown` | 写 Agent end，停止 timer，并在超时内 flush |

### 4.1 文本与 usage

- 文本仅提取 `TextContent.text`，图片只记录 MIME type 和数量，不上传 base64。
- reasoning 内容不上传；只记录 `usage.reasoning`。
- `promptTokens=input`，`completionTokens=output`，`totalTokens=totalTokens`。
- cache read/write 单独保留，服务端总 Token 仍以 Pi `totalTokens` 为准。

## 5. SubAgent 还原

官方示例 `subagent` Tool 的结果 shape 为：

```text
details.mode = single | parallel | chain
details.results[] = {
  agent, task, messages[], usage, model, stopReason, exitCode, step?
}
```

处理算法：

1. 以当前 Agent span 作为发起者，记录 `subagent` Tool span。
2. 对每个 `result` 计算
   `childSessionId = hash(parentSessionId, toolCallId, resultIndex, step, agent)`。
3. 创建 SubAgent span，`parentSpanId` 指向发起者 Agent 或当前 Skill。
4. 遍历 `result.messages`：
   - assistant message 创建 LLM span；
   - assistant content 中的 ToolCall 与后续同 `toolCallId` 的 toolResult 配对；
   - toolResult 的 `details.results` 再递归进入步骤 2。
5. `exitCode`、`stopReason`、`errorMessage` 决定子 Agent 成败；usage 使用 result 汇总与
   assistant 明细交叉校验，避免双计。

此算法的父上下文来自结构化结果，不依赖开始时间相近或 cwd 相同。parallel 的五个结果拥有不同
child ID，chain 的每个 step 指向前一步或共同父级，具体关系由 fixture 固定。

## 6. Skill 识别

### 6.1 显式触发

`input.text` 满足 `^/skill:([a-z0-9-]+)(?:\s+(.*))?$` 时创建 pending Skill：

- `skillName` 为捕获名称；
- `params` 为剩余参数；
- `triggerMode=explicit`；
- 在同一 turn 的 `before_agent_start` 激活。

### 6.2 自动触发

`before_agent_start.systemPromptOptions.skills` 提供 name、filePath、baseDir。采集器将规范化
绝对 `SKILL.md` 路径建立索引。当 `read` Tool 的 `path` / `file_path` 命中时创建 Skill span：

- `triggerMode=automatic`；
- `params` 为触发该次 Agent turn 的 query 摘要；
- 第一次命中开始，turn 结束关闭；
- 重复读取同一路径不重复创建。

### 6.3 版本

采集器只在 Skill 被触发时读取对应 `SKILL.md`：

1. frontmatter `version`；
2. package version；
3. 文件内容 SHA-256 前 12 位。

读取失败时 version 为 `unknown`，同时记录 `versionError`，不影响 Agent 执行。

## 7. Tool、MCP 与脱敏

### 7.1 Tool 类型

| 类型 | 名称匹配 |
|---|---|
| `shell` | `bash`, `shell`, `terminal` |
| `file` | `read`, `write`, `edit`, `ls`, `find`, `grep` |
| `search` | `search`, `web_search`, `grep`, `find` |
| `subagent` | `subagent` |
| `mcp` | `mcp__*__*` 或显式 `serverName` |
| `custom` | 其他 |

MCP canonical name 为 `mcp__server__tool`。若第三方扩展不能提供此命名或 metadata，Adapter
不会猜测 serverName。

### 7.2 脱敏顺序

1. 对对象 key 递归匹配敏感名并替换为 `[REDACTED]`。
2. 对字符串应用 Bearer、常见 key 前缀和 PEM private key 模式。
3. JSON 序列化。
4. 按 code point 截断 2000 字符并追加
   `...[TRUNCATED original_chars=N]`。

## 8. Spool 与上传

目录：

```text
~/.agent-insight/otel_data/pi-agent/<sha256(api-key)[0:12]>/
├── YYYY-MM-DD/events.jsonl
├── uploader-checkpoint.json
└── uploader.lock
```

关键规则：

- JSONL 每行必须以 `\n` 结束；reader 不消费尾部 torn line。
- 进程锁使用原子创建，锁内记录 PID、host 和 startedAt；仅在确认 PID 不存在后回收陈旧锁。
- checkpoint 为 `{version, files: {relativePath: {bytes, lastEventId}}}`，临时文件 fsync 后 rename。
- 每批默认 100 事件或 512 KiB，先按 session 分组，再生成 OTLP resource spans。
- HTTP 2xx 才推进 checkpoint；409/429/5xx 可重试；其他 4xx 停放并记录错误摘要。
- event ID 同时写入 span attribute `agent.insight.event_id`，服务端聚合按 spanId/eventId 去重。
- 立即上传目标为会话结束后 3 秒内发起；后台完整扫描周期为 5 分钟。

## 9. OTLP 映射

每个规范化事件映射为一个 span：

- `service.name=pi-agent`
- `agent.insight.framework=pi-agent`
- `session.id=<sessionId>`
- `openinference.span.kind=AGENT|CHAIN|LLM|TOOL`
- `agent.insight.kind=agent|subagent|skill|tool|llm|mcp`
- `input.value` / `output.value`
- `llm.model_name` / `llm.provider`
- `llm.token_count.prompt` / `completion` / `total`
- `tool.name` / `tool.type` / `tool.arguments` / `tool.result`
- `mcp.server.name` / `mcp.tool.name`
- `skill.name` / `skill.version` / `skill.trigger_mode`

start/end 事件使用同一 spanId。上传前 transport 将最新 end 合并为完整 OTLP span；只有 start 的
in-progress span仍可上传，服务端采用 monotonic merge，后续完整 snapshot 覆盖缺失字段。

## 10. 服务端 Adapter

`piAgentOtelTraceAdapter.matches()` 匹配：

- `serviceName === "pi-agent"`；或
- `agent.insight.framework === "pi-agent"`。

聚合步骤：

1. 按 `startTimeMs`、spanId 排序并去重。
2. 找根 Agent span，提取 query、model、provider、result、latency。
3. 按 `parentSpanId` 建树，把 SubAgent 和 Skill 映射为独立 interaction。
4. LLM interaction 使用原生 usage；Tool/MCP 作为其父 Agent/Skill 下的 tool call。
5. 顶层 usage 对叶子 LLM 求和，不重复累计 Agent/SubAgent 汇总。
6. 输出 `framework="pi-agent"`、五类 interaction、计数和 token 明细。

## 11. 安装与卸载

### 11.1 一键安装

服务端 setup 脚本：

1. 检查 Node >= 22.19 和 Pi 版本范围。
2. 创建 `~/.agent-insight/collectors/{shared,pi-agent}`。
3. 下载扩展、core、transport、package manifest 和配置。
4. 配置文件权限设为 `0600`。
5. 执行 `pi install ~/.agent-insight/collectors/pi-agent`。
6. 执行 collector self-check，确认 spool 与 endpoint。

### 11.2 手工安装

文档列出相同文件、环境变量和 `pi install` 命令，不提供隐式全局配置写入。

### 11.3 卸载

1. `pi remove <absolute-local-package-path>`。
2. 停止 uploader 并移除 collector config/package。
3. 默认保留 spool；`--purge` 只删除
   `otel_data/pi-agent/<current-key-hash>`，`--purge-all` 必须二次确认。
4. 不扫描、不修改 `opencode`、`claude`、`hermes`、`codex` 等目录。

## 12. 决策记录

| ID | 决策 | 原因 |
|---|---|---|
| D-001 | 使用 Pi 0.82.1 真实 Extension API | 避免实现不存在的 Hook |
| D-002 | SubAgent 从 `details.results` 递归还原 | 父上下文显式且可覆盖嵌套/并发 |
| D-003 | MCP 采用命名/metadata 契约 | Pi 核心没有 MCP 事件 |
| D-004 | Skill 自动触发以读取 `SKILL.md` 为准 | 这是公开、稳定且可复现的执行信号 |
| D-005 | 客户端 canonical event + 服务端 OTLP Adapter | 复用 Agent Insight 统一摄入层 |
| D-006 | API Key hash 隔离所有本地状态 | 防止多账号串数据 |
| D-007 | 不修改 Prisma 和 UI | 当前 `ExecutionRecord` 能表达需求 |
