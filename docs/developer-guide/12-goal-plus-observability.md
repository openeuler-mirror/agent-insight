# Goal Plus Pi 主从 Trace 接入

本适配面向重构后的 Goal Plus：Pi 和 Goal Plus 使用统一的 session 描述，Agent Insight 复用已有 OTLP Trace ingest 与跨 Session 关系 ingest，把 Pi 原生主 Trace 和 Goal Plus Pi worker Trace 合成为只读的主从展示。

新版 collector 不再向 Goal Plus semantic snapshot 接口上传数据，也不兼容旧 `host` / `host_handle` session 格式。服务端已有语义模型和接口可以继续读取历史数据，但不属于当前采集路径。

## 数据流与权威边界

```text
Pi native session
  └─ pi-agent collector
       ├─ POST /api/ingest/otel/v1/traces
       │    └─ taskId = <nativeSessionId>__taskN
       └─ POST /api/ingest/collaborations/sessions
            └─ logical session "main" → taskId

attached .gp
  ├─ goal-plus/<goalId>/goal.json
  │    └─ host_command_invocations: Pi start session
  └─ runs/<runId>/agent_sessions/<agentSessionId>.json
       └─ agent_harness/runtime_provider/execution_scope/session_handle
            ├─ native Pi JSONL or ThinkThread diagnostics archive
            ├─ POST /api/ingest/otel/v1/traces
            ├─ POST /api/ingest/collaborations/sessions
            │    └─ logical worker session → canonical worker taskId
            └─ POST /api/ingest/collaborations/events
                 └─ main → worker

collaboration projection
  └─ main Trace + synthetic TASK + worker interaction copies
```

权威边界：

- Pi 原生 collector 是主 Trace 的唯一正文来源；Goal Plus collector 不再扫描或重复导入主 Pi session。
- Goal Plus `agent_sessions` 是 worker 身份、角色和 runtime 状态的权威来源。
- Pi native JSONL 或 ThinkThread 诊断 archive 是 worker 交互正文的权威来源。
- `CollaborationSessionBinding` 与 `CollaborationEvent` 是主从关系的显式证据；不得根据时间接近度或同名任务猜测关系。
- 查询投影不写回 `Execution.parentExecutionId`、`rootExecutionId` 或原始 Session。

## 当前 Goal Plus schema

每个可采集 worker 必须满足：

```json
{
  "agent_harness": "pi",
  "runtime_provider": "direct | thinkthread",
  "execution_scope": "native_root | thinkthread_private",
  "session_handle": { "...": "..." }
}
```

`agent_harness` 必须为 `pi`，`runtime_provider` 仅接受 `direct` 或 `thinkthread`；对应的 `execution_scope` 必须分别为 `native_root` 或 `thinkthread_private`，`session_handle` 中的 harness/provider 必须与当前 agent session 一致。缺字段、身份冲突或旧 `host` / `host_handle` 结构都产生 `unsupported_goal_plus_schema`，该 worker 不上传 Trace 或关系。

`direct` 从 `session_handle.metadata.session_file` 或受限的唯一 session 文件定位 native JSONL。`thinkthread` 从 `host-logs/session-diagnostics` 读取有索引的批次 archive；批次顺序、session 身份和 entry 数量都必须通过校验。所有路径均经过 realpath、根目录包含关系和普通文件检查。

Goal 主端仅接受 `goal.json.host_command_invocations` 中按稳定顺序选择的首个：

```json
{
  "agent_harness": "pi",
  "action": "start",
  "session_id": "<Pi native session id>"
}
```

没有该记录时 worker Trace仍可导入，但不会生成无法证明父级的关系。

## 主绑定

Pi collector 在 task settle 时检查本次真实 user query：

- 只接受 `/goal-plus` 和 `/goal-plus-with-final-check` 的 start 调用；
- `edit`、`summary`、`pause`、`resume`、`clear` 不产生绑定；
- `goal_plus_id` 只从 Goal Plus 工具的结构化 args/result，或转换后 prompt 中严格锚定的 `goal_plus_id: ...` 行读取；
- 普通自然语言里提到 ID 不得触发关联。

Pi 已有分段规则生成实际 taskId `<nativeSessionId>__taskN`。collector 为该 taskId 入队：

```json
{
  "collaborationId": "gp.<sha256-prefix>",
  "sessionId": "main",
  "traceSessionId": "<nativeSessionId>__taskN",
  "eventClock": "source_session"
}
```

`collaborationId` 由 `initialPiSessionId + NUL + goalPlusId` 确定性生成。使用 initial native session，而不是分段 taskId，使 Pi collector 与 `.gp` parser 能独立计算同一个协作 ID。

每个 start task 最多入队一次；同一 Pi session 后续再次运行 Goal Plus 会绑定到新的 `__taskN`，不会让历史任务覆盖当前主 Trace。

## worker Trace 与关系

worker canonical Trace session 固定为：

```text
goal-plus:<sourceId>:<agentSessionId>
```

native importer 复用 Pi 分类、脱敏、OTLP spool、增量 checkpoint 和 uploader。它保留 Agent、LLM、Tool、MCP、Skill、usage 与 runtime outcome；descriptor 或事件语义变化时只追加修订，不重放不变事件。

每个有效 worker 生成一个 session binding 和一个不可变关系事件。逻辑 worker session ID、event ID 均由 run 与 agent session 等稳定字段计算，不使用扫描时间。关系方向固定为 `main → worker`；`fromLocator` 指向主 Trace 中的 `goal_plus_session_run` 工具调用。服务端只能把它作为调用位置候选，不会仅凭时间接近度伪造精确锚点。

Trace 与关系上传顺序为：

1. 将 binding/event 原子写入关系 outbox；
2. 将 worker native events 写入 OTLP spool，并尝试上传；
3. 尝试 flush 关系 outbox。

关系可以先于或晚于 Trace 到达，服务端按显式 binding 延迟解析。提前持久化关系 outbox 可以避免进程在 Trace 上传后退出导致关系永久丢失。

## 关系 outbox

`scripts/agent-trace-collectors/shared/collaboration-transport.cjs` 被 Pi 与 Goal Plus collector 共用。状态目录按 framework 与 API Key 摘要隔离，并包含：

- `relationships/pending`：待上传的 binding/event；
- `relationships/delivered`：2xx 后的交付 tombstone；
- `relationships/rejected`：确定性拒绝或本地同 key 不同正文冲突。

同一逻辑 key 的规范正文不可覆盖。网络错误、429、5xx 使用有界指数退避并保留 pending；其他 4xx（包括 409）移入 rejected，不无限重试。单轮最多处理 20 条，避免关系 backlog 阻塞 Trace 扫描。`self-check` 在 rejected 非空时失败并报告数量。

## 代码地图

| 区域 | 职责 |
|-|-|
| `scripts/agent-trace-collectors/pi-agent/lib/pi-trace-core.cjs` | 识别 Goal Plus start task、计算实际 taskId、入队 main binding |
| `scripts/agent-trace-collectors/goal-plus/goal-plus-collector.cjs` | source 扫描、worker OTLP 导入、关系入队/上传、watcher/self-check |
| `goal-plus/lib/gp-snapshot-parser.cjs` | 校验当前 Goal Plus schema、发现 worker source、构造确定性关系 |
| `goal-plus/lib/pi-native-parser.cjs` | direct/ThinkThread Pi session → canonical Pi events |
| `shared/collaboration-transport.cjs` | 协作 ID、binding/event 构造与持久 outbox |
| `src/lib/collaboration/projection.ts` | 读取 reported 关系并生成通用 Trace 投影 |
| `src/lib/ingest/collaboration/*` | 既有 binding/event HTTP 契约、持久化与端点解析 |

## 安装与配置

Goal Plus bundle 包含 worker parser、Pi importer、source registry 和共享 collaboration transport，不再分发 `semantic-spool.cjs`。Pi bundle 也包含同一共享 transport。

Goal Plus managed config 保存：

- `otlpEndpoint`
- `collaborationSessionsEndpoint`
- `collaborationEventsEndpoint`

专属环境变量优先于 managed config，再回退到通用 base URL/API Key。对应变量为：

- `AGENT_INSIGHT_GOAL_PLUS_API_KEY`
- `AGENT_INSIGHT_GOAL_PLUS_BASE_URL`
- `AGENT_INSIGHT_GOAL_PLUS_OTLP_ENDPOINT`
- `AGENT_INSIGHT_GOAL_PLUS_COLLABORATION_SESSIONS_ENDPOINT`
- `AGENT_INSIGHT_GOAL_PLUS_COLLABORATION_EVENTS_ENDPOINT`
- `AGENT_INSIGHT_PI_COLLABORATION_SESSIONS_ENDPOINT`
- `AGENT_INSIGHT_PI_COLLABORATION_EVENTS_ENDPOINT`

watcher 指纹覆盖 collector 版本、凭证摘要和三个端点；任一变化都会受控重启。`start` 要求至少一个 attached source，`ensure` 对无 source 安静跳过，对 stale PID 恢复。Goal Plus watcher 失败不停止 Pi 原生 collector；结果是主 Trace 仍可见，但 worker 关系暂不可用。

## 查询与展示契约

服务端 reported collaboration 投影优先于历史 Goal Plus semantic projection。主、worker binding 均唯一解析后，`composeCollaborationTrace` 在主 Trace 的响应中追加 synthetic TASK 和 worker 交互副本；`full`、`structure`、`interactions` 与单条 interaction 读取必须使用同一确定性投影。

“仅主 Agent”列表可折叠已成功投影的 worker；“仅子 Agent”和混合范围仍可看到独立 worker。歧义、pending、缺失 Trace、跨用户或超过投影上限的 worker 不合并，也不隐藏。

## 测试重点

- 当前 schema direct 与 ThinkThread archive 都能生成稳定 worker Trace；
- 旧 schema 明确拒绝且无 fallback；
- Pi start task 与 `.gp` parser 计算相同 `collaborationId`；
- `/goal-plus resume` 和普通文本中的 Goal ID 不产生 main binding；
- 重复扫描不产生不同 binding/event 正文；
- 断网/5xx 可重试，409 进入 rejected；
- Goal Plus distribution 不包含 semantic spool，Pi/Goal Plus 都包含 collaboration transport；
- 最终查询结果是主 Trace 下包含 worker 子树，而不是重复导入一个 Goal Plus 主 Trace。
