# Codex App Server 与 Desktop Trace 升级方案

## 0. 文档信息

| 字段 | 值 |
| --- | --- |
| 状态 | Accepted design；本地候选已实现阶段 0-5，正式跨机发布门仍待完成 |
| 创建时间 | 2026-08-16 |
| 适用范围 | Codex CLI、Codex App Server、Codex Desktop、Codex IDE Extension |
| 前置设计 | [Codex CLI 与 IDE Extension Trace 采集器方案](../issue-159-codex-trace-collectors.md) |
| 官方协议 | [OpenAI Codex App Server](https://developers.openai.com/codex/app-server) |
| 对应 issue | 待补 |

本文把现有 Codex Hooks + OTel 采集器升级为能够正确识别 App Server 与 Desktop
生命周期的统一采集链。方案重点解决三个问题：

1. steer 到底属于同一 turn 内的阶段变化，还是中断旧任务后启动的新任务；
2. 同一套 Codex runtime 中如何区分 CLI、Desktop、IDE、App Server 与 Subagent；
3. compaction 如何进入会话时间线，但不伪装成用户任务、Tool 或 LLM。

本文是单文件设计，按需求分析、需求设计和开发计划三个阶段组织。设计边界与实现契约保持在同一份
文档中；本地候选的实际完成度、测试结果和未完成发布门见文末“实现与验收快照”。

---

## 1. 结论摘要

本次升级采用“多入口、单语义核心、双层时间线”的方案：

```text
Codex CLI Hooks + native OTel ---------+
                                        |
App Server JSON-RPC proxy -------------+--> Codex lifecycle reducer
                                        |       |
Codex Desktop rollout reader -----------+       +--> Execution timeline
                                                +--> Thread timeline
                                                        |
                                                        v
                                    durable spool -> Codex Adapter -> storage/UI
```

核心决策如下：

- `thread/session` 只负责关联，不能直接作为一次用户执行的主键；
- `Execution` 代表一次真实用户 task/turn，优先使用来源提供的稳定 turn/task id；
- 官方 `turn/steer` 在同一个 active turn 中追加输入，不创建新 turn，因此表现为同一
  `Execution` 内的新阶段；
- Desktop UI 如果实际执行 `interrupt + new task`，则必须产生两个 `Execution`，前者状态为
  `interrupted`，两者之间由 thread transition 关联；
- 后续 prompt 永远不能覆盖首个用户目标；所有用户输入以有序 input history 保存；
- compaction 是 thread 维护事件，不进入用户任务列表，不增加用户任务的 Tool/LLM/Token，
  也不延长前后任务的 latency；
- App Server 是协议服务，不等同于 Desktop。自建 `codex app-server` 只能可靠观察经过该连接的
  请求，既有 Desktop 会话需要独立的只读 rollout 入口；
- Desktop rollout 解析默认关闭、显式启用、默认只采集启用后的增量数据，不自动回填全部历史；
- 所有入口先规范化为统一 lifecycle event，再进入同一状态机，禁止三套采集路径各自定义 task
  边界和去重规则。

---

# Phase 1：需求分析

## 2. 当前实现

现有 Codex 采集链已具备以下能力：

- 11 类 lifecycle Hook 采集 Session、Prompt、Tool、Subagent、Stop 与 Compact 信号；
- 原生 OTel 补充模型、Token、TTFT、API 和 Tool 指标；
- `CodexTraceCore` 按 session + turn 聚合 Hook/OTel，写入 durable JSONL spool；
- Codex Adapter 按最新 span snapshot 聚合为 `ExecutionRecord`；
- Trace UI 从 `Session.interactions` 还原 Agent、Skill、Tool、LLM 与 Subagent 调用树；
- relay 已具备 checkpoint、锁、重试、状态持久化与 snapshot replace。

相关实现入口：

- `scripts/agent-trace-collectors/codex/codex-trace-core.cjs`
- `scripts/agent-trace-collectors/codex/relay.cjs`
- `src/lib/ingest/otel/adapters/codex.ts`
- `src/lib/storage/data-service.ts`
- `src/lib/engine/observability/agent-trace.ts`
- `src/components/observe/AgentTraceView.tsx`

当前设计以 CLI Hook + OTel 为主。App Server JSON-RPC、Desktop rollout、执行中 steer 阶段、
跨 Execution 的中断关系和 thread 级 compaction 尚未进入统一模型。

## 3. 已确认的问题

### 3.1 后续输入会丢失原始语义

当前 `promptTurn()` 在 turn 已存在时会更新 `turn.input`。如果同一 turn 后续收到新的用户输入，
采集器只能得到一个不断变化的 root snapshot，无法同时保留：

- 首个用户目标；
- steer 输入；
- steer 接受时刻；
- steer 前后的 LLM/Tool 归属；
- steer 是同 turn 重定向，还是 interrupt 后的新 task。

服务端目前使用第一条可见 root input 作为 `Execution.query`，但 interactions 中重复 root snapshot
仍可能形成错误的用户消息展示。设计上需要同时保证 query 不可覆盖和 input history 完整。

### 3.2 OTel 缺少 turn id 时会合成执行边界

真实 Desktop 样本中的 `codex.user_prompt`、`codex.sse_event` 和部分 Tool OTel 事件没有
`turn.id`。现有 relay 会在只有一个 active turn 时关联，否则按时间生成稳定 hash 作为 fallback
turn id。

这能避免数据完全丢失，但会造成以下问题：

- 合成 id 无法与 Desktop rollout 中的原始 `task_started.turn_id` 对齐；
- `turn_aborted` 无法精确关闭 Agent Insight 中对应的 Execution；
- compaction maintenance task 无法与前后用户 task 建立 thread 关系；
- Hook、OTel、App Server 与 rollout 可能把同一逻辑执行写成不同 id；
- 依靠“唯一 active turn”恢复关联时，并发或进程恢复场景存在歧义。

### 3.3 来源维度混在一起

本机实际样本中存在以下组合：

| `originator` | `source` | 实际产品 |
| --- | --- | --- |
| `Codex Desktop` | `vscode` | Codex Desktop |
| `Codex Desktop` | `exec` | Codex Desktop |
| `codex_tui` | `cli` | Codex CLI TUI |
| `codex_exec` | `exec` | Codex CLI exec |
| `codex_vscode` | `vscode` | Codex IDE Extension |

因此不能用 `source=exec` 判定 CLI，也不能用 `source=vscode` 判定 IDE。`originator` 是产品来源的
主要证据，`source` 只代表入口/传输形态；`thread_source=subagent` 又是执行角色，不是产品来源。

### 3.4 compaction 被夹在用户任务生命周期中

真实 Desktop 样本包含如下脱敏时序：

```text
T+00s  user task A started
T+02s  user message recorded
T+05s  task A aborted, reason=interrupted
T+14s  maintenance task B started, no user message
T+78s  compacted + context_compacted
T+79s  maintenance task B completed, duration about 65s
T+80s  user task C started
T+82s  user message recorded
```

该样本说明：

- Desktop 的压缩可以由一个没有用户输入的 maintenance task 承载；
- 高保真 `compacted` 记录包含 window identity，兼容事件 `context_compacted` 不含 turn id；
- 压缩发生在两个用户任务之间，不能归入 A 或 C；
- A 的正确终态是 `interrupted`，而不是成功、运行中或被 C 覆盖；
- 如果只看 OTel，maintenance task 和原始 Desktop turn id 均不可见。

### 3.5 Trace UI 缺少执行阶段与 thread 上下文

当前 UI 以单个 `Execution` 的 interactions 建树。一个用户节点之后的所有 LLM/Tool 会被平铺在
同一 Agent 时间线，无法表达：

- steer 前阶段已被取代；
- steer 后阶段继承同一 turn；
- 前一个 Execution 被中断，当前 Execution 是其后续；
- 两个 Execution 之间发生了 compaction；
- compaction 消耗了维护时间，但不属于任何用户任务 latency。

## 4. 官方协议事实

以下事实来自 OpenAI 官方 App Server 文档，协议实现必须以运行时生成 schema 为准：

- `turn/start` 创建并启动一个新 turn；
- `turn/steer` 向 active turn 追加用户输入，要求 `expectedTurnId` 与 active turn 匹配；
- 成功的 `turn/steer` 返回同一 `turnId`，不发送新的 `turn/started`；
- `turn/interrupt` 成功后，turn 以 `interrupted` 状态结束；
- `thread/compact/start` 立即返回，进度通过普通 `turn/*` 和 `item/*` 通知发送；
- 当前权威压缩信号为 `contextCompaction` item 的 started/completed 生命周期；
- 旧的 `thread/compacted` notification 已弃用，但兼容解析仍需保留；
- schema 可由安装的 CLI 通过 `codex app-server generate-json-schema` 生成，生成结果与具体 CLI
  版本一致。

本机验证过的 CLI schema 同时包含 `contextCompaction` 和旧 `thread/compacted`。该观察只作为
兼容性证据，不构成版本上限或长期协议承诺。

## 5. 术语与边界

| 概念 | 定义 | 不等同于 |
| --- | --- | --- |
| Thread | Codex 对话及其持久化历史 | 单次用户任务 |
| Session tree | 根 thread 与 fork/subagent 的关联树 | Execution |
| Execution | 一次真实用户 task/turn | 整个 thread |
| Phase | 同一 Execution 内由 initial input 或 steer 划分的阶段 | 新 Execution |
| Execution input | initial、steer 或未知 follow-up 用户输入 | Tool/LLM |
| Transition | 两个 Execution 之间的中断、延续或重定向关系 | Subagent parent |
| Thread event | compaction 等 thread 级维护事件 | 用户任务 |
| Source kind | CLI、Desktop、IDE、App Server 等产品来源 | Agent 名或 subagent role |

## 6. 目标

### 6.1 功能目标

1. 在不破坏现有 CLI Hooks + OTel 的前提下接入 App Server JSON-RPC 和 Desktop rollout；
2. 用来源提供的 thread/turn/task id 建立稳定 Execution；
3. 完整保存 initial input 与 steer history，query 永远代表首个用户目标；
4. 正确区分同 turn steer 与 interrupt + new task；
5. 正确落库 `completed`、`interrupted`、`failed` 与 `in_progress`；
6. 将 compaction 保存为 thread event，并在 Trace 详情展示；
7. 让 Tool、LLM、Skill、Subagent 按 Execution phase 正确归属；
8. 在双通道、重启、乱序、重放和版本升级下保持幂等；
9. 保留 CLI、IDE 与已有 Codex Adapter 行为，不改变其他框架。

### 6.2 非目标

- 不把 Agent Insight 变成新的 Codex Desktop 客户端；
- 不通过进程注入、内存读取或闭源 Desktop 私有 IPC 监听现有 UI；
- 不上传完整 rollout 文件、base instructions、developer/system prompt 或原始 reasoning；
- 不为缺失 Token 伪造 0 或字符估算值；
- 不把 compaction 伪装成 Tool、LLM、Skill 或根 Agent；
- 不为无法证明的 interrupt 原因强行标记为 steer；
- 不修改其他框架的 snapshot、去重和 Session merge 语义。

## 7. 关键不变量

1. 一个用户 task 对应一个 Execution；session 只能做关联键。
2. `Execution.query` 创建后不可被后续输入覆盖。
3. 同一个 source turn id 的正式 `turn/steer` 不创建第二个 Execution。
4. `turn_aborted` 或 `turn/completed(status=interrupted)` 必须关闭对应 Execution。
5. interrupt 后新的 source turn/task id 必须创建新 Execution。
6. 没有用户输入的 compaction maintenance task 不创建 Execution。
7. compaction 不进入用户 Token、Tool、LLM、Skill、Subagent 与 latency 汇总。
8. 事件归属优先使用直接 id；候选不唯一时进入 pending，不做宽松时间猜测。
9. source kind、Agent identity、Subagent role 分层保存。
10. 同一逻辑事件在 Hook、OTel、App Server、rollout 中重放任意次数，结果不变。
11. Desktop rollout 只读、增量、allowlist 解析；未知记录不能进入 Generic fallback。
12. 失败或未识别数据必须保留在 durable 边界，不得静默推进不可恢复的 checkpoint。

---

# Phase 2：需求设计

## 8. 总体架构

```text
                         +---------------------------+
                         | Codex App Server protocol |
                         | request/response/events   |
                         +-------------+-------------+
                                       |
                             app-server-proxy.cjs
                                       |
+------------------+          +--------v---------+          +-------------------+
| Hooks + OTel     +----------> ingress adapters +----------> lifecycle reducer |
| existing runtime |          +--------^---------+          +---------+---------+
+------------------+                   |                              |
                              rollout-reader.cjs                      |
                                       |                              |
                         +-------------+-------------+                |
                         | ~/.codex/sessions/*.jsonl |                |
                         +---------------------------+                |
                                                                      v
                         +----------------------+      +--------------------------+
                         | thread lifecycle     |      | execution/span snapshots |
                         | durable state/events |      | existing canonical spool |
                         +----------+-----------+      +-------------+------------+
                                    |                                |
                                    +---------------+----------------+
                                                    v
                                         Codex server Adapter
                                                    |
                          +-------------------------+-------------------------+
                          |                                                   |
                          v                                                   v
                  Execution + Session                              TraceThread + events
                          |                                                   |
                          +-------------------------+-------------------------+
                                                    v
                                         Trace details and timeline
```

### 8.1 单语义核心

`codex-trace-core.cjs` 继续作为规范状态机，不再直接把每种原始输入解释为 root span。新增三个薄
入口适配器：

- Hook/OTel ingress：保留现有事件解析，输出统一 lifecycle event；
- App Server ingress：记录 JSON-RPC request/response/notification，只有请求成功后提交状态；
- Desktop rollout ingress：只读 tailer，按文件顺序解析允许的持久化记录。

入口适配器不能直接写 `ExecutionRecord`。所有 task、phase、transition、compaction 与 alias 决策
必须经过同一个 reducer。

## 9. 统一事件契约

collector 内部新增逻辑契约 `CodexLifecycleEvent`。具体实现可使用 JSDoc 或 TypeScript 类型，字段
语义如下：

```typescript
type CodexLifecycleEvent = {
  eventId: string
  eventType:
    | 'thread_started'
    | 'execution_started'
    | 'user_input_accepted'
    | 'execution_interrupted'
    | 'execution_completed'
    | 'context_compaction_started'
    | 'context_compaction_completed'
    | 'tool_started'
    | 'tool_completed'
    | 'llm_completed'
    | 'subagent_started'
    | 'subagent_completed'
  source: 'hook' | 'otel' | 'app_server' | 'desktop_rollout'
  sourceKind: 'cli' | 'desktop' | 'ide' | 'app_server' | 'unknown'
  sourceThreadId: string
  sourceExecutionId?: string
  sourceItemId?: string
  clientMessageId?: string
  timestampMs: number
  sequence?: number
  inputKind?: 'initial' | 'steer' | 'follow_up_unknown'
  status?: 'in_progress' | 'completed' | 'interrupted' | 'failed'
  payload?: Record<string, unknown>
  provenance: {
    direct: boolean
    confidence: 'direct' | 'correlated' | 'pending'
    protocolVersion?: string
  }
}
```

事件进入 durable spool 前完成结构化脱敏。原始 Desktop rollout 行不复制到 Agent Insight spool。

## 10. 来源识别

### 10.1 分类规则

来源分类使用以下优先级：

1. App Server `initialize.clientInfo` 或 collector 自身 client id；
2. rollout `session_meta.originator`；
3. OTel `originator` / `codex.originator`；
4. 已知安装 owner 与 terminal marker；
5. `source` 只作辅助证据；
6. 无可靠证据时为 `unknown`。

推荐初始映射：

| 原始证据 | `sourceKind` |
| --- | --- |
| `Codex Desktop` | `desktop` |
| `codex_tui`、`codex_exec` | `cli` |
| `codex_vscode` | `ide` |
| Agent Insight 自有 App Server client name | `app_server` |
| 未知或冲突 | `unknown` |

`thread_source=subagent`、forked thread 和 `subagent` origin 只改变 Agent/Execution 层级，不覆盖
产品来源。每条 canonical event 同时保留原始 `originator`、`source`、`threadSource` 和
`protocolVersion`，便于未来重新分类。

### 10.2 冲突处理

- `originator=Codex Desktop, source=exec` 仍归 Desktop；
- App Server client 明确声明 `clientInfo.name=agent_insight` 时归 App Server，不继承 Desktop；
- 同一 source thread 的不同 fork 可以保留不同 runtime source，但共享 root session id；
- 冲突证据不做多数投票，保留 `unknown` 并记录诊断计数。

## 11. Execution identity 与 alias

### 11.1 主键策略

新执行的 canonical id 使用来源稳定 id：

```text
codex:<sourceThreadId>:turn:<sourceExecutionId>
```

其中：

- App Server：`thread.sessionId` + `turn.id`；
- Desktop rollout：`session_meta.id/session_id` + `task_started.turn_id`；
- CLI Hook：Hook `session_id` + `turn_id`；
- OTel：直接 `conversation.id` + `turn.id`；
- OTel 缺 turn id 时不立刻创建可见 root，先尝试 alias，再进入 pending。

### 11.2 关联优先级

同一逻辑执行的多源关联按以下顺序：

1. 完全相同的 source thread + source execution id；
2. App Server request id / accepted turn id；
3. client message id；
4. Hook call id、Tool call id 或 fork session id；
5. 同一 thread 中唯一 active rollout task；
6. 输入 HMAC、顺序、时间和来源同时一致且候选唯一；
7. pending，不猜测。

第 6 项只用于跨 Hook/OTel 的已知双通道兼容，不能单独依据相近时间合并两个并发 task。

### 11.3 历史合成 id

已经落库的 Execution id 不自动重写。升级后的 reconciliation 只在证据唯一时为旧记录补充
`sourceExecutionId` 与 thread 关联，保留原 id、评测、标签和外部引用。

## 12. steer 状态机

### 12.1 官方协议级 steer

App Server proxy 同时观察客户端请求与服务端响应：

```text
turn/start request
  -> success response(turn.id)
  -> Execution E, phase 0(initial)

turn/steer request(expectedTurnId=E)
  -> success response(turnId=E)
  -> close/supersede current phase
  -> phase 1(steer), same Execution E
```

约束：

- 只在服务端成功响应后记录 steer；
- 请求失败、expectedTurnId 不匹配或 active turn 不存在时不写 input；
- steer 不发新 `turn/started`，不能依赖 notification 单向流捕获；
- steer 不修改 model、cwd、sandbox 或 output schema；
- `Execution.query` 始终保持 phase 0 的 initial input；
- steer 输入作为独立 user interaction 保存，带 `input_kind=steer`、`phase_id`、
  `client_message_id` 与 accepted timestamp；
- phase 切换不创建假 Tool、假 LLM 或假 Agent。

### 12.2 Desktop UI 的 interrupt + new task

Desktop UI 中被用户称为“引导”的动作不一定调用官方 `turn/steer`。真实 rollout 如果表现为：

```text
task A -> turn_aborted(reason=interrupted)
task B -> user_message
```

则必须输出：

```text
Execution A: interrupted
Thread transition: A -> B
Execution B: in_progress/completed
```

如果 App Server request ledger 或未来 Desktop 元数据直接说明原因是 steer，transition kind 为
`steered_to_new_execution`，confidence 为 `direct`。如果只有相邻的 interrupt 与新 task，kind 为
`interrupt_followed_by_execution`，不能擅自写成 steer。

### 12.3 phase 归属

- App Server item 按 `item/started` 时的 active phase 归属，completion 不改变既有 phase；
- Tool/LLM 有稳定 call/item id 时沿用 start 时的 phase；
- 只有 completion 的 OTel 事件使用其已关联 call/response id；
- 没有直接 id 且跨越 steer 边界的事件保持 `phase_id=null`，不把它猜到后一个阶段；
- Execution latency 覆盖整个 turn；phase latency 分别计算，但不重复计入 Execution 总时长。

## 13. Execution input 契约

`Session.interactions` 中的用户输入扩展为：

```json
{
  "role": "user",
  "content": "...",
  "timestamp": "...",
  "turn_id": "...",
  "input_kind": "initial",
  "input_index": 0,
  "phase_id": "phase-0",
  "client_message_id": "...",
  "source": "desktop_rollout"
}
```

后续 steer 使用 `input_kind=steer`，不覆盖 index 0。未知来源的同 turn 追加输入使用
`follow_up_unknown`，在 UI 中显示为“后续用户输入”，不能假标为 steer。

Adapter 生成 `Execution.query` 时只选择 `input_kind=initial` 的第一条非空内容。旧数据没有
`input_kind` 时沿用第一条用户内容作为兼容行为。

## 14. interrupt 与状态

Execution 新增明确状态：

| 原始信号 | Execution 状态 |
| --- | --- |
| task/turn started | `in_progress` |
| task complete / turn completed | `completed` |
| turn aborted reason=interrupted | `interrupted` |
| turn completed status=interrupted | `interrupted` |
| turn failed / error terminal | `failed` |
| relay 恢复后无终态 | `in_progress`，直到超时诊断，不伪造 completed |

状态更新单调：terminal 不能被较早的 running snapshot 覆盖；只有同一来源更权威的后续终态可以
将 `in_progress` 收口。`interrupted` 与 `failed` 不因下一个 task 开始而改成 completed。

## 15. compaction 状态机

### 15.1 App Server

主信号为 `contextCompaction` item：

```text
item/started(contextCompaction, item.id)
  -> ThreadEvent status=running

item/completed(contextCompaction, same item.id)
  -> same ThreadEvent status=completed
```

旧 `thread/compacted` notification 仅作兼容，若与同一 thread/turn 的 contextCompaction 重复，
合并到同一 ThreadEvent。

### 15.2 Desktop rollout

真实 rollout 中：

- `compacted` 是权威记录，包含 `window_id`、`previous_window_id`、`first_window_id`、
  `window_number` 和 replacement history；
- `event_msg/context_compacted` 是低信息兼容通知，没有稳定 id；
- 两者相邻且时间一致时，以 `compacted.window_id` 作为 event key，兼容通知不再创建第二条事件。

### 15.3 maintenance task

rollout reader 在 `task_started` 时先创建候选 task，不立即生成可见 Execution：

- 后续出现 `user_message`：提升为用户 Execution；
- 后续出现 compaction，且此前没有 user message：标记为 maintenance task；
- maintenance task 的 started/completed 时间用于 ThreadEvent duration；
- maintenance task 内如果存在明确的模型 usage，保存为 `maintenanceUsage`，但不进入前后
  Execution 的 Token、LLM count 或费用；
- 未识别的无用户 task 保持 pending，不进入 Generic Adapter。

### 15.4 latency

```text
Execution A latency = A.started -> A.interrupted
Compaction duration = maintenance.started -> maintenance.completed
Execution C latency = C.started -> C.completed
```

thread 时间线可以展示三段墙钟时间，但 Execution A/C 的耗时、Token 和占比各自独立。

## 16. 数据模型

### 16.1 Execution 扩展

建议为现有 `Execution` 增加：

```prisma
traceThreadId     String?
sourceExecutionId String?
sourceKind         String?
executionStatus    String?
```

说明：

- `traceThreadId` 关联通用 TraceThread；
- `sourceExecutionId` 保存 App Server turn id、Desktop task id 或 Hook turn id；
- `sourceKind` 用于列表筛选与来源展示；
- `executionStatus` 使用 `in_progress/completed/interrupted/failed`；
- input history 继续存入 `Session.interactions`，避免为每条 user input 创建额外 Prisma 行；
- `query` 与 `Session.query` 只保存 initial input 的稳定快照。

### 16.2 TraceThread

新增框架无关的 thread 实体，避免把 Codex 专属字段写进通用 Execution JSON：

```prisma
model TraceThread {
  id             String   @id @default(cuid())
  framework      String
  sourceThreadId String
  sourceKind     String?
  user           String
  startedAt      DateTime?
  updatedAt      DateTime?
  metadataJson   String?

  executions Execution[]
  events     TraceThreadEvent[]

  @@unique([user, framework, sourceThreadId])
  @@index([user, framework, updatedAt])
}
```

`sourceThreadId` 保存 `thread.sessionId` 或 rollout root session id，不能从文件路径推导。

### 16.3 TraceThreadEvent

```prisma
model TraceThreadEvent {
  id                 String   @id @default(cuid())
  eventKey           String   @unique
  traceThreadId      String
  executionId        String?
  relatedExecutionId String?
  kind               String
  status             String?
  sourceTurnId       String?
  phaseId            String?
  startedAt          DateTime
  completedAt        DateTime?
  payloadJson        String?

  thread TraceThread @relation(fields: [traceThreadId], references: [id], onDelete: Cascade)

  @@index([traceThreadId, startedAt])
  @@index([executionId, startedAt])
}
```

初始 kind：

- `execution_transition`
- `context_compaction`
- `input_steer`
- `interrupt`

`payloadJson` 只保存已经脱敏的协议元数据、来源和 confidence；大段正文仍由 Session interaction
承载。

## 17. Adapter 聚合

Codex Adapter 执行顺序调整为：

1. 选择 Codex Adapter；
2. latest snapshot 与 Hook/OTel Tool logical dedupe；
3. 应用 source execution alias；
4. 按 Execution 切分事件；
5. 构造有序 input/phase interactions；
6. 聚合本 Execution 的 Agent、LLM、Tool、Skill 与 Subagent；
7. 计算 Execution 状态、latency 和 usage；
8. 将 thread events 交给 thread persistence，不混入 root span；
9. snapshot replace 更新 Execution 与 Session；
10. 只有明确已消费的 maintenance/thread event 才允许推进 consumer checkpoint。

Query 选择顺序：

1. `input_kind=initial`；
2. 旧格式第一条 user interaction；
3. 明确 root agent input；
4. 有意义的 Tool/LLM fallback；
5. 纯生命周期返回 null，不创建 `Codex execution` 假任务。

## 18. App Server proxy

新增 `app-server-proxy.cjs`：

- 启动或连接受 Agent Insight 管理的 `codex app-server --stdio`；
- 透明转发 stdin/stdout JSON-RPC，不修改业务 payload；
- 对每个 request id 保存 method、threadId、expectedTurnId 与输入摘要；
- 收到 response 后才提交成功的 turn/start、turn/steer 或 interrupt；
- 订阅 turn/item notification，补充 Tool、FileChange、MCP、AgentMessage、Compaction；
- 协议错误、未知 notification 记录诊断计数，不阻断 Codex；
- 只观察经过该 proxy 的连接，不宣称可监听既有 Desktop 私有连接。

安装时通过运行中 CLI 生成 schema 或执行能力探测。最低版本使用“需要的方法和字段均存在”作为
门槛，不设置臆造的最高版本。

## 19. Desktop rollout reader

### 19.1 启用策略

- 默认 `captureDesktopRollouts=false`；
- 用户显式启用后，默认从当前文件末尾开始；
- `historyBackfill=off` 为默认值；
- 后续可提供显式、限时、限文件数的 backfill 命令；
- reader 只读，不修改、移动、归档或锁定 Codex 文件。

### 19.2 allowlist

初始允许解析：

- `session_meta` 中的 id、originator、source、thread_source、CLI version 与已脱敏 cwd；
- `event_msg/task_started`、`task_complete`、`turn_aborted`；
- `event_msg/user_message`；
- `compacted`、`event_msg/context_compacted`；
- 已验证结构的 Tool、Subagent、AgentMessage 与 Token 记录。

明确不上传：

- base instructions；
- developer/system message；
- 原始 reasoning 正文；
- environment context 与完整 workspace inventory；
- 未知 record 的完整 payload；
- 本机绝对路径、凭据、token、secret 和 account identity。

### 19.3 checkpoint

每个 rollout 保存：

- 规范化路径摘要；
- session id；
- 文件创建/首行身份摘要；
- 已确认完整 JSONL 行的 byte offset；
- 最后 record sequence/hash；
- 文件是否已转入 archived sessions。

断尾时不推进最后半行；文件增长后从原 offset 继续。文件移动到 archived 目录时通过 session id
与首行摘要续接，不把同一文件重放成新 session。解析成功并写入 canonical durable spool 后才推进
rollout checkpoint，网络上传由现有 uploader checkpoint 独立控制。

## 20. relay 状态

relay state 新增：

- source thread -> TraceThread alias；
- source execution -> canonical Execution alias；
- App Server pending request ledger；
- active task 与 active phase；
- maintenance task candidate；
- compaction window/item dedupe；
- rollout checkpoint 与 unknown record counters。

active task 不因普通 retention 自动过期。terminal alias 至少保留到 canonical spool 全部确认，并设置
有界清理。relay 重启后先恢复 state，再重放 raw/canonical spool，结果必须与未重启一致。

## 21. API 与 UI

### 21.1 API

扩展 `/api/observe/session?taskId=...` 的 full/structure 返回：

```json
{
  "execution": {
    "status": "interrupted",
    "sourceKind": "desktop",
    "sourceExecutionId": "..."
  },
  "thread": {
    "id": "...",
    "sourceKind": "desktop",
    "previousExecutionId": "...",
    "nextExecutionId": "...",
    "events": []
  },
  "interactions": []
}
```

structure view 只返回 thread event 结构和输入 preview；完整 payload 仍按现有 interaction lazy load
模式读取。所有查询按 user 隔离，不能仅凭 sourceThreadId 跨用户读取。

### 21.2 Trace 列表

- 来源筛选增加 CLI、Desktop、IDE、App Server；
- status 显示 completed、interrupted、failed、in progress；
- compaction 不出现在主列表；
- transition 不增加任务数。

### 21.3 Trace 详情

同 turn steer：

```text
USER  Initial request
  phase 0 LLM/Tool...
STEER  Follow-up guidance
  phase 1 LLM/Tool...
```

interrupt + new task：

```text
[Previous task interrupted] -> [Current task]
```

该提示支持点击前后 Execution。只有直接证据时显示“由 steer 重定向”；推断证据显示“前一任务中断
后继续”，避免误导。

thread 事件：

```text
Task A interrupted
Context compacted (65s maintenance)
Task C started
```

compaction 行可显示时间、来源、window number 和维护 duration；默认不展示摘要正文和 replacement
history 内容。

## 22. 指标口径

### 22.1 Execution

- Tool、LLM、Skill、Subagent 只统计属于该 Execution 的事件；
- 同 turn steer 的所有 phase 汇总为一个 Execution 指标；
- interrupt + new task 分成两个 Execution，指标互不覆盖；
- interrupted Execution 保留已经发生的 Token、Tool 与 latency；
- final result 缺失保持空，不用后续 Execution 的输出补齐。

### 22.2 compaction

- maintenance Token 仅进入 `TraceThreadEvent.payloadJson.maintenanceUsage`；
- 不计入前后 Execution tokens、llmCallCount、cost 或 maxSingleCallTokens；
- thread 级统计可单独汇总 maintenance usage，但必须明确标注；
- 缺失 usage 保持 null，不能填 0。

### 22.3 时间

- Execution latency 使用 source task/turn 的真实边界；
- phase duration 是 Execution 内部诊断指标；
- compaction duration 是 thread maintenance 指标；
- session/thread 总墙钟时间不得替代 Execution latency。

## 23. 安装与配置

保留现有框架值 `codex`，不新增、重命名或重排中央框架列表。Codex 安装流程增加子能力：

| 能力 | 默认 | 说明 |
| --- | --- | --- |
| Hooks + OTel | enabled | 现有 CLI/IDE 链路 |
| App Server proxy | disabled | 仅观察通过该 proxy 的 client |
| Desktop rollout reader | disabled | 用户显式授权后增量读取 |
| Desktop history backfill | off | 首版不自动回填历史 |
| Thread timeline UI | feature flag | 与服务端 schema/API 同步上线 |

安装器、自检、卸载与重装必须同步覆盖：

- `src/app/(main)/accessconfig/install/page.tsx`
- `src/app/api/ingest/setup/route.ts`
- `src/app/api/ingest/setup/auto/route.ts`
- `src/app/api/ingest/setup/codex/*`
- `scripts/agent-trace-collectors/codex/install.cjs`
- `scripts/agent-trace-collectors/codex/self-check.cjs`
- `scripts/agent-trace-collectors/codex/uninstall.cjs`

卸载只停止 Agent Insight 自有 proxy/reader，删除其 config/lease；默认保留 spool、TraceThread 和
Execution 数据。不得删除、改写或移动 `~/.codex/sessions`。

## 24. 安全与隐私

1. App Server proxy 与 relay 只监听 loopback，并使用现有 install secret；
2. WebSocket 非本方案首版入口；不得暴露无认证的非 loopback listener；
3. rollout reader 在本地逐行解析，原始文件不复制、不上传；
4. user message、Tool 参数/结果和 assistant output 沿用现有脱敏与长度限制；
5. system/developer/base instructions 与 raw reasoning 永不进入 spool；
6. Windows、UNC、Linux、WSL、macOS 本机路径在 canonical 写入前统一脱敏；
7. client/account identity、API key、access token 和 auth payload 不进入 ThreadEvent；
8. protocol schema 只用于本地能力探测，不包含凭据；
9. backfill 必须显式授权、可停止、可精确定位进度；
10. 日志只写 method、event type、id 摘要、计数与错误，不写正文。

## 25. 兼容与降级

| 情况 | 行为 |
| --- | --- |
| CLI 只有 Hooks + OTel | 保持现有采集链 |
| App Server 不支持 `turn/steer` | 禁用 proxy steer 语义，不影响 Hooks/OTel |
| Desktop rollout schema 未知 | 停止该文件解析，保留 checkpoint 与诊断，不走 Generic |
| OTel 缺 turn id但有唯一 active rollout task | 关联并标记 confidence=correlated |
| OTel 缺 turn id且候选多个 | pending，不猜测 |
| 同时收到 contextCompaction 与 legacy notification | 合并为一个 ThreadEvent |
| 只有 legacy `thread/compacted` | 生成兼容 ThreadEvent，标记 legacy source |
| rollout reader 关闭 | 不读取 Desktop 文件，CLI/App Server 链路继续 |
| 新 UI flag 关闭 | 数据仍可采集，按旧 Trace UI 展示 Execution |

---

# Phase 3：开发计划

## 26. 实施阶段

### 阶段 0：真实 fixture 与设计门

1. 从真实 Desktop session 提取结构 fixture；
2. 替换 session/turn/client/window id；
3. 替换用户正文、路径、模型账号与输出，只保留事件类型、顺序、相对时间和字段形状；
4. fixture 同时覆盖真实 steer 展示问题、interrupt、maintenance compaction 和下一用户 task；
5. 生成受测 CLI 版本的 App Server schema 摘要；
6. 先写稳定红灯，证明当前实现会丢 turn alias、状态或 compaction；
7. 完成 Prisma/API 设计索引和迁移评审后再改业务代码。

### 阶段 1：collector 语义核心

1. 抽出 `source-classifier.cjs`；
2. 扩展 `CodexTraceCore` 的 Execution、input history、phase 和 status 状态；
3. 新增 source execution alias；
4. 修复 `promptTurn()` 的 input 覆盖；
5. 保留现有 Hook/OTel 入口与测试；
6. 增加 pending/ambiguity 计数和 state snapshot；
7. 运行现有 Codex collector 全量回归。

### 阶段 2：App Server ingress

1. 新增 JSON-RPC proxy；
2. 实现 initialize、thread/start/resume、turn/start/steer/interrupt 请求账；
3. 处理 turn/item lifecycle；
4. 处理 current/legacy compaction；
5. 增加协议 schema capability probe；
6. 完成进程退出、协议错误、半行、背压和透明转发测试。

### 阶段 3：Desktop rollout ingress

1. 新增只读增量 reader；
2. 实现文件发现、identity、checkpoint、断尾和 archived move；
3. 解析 source metadata、task lifecycle、user input、interrupt 和 compaction；
4. 以 allowlist 逐步接入 Tool、Subagent、AgentMessage 与 Token；
5. 双通道 dedupe 与 source precedence；
6. 增加 enable/disable/self-check/uninstall；
7. 默认不做历史 backfill。

### 阶段 4：服务端存储与 Adapter

1. Prisma 新增 TraceThread、TraceThreadEvent 与 Execution 扩展；
2. 添加可回滚、仅增量的迁移；
3. Codex Adapter 支持 input phases、status、transition 和 thread event；
4. storage 保存 Execution 与 ThreadEvent 的一致性边界；
5. consumer 对“已识别且仅产生 ThreadEvent”的 batch 正确确认；
6. 历史 Execution 只补 alias，不改主键；
7. 其他 Adapter 回归保持不变。

### 阶段 5：API 与 UI

1. 扩展 session API full/structure/lazy interaction；
2. 列表增加 source/status；
3. Trace timeline 增加 input phase boundary；
4. 详情增加前后 Execution transition；
5. 增加 thread compaction 行；
6. 避免 compaction、steer、interrupt 计入 Tool/LLM/Task 数；
7. 桌面与移动 viewport 浏览器验证。

### 阶段 6：安装链与正式验收

1. 三个中央入口和 Codex 专属 setup 同步；
2. Bash、PowerShell 安装/self-check/卸载/重装；
3. Windows Desktop 真实 steer、interrupt、compaction E2E；
4. CLI 普通 turn、CLI steer、Subagent 和 Tool E2E；
5. openEuler CLI + 跨机 Agent Insight 服务端验证；
6. production build、changed-file audit、敏感信息扫描和文档更新。

## 27. 计划文件范围

### 27.1 collector

- `scripts/agent-trace-collectors/codex/codex-trace-core.cjs`
- `scripts/agent-trace-collectors/codex/relay.cjs`
- `scripts/agent-trace-collectors/codex/app-server-proxy.cjs`（新增）
- `scripts/agent-trace-collectors/codex/rollout-reader.cjs`（新增）
- `scripts/agent-trace-collectors/codex/source-classifier.cjs`（新增）
- `scripts/agent-trace-collectors/codex/install.cjs`
- `scripts/agent-trace-collectors/codex/self-check.cjs`
- `scripts/agent-trace-collectors/codex/uninstall.cjs`

### 27.2 server

- `prisma/schema.prisma`
- `src/lib/ingest/otel/adapters/codex.ts`
- `src/lib/ingest/otel/adapters/types.ts`（仅在需要 accepted-non-execution 结果时）
- `src/lib/ingest/otel-consumer/consumer.ts`
- `src/lib/storage/data-service.ts`
- `src/app/api/observe/session/route.ts`

### 27.3 UI

- `src/lib/engine/observability/agent-trace.ts`
- `src/components/observe/AgentTraceView.tsx`
- Trace 列表的来源与状态筛选组件

### 27.4 tests/docs

- `test/codex-hook-collector.test.ts`
- `test/codex-otel-relay.test.ts`
- `test/codex-app-server-protocol.test.ts`（新增）
- `test/codex-desktop-rollout.test.ts`（新增）
- `test/codex-adapter.test.ts`
- `test/otel-consumer.test.ts`
- `test/agent-trace-*.test.ts`
- `docs/user-guide/` 对应 Codex 接入与 Trace 说明
- `docs/developer-guide/` 对应架构、数据流与扩展契约

## 28. 自动化验收

### 28.1 steer

| ID | 场景 | 预期 |
| --- | --- | --- |
| AC-CX-001 | turn/start + 2 次成功 turn/steer | 1 Execution、3 inputs、3 phases |
| AC-CX-002 | expectedTurnId 不匹配 | steer 不落库，原 phase 不变化 |
| AC-CX-003 | 无 active turn 的 steer | 不创建 Execution |
| AC-CX-004 | steer 前 Tool 后完成 | Tool 保留在 start 时 phase |
| AC-CX-005 | steer 后 LLM/Tool | 归新 phase，Execution query 不变 |
| AC-CX-006 | Desktop interrupt + new task | 2 Execution，前者 interrupted |
| AC-CX-007 | 无直接原因的 interrupt + new task | transition 不假标 steer |

### 28.2 compaction

| ID | 场景 | 预期 |
| --- | --- | --- |
| AC-CX-008 | contextCompaction started/completed | 1 completed ThreadEvent |
| AC-CX-009 | current item + legacy notification | 去重后 1 ThreadEvent |
| AC-CX-010 | Desktop compacted + context_compacted | 使用 window id，只有 1 ThreadEvent |
| AC-CX-011 | 无用户 maintenance task | 0 新 Execution |
| AC-CX-012 | compaction 有 usage | 只计 maintenanceUsage |
| AC-CX-013 | compaction 前后用户 task | 两个 Execution 指标互不污染 |

### 28.3 来源与关联

| ID | 场景 | 预期 |
| --- | --- | --- |
| AC-CX-014 | Desktop + source=exec | sourceKind=desktop |
| AC-CX-015 | codex_tui/codex_exec | sourceKind=cli |
| AC-CX-016 | codex_vscode | sourceKind=ide |
| AC-CX-017 | thread_source=subagent | 保持产品来源，建立 child ownership |
| AC-CX-018 | OTel 无 turn id，唯一 active rollout task | 关联到原始 task id |
| AC-CX-019 | OTel 无 turn id，两个 active 候选 | pending，不猜测 |
| AC-CX-020 | Hook/OTel/App Server/rollout 重复 | 一个逻辑 Execution/Tool/LLM |

### 28.4 可靠性与安全

| ID | 场景 | 预期 |
| --- | --- | --- |
| AC-CX-021 | rollout torn tail | 不推进半行 offset |
| AC-CX-022 | reader/relay 重启 | 结果与连续运行一致 |
| AC-CX-023 | rollout 移入 archived | 不重复导入 |
| AC-CX-024 | 未知 rollout schema | 停止解析，不走 Generic |
| AC-CX-025 | API/上传失败 | durable 数据与 checkpoint 可恢复 |
| AC-CX-026 | 重放同一输入两次 | DB、interaction、ThreadEvent 数量不变 |
| AC-CX-027 | base instructions/reasoning/credential/path | 不进入 spool 和报告 |
| AC-CX-028 | reader 未启用 | 不访问 Desktop rollout 内容 |

### 28.5 UI 与指标

| ID | 场景 | 预期 |
| --- | --- | --- |
| AC-CX-029 | 同 turn steer | 时间线显示 initial/steer 阶段 |
| AC-CX-030 | interrupt + new task | 前后 Execution 可跳转 |
| AC-CX-031 | compaction | 只在 thread 时间线显示 |
| AC-CX-032 | interrupted task | 保留已发生 usage，状态正确 |
| AC-CX-033 | 列表计数 | steer/compaction 不增加任务数 |
| AC-CX-034 | 列表、详情、统计 | latency/Token/Tool/LLM 口径一致 |

## 29. 性能门

- 现有同步 Hook 分派预算不回退；
- App Server proxy 的 JSON-RPC 转发采用流式逐行处理，不缓存整场会话；
- proxy 本地额外 p95 转发延迟目标小于 5ms；
- rollout reader 只能增量读取，不允许周期性重扫完整历史文件；
- reader/uploader 单进程峰值 RSS 目标小于 50MB；
- idle reader CPU 目标小于 1%；
- 大 rollout、长 turn、多 steer、多 compaction 下状态文件保持有界；
- 性能报告区分采集器开销与模型/网络耗时。

## 30. 真实 E2E

正式 E2E 至少覆盖：

1. Windows Codex Desktop：普通输入 -> steer -> Tool/LLM -> interrupt -> 新输入；
2. Windows Codex Desktop：真实自动或手动 compaction；
3. Codex CLI：普通多 turn、CLI steer、Subagent、Skill、Tool 与失败 Tool；
4. Agent Insight 与 collector 分处两台机器，使用非 loopback 服务地址；
5. 安装后运行体从 `~/.agent-insight/collectors/codex/` 加载，并重启 relay；
6. 服务端使用最终候选分支和正式验证端口；
7. 数据库核对 Execution 状态、source id、interactions、ThreadEvent 与指标；
8. 浏览器核对列表、详情时间线、前后任务跳转和 compaction；
9. 所有截图、日志、fixture 和报告脱敏。

真实案例验收不使用原始用户正文作为仓库 fixture。仓库只提交结构等价、id 重映射、内容替换后的
样本；本地原始证据仅用于验证结构一致性。

## 31. 回归门

完成功能后运行：

```bash
npm run test
npm run lint
npm run build
```

同时执行：

- Codex Hook/OTel/App Server/rollout 聚焦测试；
- Pi、ClaudeCode、WorkBuddy 与 Generic Adapter 共享回归；
- OTel consumer checkpoint/owner lock 回归；
- Trace UI 调用树、Token、latency 与 lazy interaction 回归；
- Bash/PowerShell 语法、安装、自检、卸载和重装；
- `git diff --check`、冲突标记、敏感信息和绝对路径扫描；
- changed-file audit 与其他采集器影响分析。

全仓基线存在失败时，必须分别记录聚焦结果、候选 HEAD 结果和基线失败，不能把失败项写成通过。

## 32. 迁移与回退

### 32.1 数据迁移

- Prisma 迁移只新增表、列和索引，不删除或重命名现有字段；
- 旧 Execution 的 `traceThreadId/sourceExecutionId/status` 允许为空；
- 新读路径对空字段保持兼容；
- 历史 alias 回填只处理唯一匹配，歧义项记录报告并跳过；
- 不自动重写 Execution.id、taskId、标签、评测或 Session interactions；
- ThreadEvent 使用稳定 eventKey，回填可重复执行。

### 32.2 功能开关

建议至少保留：

- `codexAppServerIngress`
- `codexDesktopRolloutIngress`
- `codexThreadTimeline`

collector 与 server 开关必须能独立关闭。server 在新事件未启用时仍能消费旧 Codex
Hook/OTel 数据。

### 32.3 回退

- 代码回退使用对应 commit 的 `git revert`；
- 关闭 rollout reader/proxy 后不再产生新 ThreadEvent；
- 新增数据库列和表可保留，旧版本会忽略，不进行破坏性 down migration；
- 已采集 Execution、Session、评测和标签不删除；
- 回退后仍可使用原 Hooks + OTel 链路。

## 33. PR 拆分建议

如果社区评审允许，建议一个 feature issue 下拆为两个聚焦 PR，并在正文声明依赖顺序：

1. Collector PR：source classifier、lifecycle reducer、App Server proxy、rollout reader、安装链与
   collector tests；
2. Server PR：Prisma、Codex Adapter、consumer、API、UI 与 server tests。

Server PR 依赖 collector 输出契约。共享文件冲突在前置 PR 合并后通过 rebase 解决，不复制两套
实现。若维护者要求一个 issue 一个 PR，则保持相同内部 commit 边界提交。

## 34. 完成定义

只有以下条件全部满足，升级才算完成：

- 官方 App Server turn/steer 与 compaction 协议由运行时 schema 验证；
- 真实 Desktop 结构 fixture 的 interrupt、maintenance compaction 和下一 task 全部通过；
- query 不再被 steer/follow-up 覆盖；
- CLI、Desktop、IDE、App Server 来源可区分，Subagent 不污染来源筛选；
- 同 turn steer 与 interrupt + new task 两种模式均正确；
- compaction 不创建 Execution、不污染指标，并在 thread 时间线可见；
- 缺 turn id 的 OTel 只在唯一证据下关联；
- 重放、重启、断尾、归档移动和网络失败均不重复、不丢失；
- 安装、自检、卸载、重装和默认关闭的隐私边界通过；
- 聚焦测试、production build、真实 E2E、跨机验证、浏览器验证和敏感信息扫描完成；
- 用户指南、开发者指南、设计索引、任务证据和版本跟踪与候选 HEAD 一致。

## 35. 实现与验收快照（2026-08-18）

| 阶段 | 本地候选状态 | 证据 |
| --- | --- | --- |
| 阶段 0：fixture 与设计门 | 已完成 | `test/codex-desktop-rollout.test.ts` 覆盖真实形状的 interrupt、双 compaction 信号、ISO 时间戳与断尾；Bug 45/46 均有稳定红灯记录 |
| 阶段 1：collector 语义核心 | 已完成 | source classifier、lifecycle reducer、input history/phase/status、ISO timestamp 解析和 legacy compaction 近邻去重 |
| 阶段 2：App Server ingress | 已完成 | JSON-RPC proxy、成功响应账本、steer/interrupt/contextCompaction 与 JSONL 透明转发回归 |
| 阶段 3：Desktop rollout ingress | 已完成 | 显式开关、增量 checkpoint、断尾保护、来源识别、真实 rollout 24 个 lifecycle event |
| 阶段 4：服务端存储与 Adapter | 已完成 | `TraceThread`/`TraceThreadEvent`、Execution 前后关系、thread-only compaction batch、session API user 隔离与跨归属 event key 作用域 |
| 阶段 5：API 与 UI | 已完成 | source/status 筛选、Desktop/CLI/IDE/App Server 标签、interrupted 状态、前后任务导航、steer/interrupt/compaction 时间线；1280×720 与 390×844 验收通过 |
| 阶段 6：安装与正式发布门 | 部分完成 | bundle/self-check 资产已接线；真实 rollout→隔离 SQLite 重放和第二次幂等扫描通过；Windows 新建 Desktop 会话、openEuler 跨机、正式 PR 尚未完成 |

### 35.1 真实案例结果

对真实 Desktop rollout 的第一次隔离重放结果为：`5` 个 Execution（`4 completed`、`1 interrupted`）、
`4` 条 execution transition、`1` 个 compaction、`5/5` query 存在；compaction 不创建第六个
Execution。相同 checkpoint 的第二次扫描产生 `0` 个新 lifecycle event，数据库数量保持不变。

该案例的“引导”证据是 `interrupt + new task`，因此按两个 Execution 及
`interrupt_followed_by_execution` 关联展示；只有 App Server 成功的同一 `turn/steer` 才进入同一
Execution 的 steer phase。

### 35.2 最终代码树验证

- Desktop/App Server 与 Codex Adapter：`45/45`；
- Codex、共享 consumer/registry 与 session 边界去重后的聚焦集合：`169/169`；
- production build：退出码 `0`，TypeScript 与 `86/86` 路由生成通过；
- 新增 standalone 模块 ESLint：0 diagnostics；全仓和既有大文件 lint 基线非绿，未误报为通过；
- `git diff --check`、冲突标记、凭据形状、本机绝对路径与完整真实 rollout ID 扫描通过。

### 35.3 发布前剩余门

1. 在干净用户目录安装并启用 Desktop reader，重启实际 relay，完成一次新建 Windows Desktop 会话的
   steer/interrupt/compaction 端到端验证；
2. 在 openEuler 24.03 LTS SP4 上完成 Agent Insight 服务端与 Windows collector 的非 loopback
   跨机采集、上传和数据库证据；
3. 将最终候选与社区 PR #233/#239 的实际合入状态重新对齐，再按 GitCode 写前授权流程执行社区写入。

### 35.4 0.166 压缩 rollout 与来源/根节点修正（2026-11-02）

Codex 0.164+ 的后台压缩会把 7 天未修改的冷 rollout 写成 `rollout-*.jsonl.zst`，恢复会话时
再 materialize 回 `.jsonl` 追加；0.166 仍保持该行为，并新增 `dynamic_tools_updated` 顶层记录。
本轮在原有契约上补三条：

1. **压缩会话**：reader 同时扫描 `.jsonl` 与 `.jsonl.zst`，plain 优先；checkpoint 使用去掉
   `.zst` 的稳定文件键，记录 `recordsProcessed`/`lastOrdinal`/`mtimeMs`/`size`。压缩、恢复、
   追加三种迁移都按记录数续读，不重复上报；旧 checkpoint 只有字节偏移时保守跳过压缩文件，
   materialize 后沿用旧偏移。Node < 22.15 时不崩溃，self-check 报 `zstdSupported=false`。
2. **CLI 来源**：rollout content/usage 接受 reader 的 `sourceKind`，不得硬编码
   `Codex Desktop`；0.166 CLI 会话因此保持 `sourceKind=cli`。
3. **根与工具合并**：0.166 OTel `exec` 把嵌套结果包成
   `{"output":"<escaped>"}`，adapter 先解转义再与 Hook `Bash` 做输出包含比较；Hook
   `execution_snapshot` 根与 OTel `agent.codex` 根按 `codex.execution.id` 合并，保留 OTel
   根的 span/输出并合并生命周期状态，消除重复 USER 节点。

回归入口：`test/codex-rollout-zstd.test.ts`、`test/l1-replay-codex-rollout.test.ts`、
`test/codex-desktop-0164-rollout.test.ts` 与 `test/codex-adapter.test.ts`。
