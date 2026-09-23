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

Pi start 后自动确认并登记的 .gp
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
  └─ main Trace + each ready worker's synthetic TASK and interaction copies
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

Pi collector 在任务中检查本次真实 user query：

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

获得结构化 `goal_plus_id` 后，collector 将 main binding 写入持久关系 outbox，并立即异步尝试 flush，不等待 task settle。`settleAgent` 与 shutdown 仍会再次 flush，网络错误、429 或 5xx 保留 pending 后重试。这样 main binding 通常在长时间 Goal Plus 任务执行期间即可到达服务端，同时不让遥测网络请求阻塞 Pi 执行。

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

查询投影按 worker 独立判断可用性。main 与某个 worker 的 binding、Execution 和非空 Session 正文都已唯一解析后，该 worker 即可进入正在运行的主 Trace；同一 Goal Plus run 中尚未上报首批正文的其他 worker 只保持 pending，不会阻塞已就绪 worker。已声明但 pending 的 worker 仍从默认主列表隐藏，避免先独立展示、稍后再合并。通用非 Goal Plus collaboration 继续使用整组安全校验。

## 关系 outbox

`scripts/agent-trace-collectors/shared/collaboration-transport.cjs` 被 Pi 与 Goal Plus collector 共用。状态目录按 framework 与 API Key 摘要隔离，并包含：

- `relationships/pending`：待上传的 binding/event；
- `relationships/delivered`：2xx 后的交付 tombstone；
- `relationships/rejected`：确定性拒绝或本地同 key 不同正文冲突。

同一逻辑 key 的规范正文不可覆盖。网络错误、429、5xx 使用有界指数退避并保留 pending；其他 4xx（包括 409）移入 rejected，不无限重试。单轮最多处理 20 条，避免关系 backlog 阻塞 Trace 扫描。`self-check` 在 rejected 非空时失败并报告数量。

## 代码地图

| 区域 | 职责 |
|-|-|
| `scripts/agent-trace-collectors/pi-agent/lib/pi-trace-core.cjs` | 识别 Goal Plus start task、解析 runtime root、异步激活观察器、计算实际 taskId、入队 main binding |
| `scripts/agent-trace-collectors/goal-plus/goal-plus-collector.cjs` | 激活证据校验、source 扫描、worker OTLP 导入、关系入队/上传、watcher/self-check |
| `goal-plus/lib/source-registry.cjs` | canonical `.gp` 登记、自动 source 所有权与最近检测元数据 |
| `goal-plus/lib/gp-snapshot-parser.cjs` | 校验当前 Goal Plus schema、发现 worker source、构造确定性关系 |
| `goal-plus/lib/pi-native-parser.cjs` | direct/ThinkThread Pi session → canonical Pi events |
| `shared/collaboration-transport.cjs` | 协作 ID、binding/event 构造与持久 outbox |
| `src/lib/collaboration/projection.ts` | 读取 reported 关系并生成通用 Trace 投影 |
| `src/lib/ingest/collaboration/*` | 既有 binding/event HTTP 契约、持久化与端点解析 |

## 安装与配置

面向用户只有 Pi Agent 安装入口。Pi bundle 同时包含 Pi extension、worker parser、Pi passive importer、source registry 和共享 collaboration transport；安装时将观察器文件放到 `~/.agent-insight/collectors/goal-plus/`，但不登记 source、不扫描、不启动 watcher，也不创建 `goal-plus-collector` 命令 wrapper。独立 Goal Plus bundle/route 仅作为既有安装的兼容入口。

`frameworks=goal-plus` 是旧链接兼容别名：服务端和已下载脚本都将它去重映射为 `pi-agent`。安装页和交互选择器不再展示 Goal Plus framework，也不使用 `goalPlusHosts` 选择宿主。

观察器状态机为：

```text
DORMANT → DETECTING → ACTIVE
              └────→ DEGRADED
```

普通 Pi task 保持 `DORMANT`。Pi extension 只有在当前 start task 获得结构化 `goal-plus-created` / `goal-plus-command-context` 或 Goal Plus tool result 中的 `goal_plus_id` 后才排队激活。失败会写入本地 `runtime/activation.json` 并进入 `DEGRADED`，但不会阻塞 Pi task、主 Trace flush 或后续幂等重试。

runtime root 必须与 Goal Plus 现有行为一致：`GOAL_PLUS_ROOT` 为绝对路径时直接使用；为相对路径时相对 `ctx.cwd`；未设置时使用 `ctx.cwd/.gp`。不得递归扫描 home。激活必须同时验证：

- root 是真实且非 symlink 的 `.gp` 目录；
- `.gp/goal-plus/<goalId>/goal.json` 是普通文件且正文 ID 匹配；
- `host_command_invocations` 存在 `agent_harness=pi`、`action=start`、`session_id=<当前 Pi native session>`。

校验通过后，`activate` 原子地执行幂等 source 登记、首次 scan 和 watcher ensure。自动 source 标记 `managedBy=pi-agent-auto-detect`，记录最近的 goal/native session；collector 只写 Agent Insight registry、checkpoint、outbox 和 spool，不写 `.gp`。

Goal Plus managed config 保存：

- `apiKey`（必须与 Pi managed config 一致）
- `otlpEndpoint`
- `collaborationSessionsEndpoint`
- `collaborationEventsEndpoint`

API Key 只读取安装器写入的 managed config，不接受运行时通用变量或 Goal Plus 专属变量覆盖。端点仍可使用以下专属变量覆盖：

- `AGENT_INSIGHT_GOAL_PLUS_BASE_URL`
- `AGENT_INSIGHT_GOAL_PLUS_OTLP_ENDPOINT`
- `AGENT_INSIGHT_GOAL_PLUS_COLLABORATION_SESSIONS_ENDPOINT`
- `AGENT_INSIGHT_GOAL_PLUS_COLLABORATION_EVENTS_ENDPOINT`
- `AGENT_INSIGHT_PI_COLLABORATION_SESSIONS_ENDPOINT`
- `AGENT_INSIGHT_PI_COLLABORATION_EVENTS_ENDPOINT`

watcher 指纹覆盖 collector 版本、凭证摘要和三个端点；任一变化都会受控重启。`start` 要求至少一个 attached source，`ensure` 对无 source 安静跳过，对 stale PID 恢复。Goal Plus watcher 失败不停止 Pi 原生 collector；结果是主 Trace 仍可见，但 worker 关系暂不可用。

Pi 安装器以当前 Pi API Key、OTLP 端点和两个 collaboration 端点无条件覆盖 Goal Plus managed config，不兼容或保留旧版、手工配置及其他账号的 collector 身份。写入前停止已有 watcher，写入后对已有 source 执行 `ensure`，因此新进程不会继续持有旧账号。Pi runtime 激活观察器时还会比较两份 managed API Key；不一致时先停止 watcher 再 fail closed，禁止跨用户上传 worker Trace。Pi 卸载会停止 `managedBy=pi-agent` 的 watcher，并默认保留 source registry 与 spool。

## 查询与展示契约

服务端 reported collaboration 投影优先于历史 Goal Plus semantic projection。投影分成两个读时集合：

- `hiddenChildren`：`gp.<hash>` 协作中已有 `main → worker:*` 事件且 worker binding 已知的 Trace。默认“仅主 Agent”列表在数据库分页与计数前排除这些 worker，不要求 main binding 已到达。
- `links`：主、worker binding、Execution 和 Session 正文均可唯一、安全解析的主从边。只有这些边会由 `composeCollaborationTrace` 在主 Trace 响应中追加 synthetic TASK 和 worker 交互副本。

“仅子 Agent”和混合范围仍可看到独立 worker。主端 pending、缺失 Trace 或歧义不会让 worker 回退为默认主列表记录，也不会提前合并；跨用户、非 Goal Plus reported 关系和超过安全投影上限的情况继续 fail open，保留原列表。`full`、`structure`、`interactions` 与单条 interaction 读取必须使用同一确定性 `links` 投影。

## 测试重点

- 当前 schema direct 与 ThinkThread archive 都能生成稳定 worker Trace；
- 旧 schema 明确拒绝且无 fallback；
- Pi start task 与 `.gp` parser 计算相同 `collaborationId`；
- `/goal-plus resume` 和普通文本中的 Goal ID 不产生 main binding；
- 普通 Pi task 不激活观察器，结构化 start 证据只激活一次；
- runtime root 遵循 `GOAL_PLUS_ROOT`/`ctx.cwd` 解析且不扫描 home；
- goal/session 归属不匹配时不 attach、不 scan、不启动 watcher；
- 重复扫描不产生不同 binding/event 正文；
- 断网/5xx 可重试，409 进入 rejected；
- Pi distribution 自包含休眠观察器；旧 Goal Plus distribution 继续可用且两者都包含 collaboration transport；
- Pi 安装会覆盖不同账号的 Goal Plus 配置、同步主/worker 端点，并在 runtime 身份不一致时 fail closed；
- 最终查询结果是主 Trace 下包含 worker 子树，而不是重复导入一个 Goal Plus 主 Trace。
