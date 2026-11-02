# Claude Code OTel 工具输出采集补全 — 遗留问题分析

> 创建日期：2026-06-10
> 状态：遗留问题记录，后续开发前需要重新确认采集源。

## 背景

本轮修复已经处理了两个确定问题：

1. `buildAgentCallTree` 对同父节点下多个同类型 subagent task 的合并过度问题。
2. Claude parser / OTel aggregator 对已存在 `tool_result` 正文的回填能力。

但在连续验证 Claude Code trace 时，工具输出仍然没有出现在平台 trace 中。最新复现 trace 为：

- `56eada4a-da43-4395-bab6-49577c48a539`
- `2d81fe96-bf3d-4ec9-af9a-47b12c79da4c`
- `245c42b6-280b-4d83-a52a-447d8fe446c5`

本文件记录当前已确认事实、误判点和下一轮开发入口。

## 已确认事实

### 1. OTel `tool_result` log 本身没有输出正文

对 `245c42b6-280b-4d83-a52a-447d8fe446c5` 的 raw OTel spool 检查结果：

- `tool_result` 共 9 条。
- 每条只有 `tool_name`、`tool_use_id`、`success`、`duration_ms`、`tool_input`、`tool_result_size_bytes` 等 metadata。
- 没有 `tool_result`、`tool_result_content`、`tool_output`、`output`、`result` 等正文属性。

结论：当前 logs 里的 `tool_result` event 不能直接提供 tool output。

### 2. `OTEL_LOG_TOOL_CONTENT=1` 不会让 logs 的 `tool_result` 带正文

Claude Code 官方文档说明 `OTEL_LOG_TOOL_CONTENT=1` 影响的是 tracing span events，并且 requires tracing。

本轮 wrapper 虽然设置了：

```sh
OTEL_LOG_TOOL_CONTENT=1
```

但当前接入只启用了：

```sh
OTEL_LOGS_EXPORTER=otlp
```

没有启用 enhanced telemetry traces。因此它不会改变 logs 协议下的 `tool_result` event 内容。

### 3. inline raw API body 会被 Claude Code 截断

`245c...` 的 `api_request_body` 共有 10 条，其中长主线程请求仍然是：

- `body_truncated=true`
- 实际 `body` 长度约 61482 chars
- `body_length` 在 10 万字符以上
- 没有 `body_ref`

因此不能依赖 `OTEL_LOG_RAW_API_BODIES=1` 的 inline body 从 conversation history 中恢复 tool result。

### 4. `.env` 已经是 file 模式，但本次 trace 仍没有 `body_ref`

本机配置已经是：

```sh
AGENT_INSIGHT_CLAUDE_OTEL_RAW_API_BODIES=file:~/.agent-insight/claude_raw_bodies
```

source wrapper 后变量值也确认为上述 file 模式。

但 `245c...` 的 OTel event 仍然是 inline `body`，没有 `body_ref`。同时 `~/.agent-insight/claude_raw_bodies` 目录不存在。

这说明至少存在一个运行态问题：

1. 运行 `245c...` 的终端可能仍然使用旧的 `claude()` shell function，文件更新后没有重新 `source ~/.agent-insight/claude_otel_env.sh`。
2. 或者 Claude Code 2.1.133 在当前 logs exporter 链路里没有采纳 `OTEL_LOG_RAW_API_BODIES=file:<dir>`，即使环境变量值正确也仍回退到 inline 截断。

目前还不能在这两者之间下最终结论。

### 5. Claude native transcript 中确实有工具输出正文

`~/.claude/projects/<project-slug>/245c42b6-280b-4d83-a52a-447d8fe446c5.jsonl` 存在。

其中：

- 共 34 行。
- 有 9 个 `tool_result` block。
- 输出正文包括 Bash 内存、磁盘、top、进程列表等结果。

结论：工具输出不是 Claude Code 没生成，而是没有通过当前 OTel logs 数据源稳定进入平台。

## 当前误判点

本轮曾把问题拆成两个方向修：

1. 补 `OTEL_LOG_TOOL_CONTENT=1`。
2. 将 `OTEL_LOG_RAW_API_BODIES` 改为 `file:<dir>`，并让 aggregator 读取 `body_ref`。

现在看，第 1 点只对 traces 有意义；第 2 点在代码上是合理路径，但需要先确认 Claude Code 当前版本是否真的会在 logs 事件中发 `body_ref`。

也就是说，当前实现能力已经准备了 `body_ref -> tool_result block -> tool_calls[].output` 的处理，但真实采集源还没有提供 `body_ref`。

## 下一轮开发前必须先验证

### 验证 A：确认 shell function 是否是最新版本

在运行 Claude Code 的同一个终端里执行：

```sh
source ~/.agent-insight/claude_otel_env.sh
type claude | sed -n '1,60p'
```

必须看到：

```sh
mkdir -p "$HOME/.agent-insight/claude_raw_bodies"
OTEL_LOG_RAW_API_BODIES="${AGENT_INSIGHT_CLAUDE_OTEL_RAW_API_BODIES:-file:$HOME/.agent-insight/claude_raw_bodies}"
```

然后在同一终端里跑新 trace，并检查：

```sh
ls -ld ~/.agent-insight/claude_raw_bodies
```

如果目录没有出现，说明仍没有执行最新 wrapper。

### 验证 B：确认 OTel logs 是否产生 `body_ref`

新 trace 产生后检查 raw spool：

- `api_request_body.attributes.body_ref` 是否存在。
- `api_request_body.attributes.body_truncated` 是否消失。
- `~/.agent-insight/claude_raw_bodies` 下是否有对应文件。

如果 `body_ref` 出现，当前 aggregator 的 body_ref 回填路线才有真实数据可用。

### 验证 C：确认 traces 方案是否可行

如果 file mode 仍不产生 `body_ref`，需要试验启用 traces：

```sh
CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1
OTEL_TRACES_EXPORTER=otlp
OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=<host>/api/ingest/otel/v1/traces
OTEL_LOG_TOOL_CONTENT=1
```

观察 `tool.output` span event 是否包含工具输出正文。

## 后续方案候选

### 方案 1：继续走 OTel logs + raw body file

前提：Claude Code 能稳定发 `body_ref`。

优点：

- 继续复用现有 logs pipeline。
- 不需要引入 native transcript watcher。
- aggregator 已经具备读取 `body_ref` 并回填 output 的基础能力。

风险：

- 如果 Claude Code 当前版本实际上不支持 file mode，方案不可用。

### 方案 2：启用 OTel traces 并解析 span event

前提：Claude Code enhanced telemetry traces 可用，且 span event 中确实有 tool output。

优点：

- 符合官方文档对 `OTEL_LOG_TOOL_CONTENT` 的语义。
- tool output 属于工具 span 的自然事件。

风险：

- 需要补全 traces aggregator 对 span events 的保留和映射。
- 当前 traces pipeline 主要归一化 span attributes，还未验证 tool output event 的字段形态。

### 方案 3：用 Claude native JSONL 作为补充源

前提：接受 Claude Code 官方 OTel logs 之外，再读本机 `.claude/projects/*.jsonl` 做 output enrichment。

优点：

- 已确认 native transcript 中有完整 tool result。
- 对当前复现样本最直接有效。

风险：

- 回到本地文件依赖，不再是纯 OTel 接入。
- 需要设计 OTel session 与 native JSONL 的匹配、去重、权限和保留策略。

## 建议的下一步

下一轮不要先改代码，先跑一条最小验证 trace，明确以下分支：

1. 如果最新 wrapper 执行后能产生 `body_ref`，继续完善并验证 OTel logs + raw body file 方案。
2. 如果 file mode 没有 `body_ref`，优先试验 traces 方案。
3. 如果 traces 也拿不到稳定正文，再设计 native JSONL enrichment，而不是继续在 logs `tool_result` event 上猜字段。

验收口径：

- 新 trace 的 `Session.interactions[].tool_calls[].output` 至少覆盖所有有正文的 tool result。
- trace UI 中 Claude Code 工具调用能展示实际输出。
- raw OTel 缺正文时，系统应能明确区分“未采集”与“已采集但为空”。
