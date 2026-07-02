# OTel 进程内后台 Spool 消费者 — 开发计划（SDD）

版本：v0.1
最后更新：2026-06-09

> 文档类型：Phase3 开发计划 ｜ 关联 [Phase1](phase1-requirements-analysis.md) / [Phase2](phase2-requirements-design.md) ｜ base_commit：d72f05e（master）
> 类型：架构调整（接收/处理解耦）｜ 工作量：Medium

---

## 导读（工程师先看这段）

**这份文档是干活清单** —— 10 个任务分 4 个功能 Phase + 收尾，每个都带：改哪些文件（带行号锚点）、做什么、不许做什么、怎么算过。

**安全网怎么搭的** —— 把「行为不变」靠测试机器证，不靠人肉 review：
- T002 先给 traces 聚合建 **golden 基线**（把现状 `traces/route.ts:73-205` 的内联输出钉成常量），再抽成纯函数 —— 抽错立刻红。
- 端点切薄壳（T008/T009）放在**最后**：消费者（T006/T007）先上线接管处理，端点才敢停掉请求内落库，否则中间窗口数据无人处理。

**切换的关键顺序**（务必遵守）：先**起消费者**（处理侧就绪）→ 再**切端点**（接收侧退薄壳）。反过来会丢一段数据。

**术语**（dirty session / 检查点 / 双 debounce / OtelTraceEvent / SpoolSource）见 [Phase2 导读](phase2-requirements-design.md#导读工程师先看这段)。

---

## §1 Project Overview

| Information | Content |
|------|------|
| **Project Name** | OTel 进程内后台 Spool 消费者（异步摄取第一刀） |
| **Input Sources** | [Phase1 需求分析](phase1-requirements-analysis.md) v0.2 + [Phase2 需求设计](phase2-requirements-design.md) v0.1 |
| **Plan Type** | 架构调整（接收/处理解耦，含 traces 的行为变更 BR-005） |
| **Estimated Effort** | Medium |
| **Parallel Execution** | YES — 4 Waves + FINAL |
| **Critical Path** | T001 → T002 → T005 → T006 → T007 → T009 → F1-F4 |

## §2 Change Scope

### 2.1 Initial Requirements

> 当前先实现第一层：进程内后台消费（推荐）。start.sh 是长驻 node 进程，可在启动时拉起一个 debounce/interval 消费 spool 的 loop。无新依赖。出个设计文档放到 docs/design，并结合 docs/design/framework-adapter-registry 看是否需要合并整合。

### 2.2 Key Clarifications

| 决策 | 结论 |
|-|-|
| 与 framework-adapter-registry | **不合并**，只对齐接口缝（Phase2 D-002）；缝不得改 `{task_id,framework}` 去重键 |
| 首启 backlog 历史 | 检查点缺失 → 各文件游标**种 EOF，不回放历史**（Phase2 D-003） |
| 中毒 session | **park + 失败计数 + 计数指标**（Phase2 §2.2.3） |
| 启动落点 | `instrumentation-node.ts` 的 `setupNodeRuntime()`，**不动 start.sh**（Phase1 P-01） |
| 双 debounce | 仅复用 ClaudeLogWatcher 的 3s/30s 常量与形态；keying 改 per-session，最大等待兜底净新增（Phase2 D-001） |
| 数据源范围 | logs + traces 两路（Phase1 P-04） |

### 2.3 Module Change Details

| Status | Module | Change Description | Constraints |
|------|------|----------|------|
| 🟡 | `app/api/ingest/otel/v1/logs/route.ts` | 删请求内聚合/落库循环，退薄壳 | append 失败非 2xx |
| 🟡 | `app/api/ingest/otel/v1/traces/route.ts` | 删 per-span 同步 DB/落库/评估；加 normalize+spool | `framework=serviceName` 不变量 |
| 🟢 | `lib/ingest/otel-consumer/consumer.ts` | 单例 loop + 双 debounce + park + 计数 | 全进程唯一实例；落库后才推进检查点 |
| 🟢 | `lib/ingest/otel-consumer/checkpoint.ts` | 行游标状态文件；半行容错；种 EOF | 只跨 `\n` 结尾整行推进 |
| 🟢 | `lib/ingest/otel-consumer/sources.ts` | `SpoolSource` 注册表（logs/traces 两源） | 源无关层禁 `framework===` 分支 |
| 🟢 | `lib/ingest/otel-consumer/retention.ts` | 保留/压实（P1） | 只动检查点已越过的文件 |
| 🟡 | `lib/ingest/claude-otel/spool.ts` | 增量游标读 + traces spool append/list | 不破坏现有签名 |
| 🟢 | `lib/ingest/claude-otel/traces-aggregator.ts` | `aggregateOtelTraceSession`（抽自 route 内联） | 与现状逐字段等价，golden 守 |
| 🟡 | `lib/ingest/claude-otel/otlp-json.ts` | 加 `normalizeClaudeOtlpTraces` | 复用现有 `getOtelAnyValue` |
| 🟡 | `lib/ingest/claude-otel/types.ts` | 加 `OtelTraceEvent` 类型 | `ClaudeOtelEvent` 不动 |
| 🟡 | `instrumentation-node.ts` | 拉起消费者 + backlog 触发 | 失败不阻塞启动 |
| 🔴 | `lib/ingest/claude-otel/aggregator.ts` | 仅被调用 | `framework:'claudecode'` 不变 |
| 🔴 | `lib/storage/data-service.saveExecutionRecord` | 仅被调用，唯一落库出口 | 本轮禁改 |
| ⚪ | `lib/ingest/adapters/*` | 不涉及；已落地时才调 `getAdapter` | 本轮不为它写代码 |
| ⚪ | `lib/ingest/claude-watcher.ts` | 不涉及（仅借鉴形态，不改不起） | 现跑客户端，非本进程 |

### 2.4 Functional Impact Details

| Change Type | Functional Node | Change Point | Corresponding Requirement |
|----------|----------|--------|----------|
| Modify | logs 摄取 | 删请求内聚合/落库 | FR-001 |
| Modify | traces 摄取 | 删 per-span 同步落库；加 normalize+spool | FR-001 / BR-005 |
| Add | 后台消费 | 单例 loop + dirty 发现 + 调度 | FR-002 / FR-003 |
| Add | 崩溃恢复 | 检查点续处理 | FR-004 / NFR-002 |
| Add | 启动补偿 | backlog 扫描（种 EOF） | FR-005 |
| Add | 长会话兜底 | 最大等待评估 | FR-007 |
| Add | 端点失败语义 | append 非 2xx / 归一化丢弃 / 鉴权 | FR-008 / BR-001a |
| Add | spool 运维 | 保留/压实 | FR-006（P1） |

## §3 Technical Design

### 3.1 Tech Stack

继承现有栈，**零新增依赖**：
- **Runtime**: Node.js（Next.js `nodejs` runtime，单进程 `npm run start`）
- **持久化**: 现有 spool JSONL（`node:fs` `appendFileSync`）+ Prisma（仅经 `saveExecutionRecord`，不新增 schema）
- **测试**: node 内置 test runner + tsx。全量：`npm test`（= `node --import tsx --test "test/**/*.test.ts"`）；**单文件**：`node --import tsx --test test/<name>.test.ts`（`npm test <path>` 无效，因 `test` 脚本写死了 glob）
- **环境**: 测试需 WSL + nvm node 22.17.1（Windows 侧 node 跑 esbuild/tsx 会失败）

### 3.2 Core Decisions

#### Decision 1: 先起消费者，后切端点（切换顺序）
**Rationale**：消费者（T006/T007）上线后才接管「聚合→落库」；若先把端点切薄壳，中间窗口写入 spool 的数据无人处理 → 短时不可见甚至丢评估。
**Alternative**：同 commit 一起切（否决：原子性更难验证，回滚粒度粗）。

#### Decision 2: traces 聚合「先 golden 后抽取」
**Rationale**：`traces/route.ts:73-205` 是内联在 POST handler 里的逻辑，无现成纯函数可对。先用 fixture 把期望 `ExecutionRecord` 字段钉成常量（T002 自带），再让 `aggregateOtelTraceSession` 去满足它，抽错即红。
**Alternative**：抽完再补测（否决：失去「抽取等价」的机器证据，与 framework-adapter-registry T1 范式不一致）。

#### Decision 3: `framework=serviceName` 钉成不变量
**Rationale**：`saveExecutionRecord` 按 `{task_id, framework}` 去重（data-service.ts:1487）。traces 现状 `framework=serviceName`（route.ts:198），若 aggregator/registry 改了取值 → 同一 task_id 多落一行，击穿 NFR-002「不重」。
**Alternative**：经 `resolveFrameworkId` 归一（推迟：属 registry 那条线，本轮缝不改键）。

### 3.3 Data Model

不新增 DB schema。新增均为 spool 目录内文件态/内存态（详见 [Phase2 §5](phase2-requirements-design.md#5-数据模型)）：
- **检查点状态文件**（1 : N spool 文件）：`{version, files: {relPath: {bytes, updatedAt}}}`
- **traces spool**：`<spoolDir>/<YYYY-MM-DD>/traces.jsonl`，每行一个 `OtelTraceEvent`
- **`OtelTraceEvent`**（新类型）：含 `sessionId/traceId/spanId/parentSpanId/kind/serviceName/usage/...`（Phase2 §5.3）

### 3.4 Interface Contracts

内部接口见 [Phase2 §6.2](phase2-requirements-design.md#62-内部接口)。关键签名：
- `consumer.start(): void`（幂等：先 clearInterval 旧 timer 句柄）
- `readNewLinesSince(file, cursor): { events, nextCursor }`
- `SpoolSource = { id, spoolDir(), aggregate(sid): ExecutionRecord|null, defaultSkipEvaluation }`
- `aggregateOtelTraceSession(sessionId): ExecutionRecord|null`
- `normalizeClaudeOtlpTraces(body, opts): OtelTraceEvent[]`

外部接口（OTLP）形态不变，仅响应语义变「已受理」（[Phase2 §6.1](phase2-requirements-design.md#61-外部接口)）。

## §4 Task Breakdown

### 4.1 Upstream Gap Analysis

| 缺口 | 解决 | 状态 |
|-|-|-|
| traces `sessionId` 取值口径 | 沿用现状 `explicitSessionId || service.instance.id || traceId`（route.ts:144-149），写进 `normalizeClaudeOtlpTraces` | Resolved |
| traces 聚合无现成纯函数可对 | T002 自带 fixture 钉死期望（Decision 2） | Resolved |
| 检查点状态文件落点 | 各 spool 根目录下 `consumer-checkpoint.json`，与 day 目录同级 | Default Applied |
| park 后自动复活 | 本轮不做，park 后靠日志/重启复核（Phase2 §7.1 R-4） | Pending Decision（后续轮） |
| 多 worker 跨进程单消费者 | 本轮不做，仅登记（NFR-003） | Pending Decision（后续轮） |
| 测试 runner 具体命令 | 单文件 `node --import tsx --test test/<name>.test.ts`（已核 package.json：`test` 脚本写死 glob，不接单路径参数） | Resolved |
| traces `taskId==='unknown'` 兜底 | route.ts:149 有 `if (taskId==='unknown') taskId=traceId`，须写进 `normalizeClaudeOtlpTraces` 并纳入 golden | Resolved |

### 4.2 Task Organization Strategy

**Organization Method**: 混合策略 —— 按**架构层 + 依赖耦合**分 Wave，层内按数据流。

**Rationale**:
- 地基（类型/纯函数/spool/检查点）**不接线、零回归**，可大并行先行（Wave 1）。
- 消费者是执行层核心，依赖地基齐备（Wave 2）。
- 端点切薄壳是**行为切换**，必须在消费者上线后（Wave 3），降低中间窗口风险。
- 保留/压实为 P1，可独立延后（Wave 4）。

**MVP Scope**:
- **Phase 1（MVP）**: Wave 1 + Wave 2 + Wave 3 —— 端点薄壳 + 后台消费 + 双 debounce + 检查点 + 不丢不重（FR-001~005/007/008）。
- **Phase 2（增量）**: Wave 4 —— spool 保留/压实（FR-006，P1）。

### 4.3 需求→任务 追溯矩阵

> 每条 FR/关键 NFR/AC 至少有一个 owning task；无孤儿需求、无无主任务（无 scope creep）。

| 需求 | Owning Task | 验证 |
|-|-|-|
| FR-001 端点薄壳 | T008（logs）、T009（traces） | AC-001 / TC-001 |
| FR-002 单例消费者 | T006、T007 | TC-005 |
| FR-003 双 debounce | T006 | AC-002 / TC-002 |
| FR-004 检查点/进度 | T004、T006（推进） | AC-003 / TC-003 |
| FR-005 启动 backlog | T007（种 EOF） | T007 AC |
| FR-006 保留/压实（P1） | T010 | AC-006 / TC-006 |
| FR-007 长会话最大等待 | T006（maxWait） | TC-002 |
| FR-008 端点失败语义 | T008、T009 | AC-008 / TC-007 |
| NFR-001 端点响应 | T009 | AC-001 / TC-001 |
| NFR-002 不丢不重 | T004+T006（不丢）、T002+T009 回归（不重） | AC-003/AC-004 / TC-003/TC-004 |
| NFR-003 单消费者 | T006（globalThis 句柄） | AC-005 / TC-005 |
| NFR-006 可观测 | T006（计数指标） | F2/F3 |
| BR-005 traces 异步语义 | T009 | AC-007 |

## §5 Execution Waves

```text
Phase 1: 地基（不接线，零回归） (Wave 1)
Preconditions: Phase2 设计定稿
├── T001: OtelTraceEvent 类型 + normalizeClaudeOtlpTraces [Low]
├── T002: traces 纯聚合抽取 + golden 基线 [Medium]
├── T003: spool 增量游标读 + traces spool [Medium]
└── T004: 检查点模块 checkpoint.ts [Medium]
Deliverables: 纯函数与 spool/检查点能力齐备，单测全绿；运行时行为不变

Phase 2: 消费者与接线（起 loop） (Wave 2)
Preconditions: T001~T004 完成
├── T005: SpoolSource 注册表（logs/traces 两源） [Low]
├── T006: 后台消费者 consumer.ts（单例+双debounce+park+计数） [High]
└── T007: instrumentation 接线 + 启动 backlog（种 EOF） [Low]
Deliverables: 消费者上线接管处理；重复 start 不产生第二 loop；首启不回放历史

Phase 3: 端点切薄壳（行为切换） (Wave 3)
Preconditions: T006/T007 上线并验证消费正常
├── T008: logs 端点退薄壳 [Low]
└── T009: traces 端点退薄壳 + framework 不变量回归 [Medium]
Deliverables: 两端点「写 spool 即返回」；端点响应 P99<100ms；traces 异步语义

Phase 4: 运维（P1，可延后） (Wave 4)
Preconditions: Wave 3 完成
└── T010: spool 保留/压实 retention.ts [Medium]
Deliverables: 历史 spool 受控；裁剪后游标失效

Phase FINAL: Quality Validation & Delivery (Wave N)
Preconditions: All functional Phases completed
├── F1: Plan Compliance Audit
├── F2: Code Quality Review
├── F3: Real Scenario Manual QA
└── F4: Scope Fidelity Check
Deliverables: 通过全部验收准则，待用户确认

Critical Path: T001 → T002 → T005 → T006 → T007 → T009 → F1-F4
Maximum Concurrency: Phase 1 有 4 个任务并行
```

## §6 Task List

### Phase 1: 地基（不接线，零回归）

**Core Objective**: 备齐 traces 类型/归一化/纯聚合、spool 增量读、检查点四块能力，单测全绿，且运行时行为零变化。

**Independent Validation Criteria**:
- [ ] `node --import tsx --test test/otel-trace-aggregator.test.ts` → PASS（golden 钉死）
- [ ] `node --import tsx --test test/otel-spool-cursor.test.ts` → PASS（半行容错）
- [ ] `node --import tsx --test test/otel-checkpoint.test.ts` → PASS
- [ ] `npx tsc --noEmit` → 0 error
- [ ] `git diff` 不含任何 route/instrumentation 运行时接线改动

**Git Commit**: YES — `feat(ingest): otel spool consumer foundations (types, traces aggregator, cursor, checkpoint)`

**Task List**:

---

- [ ] T001 新增 `OtelTraceEvent` 类型与 `normalizeClaudeOtlpTraces` 归一化 - `src/lib/ingest/claude-otel/types.ts`, `src/lib/ingest/claude-otel/otlp-json.ts`

   - **Delegate Subagent**: YES / coder / Low / 可与 T003、T004 并行
   - **What to do**:
     + types.ts 新增 `OtelTraceEvent`（字段见 Phase2 §5.3：sessionId/traceId/spanId/parentSpanId/kind/serviceName/user/model/usage/latencyMs/startTimeMs/attributes）。**不动** `ClaudeOtelEvent`。
     + otlp-json.ts 新增 `normalizeClaudeOtlpTraces(body, opts) → OtelTraceEvent[]`：遍历 `resourceSpans→scopeSpans→spans`，复用现有 `getOtelAnyValue`/`otelAttrsToObject`；判 `isGenAI`/`isTool`（route.ts:94-96）；`sessionId = explicitSessionId || service.instance.id || traceId`，**并保留** route.ts:149 的兜底 `if (sessionId==='unknown') sessionId = traceId`（route.ts:144-149，勿漏此句，否则 grouping 与现状不等价）；`serviceName = resourceAttrs['service.name'] || 'unknown-service'`（route.ts:80）。
     + 单测：给 1 个含 gen_ai span + 1 个 tool span 的 OTLP body，断言产出事件字段。
   - **Must NOT do**:
     + 不改 `ClaudeOtelEvent`；不在归一化里做聚合/落库；不改 `normalizeClaudeOtlpLogs`。
   - **Parallelism Info**: Can Parallel YES ｜ Prereq 无 ｜ Blocking T002、T009
   - **Reading List**:
     + Pattern: `src/lib/ingest/claude-otel/otlp-json.ts:69-115` - logs 归一化的写法范式
     + API/Type: `src/app/api/ingest/otel/v1/traces/route.ts:71-151` - span 取值口径（sessionId/serviceName/usage/latency）
     + API/Type: `src/lib/ingest/claude-otel/types.ts:3-16` - 现有事件类型形状
   - **Acceptance Criteria**:
     + [ ] `node --import tsx --test test/otel-trace-normalize.test.ts` → PASS
     + [ ] `npx tsc --noEmit` → 0 error

   - **QA Scenario**:
   ```
   Scenario: traces 归一化保真
     Tool: npm test
     Preconditions: fixture OTLP traces body
     Steps:
       1. normalizeClaudeOtlpTraces(body)
       2. 断言 sessionId/serviceName/kind/usage 与 fixture 期望一致
     Expected Result: 字段逐项相等
     Evidence: .sisyphus/evidence/task-T001-normalize.txt
   ```

---

- [ ] T002 抽取 `aggregateOtelTraceSession` 纯函数 + golden 基线 - `src/lib/ingest/claude-otel/traces-aggregator.ts`, `test/otel-trace-aggregator.test.ts`

   - **Delegate Subagent**: YES / coder / Medium / 依赖 T001
   - **What to do**:
     + 把 `traces/route.ts:73-205` 的内联聚合（interaction 构造、totals 汇总、`ExecutionRecord` 拼装）**原样**抽成 `aggregateOtelTraceSession(sessionId): ExecutionRecord|null`，输入改为读 traces spool 的该 session 事件（用 T003 的读取；本任务可先吃 `OtelTraceEvent[]` 入参版本 `aggregateOtelTraceEvents(sid, events)`，再加 `...Session` 包装）。
     + `framework = serviceName`（Decision 3，钉死）。聚合内若需按框架转换：留接口缝走 `getAdapter()`（若已落地）否则现状直算——本轮 traces 无 claude 归一化需求，缝**仅注释标注**，不接线。
     + golden：fixture（gen_ai + tool + 同 spanId 重发 + 一个 `taskId==='unknown'`→traceId 的 case）→ 断言 `ExecutionRecord` 的 task_id/framework/tokens/latency/interactions 长度等关键字段为常量。**golden 必须钉在最终 `aggregateOtelTraceSession` 形态上**（不只是中间 `...Events` 入参版），否则等价证明有缺口。
   - **Must NOT do**:
     + 不改 `aggregator.ts`（logs 聚合，🔴）；不重写逻辑（只搬）；不在此落库；不改 framework 取值。
   - **Parallelism Info**: Can Parallel NO（关键路径）｜ Prereq T001 ｜ Blocking T005
   - **Reading List**:
     + Pattern: `src/lib/ingest/claude-otel/aggregator.ts:310-500` - 聚合成 ExecutionRecord 的范式 + `dedupeEvents`
     + API/Type: `src/app/api/ingest/otel/v1/traces/route.ts:97-205` - 待抽取的内联逻辑（含 dedup by spanId :162）
   - **Recommended Skills**:
     + `code-review`: 抽取后对照现状逐字段核等价
   - **Acceptance Criteria**:
     + [ ] `node --import tsx --test test/otel-trace-aggregator.test.ts` → PASS（golden 常量）
     + [ ] 同 spanId 事件重发 → interactions 无重复（去重生效）
   - **QA Scenario**:
   ```
   Scenario: traces 聚合等价 + 去重
     Tool: npm test
     Preconditions: fixture 含重复 spanId
     Steps:
       1. aggregateOtelTraceSession(sid)
       2. 断言 ExecutionRecord 关键字段 == golden 常量；interactions 去重
     Expected Result: 全等
     Evidence: .sisyphus/evidence/task-T002-golden.txt
   ```

---

- [ ] T003 spool 增量游标读 + traces spool 读写 - `src/lib/ingest/claude-otel/spool.ts`, `test/otel-spool-cursor.test.ts`

   - **Delegate Subagent**: YES / coder / Medium / 可与 T001、T004 并行
   - **What to do**:
     + 新增 `readNewLinesSince(file, cursor) → { events, nextCursor }`：只取以 `\n` 结尾的整行区（`lastIndexOf('\n')`），自 `cursor.bytes` 起切片，逐行安全 JSON.parse（沿用现有坏行静默跳过 spool.ts:64），尾部半行不消费（Phase2 §4.1）。
     + 新增 traces spool：`appendOtelTraceEvents(events, dir)` 新写入 `<dir>/<day>/sessions/<safe-session>/traces.jsonl`；traces spool 目录 getter；列举递归查找 `traces.jsonl`，并继续兼容 legacy `<dir>/<day>/traces.jsonl`。
     + **不破坏** `appendClaudeOtelEvents` / `readClaudeOtelEventsForSession` 现有签名。
     + 单测：写 3 行 + 半行 → 读到 3 行、游标停在第 3 行末；再补全半行 → 读到第 4 行。
   - **Must NOT do**:
     + 不改现有函数签名；不用裸字节偏移跨半行；不引入新依赖。
   - **Parallelism Info**: Can Parallel YES ｜ Prereq 无 ｜ Blocking T004、T006、T009
   - **Reading List**:
     + Pattern: `src/lib/ingest/claude-otel/spool.ts:18-69` - append/list/read 现状
     + API/Type: `src/lib/ingest/claude-otel/spool.ts:51-68` - 现状坏行静默跳过
   - **Acceptance Criteria**:
     + [ ] `node --import tsx --test test/otel-spool-cursor.test.ts` → PASS（含半行容错）
     + [ ] 现有 spool 相关测试回归全过
   - **QA Scenario**:
   ```
   Scenario: 半行容错
     Tool: npm test
     Preconditions: 文件末尾留未 \n 结尾的半行
     Steps:
       1. readNewLinesSince(file, cursor0)
       2. 断言半行未被消费；补全后下次读到
     Expected Result: 不漏不重不解析 torn line
     Evidence: .sisyphus/evidence/task-T003-cursor.txt
   ```

---

- [ ] T004 检查点模块 - `src/lib/ingest/otel-consumer/checkpoint.ts`, `test/otel-checkpoint.test.ts`

   - **Delegate Subagent**: YES / coder / Medium / 依赖 T003（用其游标类型）
   - **What to do**:
     + `loadCheckpoint(spoolDir)` / `saveFileCursor(spoolDir, relPath, cursor)`：读写 `consumer-checkpoint.json`（`{version, files}`，Phase2 §5.1）。
     + `seedToEof(spoolDir)`：检查点缺失时把各现存 spool 文件游标种到当前 EOF（Decision/D-003）。
     + `invalidateCursor(relPath)`：供 retention 裁剪后失效。
     + 单测：缺失→种 EOF；推进单调不回退；缺失文件容错。
   - **Must NOT do**:
     + 不要求检查点幂等（BR-004a）；不在缺失时回放历史。
   - **Parallelism Info**: Can Parallel YES（与 T001 并行）｜ Prereq T003 ｜ Blocking T006、T010
   - **Reading List**:
     + Pattern: `src/lib/ingest/claude-otel/spool.ts:6-9` - spool 目录 getter 风格
     + API/Type: `src/lib/ingest/claude-otel/spool.ts:33-49` - 文件列举
   - **Acceptance Criteria**:
     + [ ] `node --import tsx --test test/otel-checkpoint.test.ts` → PASS
   - **QA Scenario**:
   ```
   Scenario: 首启种 EOF
     Tool: npm test
     Preconditions: spool 有历史文件、无检查点文件
     Steps:
       1. seedToEof(dir)
       2. 断言各文件游标 == 文件大小（不回放）
     Expected Result: 历史不被重放
     Evidence: .sisyphus/evidence/task-T004-seed.txt
   ```

---

### Phase 2: 消费者与接线（起 loop）

**Core Objective**: 后台消费者上线接管「发现→聚合→双 debounce 落库→推进检查点」，单进程唯一实例，首启不回放历史。

**Independent Validation Criteria**:
- [ ] `node --import tsx --test test/otel-consumer.test.ts` → PASS（含重复 start 仅一 loop）
- [ ] 本地起服务，上报一批 logs/traces → 短 debounce 后 Execution 行可见（skip_eval 态）
- [ ] 空闲超长 debounce → 评估字段被填充
- [ ] `npx tsc --noEmit` → 0 error

**Git Commit**: YES — `feat(ingest): in-process otel spool consumer (singleton loop, dual debounce, checkpoints)`

**Task List**:

---

- [ ] T005 SpoolSource 注册表 - `src/lib/ingest/otel-consumer/sources.ts`, `test/otel-sources.test.ts`

   - **Delegate Subagent**: YES / coder / Low / 依赖 T002
   - **What to do**:
     + 定义 `SpoolSource` 接口（Phase2 §6.2 IF-N04）；注册 logs 源（`aggregate = aggregateClaudeOtelSession`，`defaultSkipEvaluation` 读 `AGENT_INSIGHT_CLAUDE_OTEL_SKIP_EVALUATION`，默认 true）与 traces 源（`aggregate = aggregateOtelTraceSession`）。
     + `listSources()` 出口供消费者遍历。
   - **Must NOT do**:
     + 源无关层**禁** `framework===` 分支；不在此起 loop。
   - **Parallelism Info**: Can Parallel NO（关键路径）｜ Prereq T002 ｜ Blocking T006
   - **Reading List**:
     + API/Type: `src/lib/ingest/claude-otel/aggregator.ts:493-500` - logs aggregate 签名
     + Pattern: `src/app/api/ingest/otel/v1/logs/route.ts:30` - skip_evaluation env 读法
   - **Acceptance Criteria**:
     + [ ] `node --import tsx --test test/otel-sources.test.ts` → PASS（两源注册、aggregate 可调）

---

- [ ] T006 后台消费者 - `src/lib/ingest/otel-consumer/consumer.ts`, `test/otel-consumer.test.ts`

   - **Delegate Subagent**: YES / coder / High / 依赖 T003/T004/T005
   - **What to do**:
     + 单例守卫：`globalThis.__otelSpoolConsumer` 存 **timer 句柄**；`start()` 先 `clearInterval` 旧句柄再排（参照 debug/execute/route.ts:26-29 的 globalThis 先例，但存句柄非布尔）。
     + tick：遍历各源 → `readNewLinesSince` 各文件 → 按 sessionId 归 dirty 集。
     + per-session 双 debounce（Phase2 §4.2）：短(3s)→`saveExecutionRecord({...rec, skip_evaluation:true})`→落库成功后 `saveFileCursor`；长(30s 空闲)/最大等待(默认 120s)→`saveExecutionRecord({...rec, force_judgment:true})`。常量读环境变量（Phase2 §6.3），缺省 3s/30s/120s/tick 1s/park 3。
     + park：某 session 连续失败 `PARK_AFTER` 次 → 暂置、不每 tick 重试、不推进其检查点。失败计数器**仅内存态（by design）**——**不得**写进检查点文件（检查点只存游标、不要求幂等，BR-004a）。代价：重启后计数清零、被 park 的 session 会再被聚合一次（可能再打一次 LLM）；本轮接受，自动复活留后续轮。
     + 计数：每 tick console 输出 processed/backlog/parked/failed（NFR-006）。
   - **Must NOT do**:
     + 不在 consumer 里写 `framework===` 分支；不先推进检查点后落库；不复活 watcher；不引依赖。
   - **Parallelism Info**: Can Parallel NO（关键路径）｜ Prereq T003/T004/T005 ｜ Blocking T007
   - **Reading List**:
     + Pattern: `src/lib/ingest/claude-watcher.ts:18-73` - 双计时器形态（仅借鉴常量与 shape；keying 改 per-session）
     + Pattern: `src/app/api/debug/execute/route.ts:26-29` - globalThis 单例先例
     + API/Type: `src/lib/storage/data-service.ts:1775-1865` - skip_evaluation/force_judgment 评估门控
   - **Acceptance Criteria**:
     + [ ] `node --import tsx --test test/otel-consumer.test.ts` → PASS
     + [ ] 重复调用 `start()` → 只有一个 timer 句柄在跑（TC-005）
     + [ ] 模拟 aggregate 抛错 N 次 → 该 session park，不阻塞他人
   - **QA Scenario**:
   ```
   Scenario: 单例 + 双 debounce + park
     Tool: npm test (fake timers)
     Preconditions: spool 注入两 session，其一注入抛错
     Steps:
       1. start(); start()  // 重复
       2. 推进 3s → 断言 skip_eval 落库；推进 30s → 断言 force_judgment
       3. 抛错 session 连续失败 → park
     Expected Result: 一个 loop；好 session 正常；坏 session park
     Evidence: .sisyphus/evidence/task-T006-consumer.txt
   ```

---

- [ ] T007 instrumentation 接线 + 启动 backlog - `src/instrumentation-node.ts`

   - **Delegate Subagent**: YES / coder / Low / 依赖 T006
   - **What to do**:
     + `setupNodeRuntime()` 末尾 try/catch 调 `consumer.start()`（失败不阻塞启动，沿用现有风格 instrumentation-node.ts:20-28）。
     + 启动 backlog：`start()` 内首扫一遍 spool；检查点缺失 → `seedToEof`（不回放历史，D-003）。
   - **Must NOT do**:
     + 不动 start.sh / develop_start.sh；不在 edge runtime 起 loop（已被 instrumentation.ts:10 gate）。
   - **Parallelism Info**: Can Parallel NO（关键路径）｜ Prereq T006 ｜ Blocking T008、T009
   - **Reading List**:
     + Pattern: `src/instrumentation-node.ts:18-91` - 钩子内 try/catch 启动逻辑风格
     + API/Type: `src/instrumentation.ts:10-13` - nodejs runtime gate
   - **Acceptance Criteria**:
     + [ ] 本地 `npm run start` 启动日志出现消费者已起；首启不回放历史 spool

---

### Phase 3: 端点切薄壳（行为切换）

**Core Objective**: 两个 OTel 端点退化为「校验→归一化→写 spool→200」，请求内不再聚合/落库/评估；端点响应 P99<100ms；traces 转异步语义。

**Independent Validation Criteria**:
- [ ] 200 span 的 traces 批次 POST → 响应 < 100ms，DB 此刻未必有数据
- [ ] 上报后短 debounce 内可见、长 debounce 后评估填充
- [ ] spool 目录不可写 → 端点返回非 2xx
- [ ] 同一 task_id 跨 logs/traces 只有一行 Execution（framework 不变量）

**Git Commit**: YES — `refactor(ingest): otel endpoints to thin spool shells (async ingest)`

**Task List**:

---

- [ ] T008 logs 端点退薄壳 - `src/app/api/ingest/otel/v1/logs/route.ts`

   - **Delegate Subagent**: YES / coder / Low / 可与 T009 并行
   - **What to do**:
     + 保留校验/鉴权/`normalizeClaudeOtlpLogs`/`appendClaudeOtelEvents`；**删除** :33-44 的 `dirtySessionIds` 聚合/落库循环（:32 是 `const saved=[]` 声明，随循环一并清理）。
     + append 失败 → 返回非 2xx（FR-008/BR-001a）；成功 → 200「已受理」。
   - **Must NOT do**:
     + 不在请求内调 `aggregateClaudeOtelSession`/`saveExecutionRecord`；不改归一化逻辑。
   - **Parallelism Info**: Can Parallel YES（与 T009）｜ Prereq T007 ｜ Blocking 无
   - **Reading List**:
     + API/Type: `src/app/api/ingest/otel/v1/logs/route.ts:26-50` - 现状请求内落库
   - **Acceptance Criteria**:
     + [ ] POST logs → 仅 append；short debounce 后由消费者落库
     + [ ] spool 不可写 → 非 2xx

---

- [ ] T009 traces 端点退薄壳 + framework 不变量回归 - `src/app/api/ingest/otel/v1/traces/route.ts`, `test/otel-dedup-regression.test.ts`

   - **Delegate Subagent**: YES / coder / Medium / 依赖 T001/T003/T007
   - **What to do**:
     + 保留鉴权/content-type 校验；改为 `normalizeClaudeOtlpTraces(body) → appendOtelTraceEvents → 200`。**删除** :153-209 的 `findSessionByTaskId`/`upsertSession`/`saveExecutionRecord`/`getValue` 内联。
     + append 失败非 2xx；归一化失败丢弃该 span 继续（S-009），不污染 spool。
     + 注释明示 BR-005「响应=已受理」。
     + 回归测试：同一 OTLP traces 批次连发两次 + 同 task_id 也走 logs → 落库后只有一行 Execution（`framework=serviceName` 不变量，Decision 3）。
   - **Must NOT do**:
     + 不保留任何请求内同步 DB/落库；不改 `framework=serviceName`；不删 OPTIONS/CORS。
   - **Parallelism Info**: Can Parallel YES（与 T008）｜ Prereq T001/T003/T006/T007（去重回归依赖消费者 T006 产出落库行）｜ Blocking 无
   - **Reading List**:
     + API/Type: `src/app/api/ingest/otel/v1/traces/route.ts:23-220` - 现状全量待改
     + API/Type: `src/lib/storage/data-service.ts:1487` - {task_id,framework} 去重键
   - **Recommended Skills**:
     + `verify`: 起真服务发 200-span 批次实测响应时间与异步可见
   - **Acceptance Criteria**:
     + [ ] `node --import tsx --test test/otel-dedup-regression.test.ts` → PASS（一 task_id 一行）
     + [ ] 200-span 批次响应 < 100ms
   - **QA Scenario**:
   ```
   Scenario: traces 异步 + 不重
     Tool: verify (curl + DB 查询)
     Preconditions: 服务已起、消费者在跑
     Steps:
       1. POST 200-span traces；测响应时间
       2. 等短 debounce → 查 Execution 可见
       3. 同批次重发 → 仍一行
     Expected Result: <100ms；最终一行 skip→judged
     Evidence: .sisyphus/evidence/task-T009-traces.txt
   ```

---

### Phase 4: 运维（P1，可延后）

**Core Objective**: 已处理历史 spool 按保留窗口归档/裁剪，体积与扫描成本受控。

**Independent Validation Criteria**:
- [ ] 跨多日历史 spool → 触发保留 → 超窗已处理文件被裁剪，当日文件不动；对应游标失效
- [ ] `node --import tsx --test test/otel-retention.test.ts` → PASS

**Git Commit**: YES — `feat(ingest): otel spool retention & compaction`

**Task List**:

---

- [ ] T010 spool 保留/压实 - `src/lib/ingest/otel-consumer/retention.ts`, `test/otel-retention.test.ts`

   - **Delegate Subagent**: YES / coder / Medium / 依赖 T004/T006
   - **What to do**:
     + 按 `AGENT_INSIGHT_OTEL_SPOOL_RETENTION_DAYS`（默认 7）归档/裁剪**检查点已越过**的历史文件；裁剪后 `invalidateCursor`。
     + 由消费者 tick 周期触发（低频）。
   - **Must NOT do**:
     + 不动检查点未越过/当日文件；不删未处理数据。
   - **Parallelism Info**: Can Parallel NO ｜ Prereq T004/T006 ｜ Blocking 无
   - **Reading List**:
     + Pattern: `src/lib/ingest/claude-otel/spool.ts:33-49` - 按日目录列举
   - **Acceptance Criteria**:
     + [ ] `node --import tsx --test test/otel-retention.test.ts` → PASS（只裁已越过文件）

---

## §7 Phase FINAL: Quality Validation & Delivery

**Objective**: 确认全部需求满足、代码质量达标、系统可交付。

**Validation Criteria**:
- [ ] Phase1 §4 全部 AC（AC-001~008）通过
- [ ] Lint / 类型检查 / 全量测试通过
- [ ] 真实场景手测通过（崩溃恢复、去重、异步可见、端点失败）
- [ ] 用户明确同意交付

**Task List**:

---

- [ ] F1 Plan Compliance Audit
   - **Validation Content**: 实现满足 FR-001~008、NFR-001~006；对照 AC-001~008
   - **Output Format**:
   ```
   Must Have [N/N Pass]   Must NOT Have [N/N Pass]
   Requirement Coverage [N/N]   Evidence Files [N/N]
   VERDICT: APPROVE / REJECT
   ```
   - **Parallelism Info**: Can Parallel YES ｜ Prereq 所有功能 Phase

---

- [ ] F2 Code Quality Review
   - **Validation Content**: lint / tsc / 测试；重点核 globalThis 句柄释放、检查点推进顺序、无新依赖
   - **Output Format**:
   ```
   Lint: PASS/FAIL   Type Check: PASS/FAIL
   Tests: N pass / N fail   Code Smells: N
   VERDICT: APPROVE / REJECT
   ```
   - **Parallelism Info**: Can Parallel YES ｜ Prereq 所有功能 Phase

---

- [ ] F3 Real Scenario Manual QA
   - **Validation Content**: TC-001~007（性能、异步可见、`kill -9` 崩溃恢复、重复上报去重、重复 start、保留、append 失败非 2xx）
   - **Output Format**:
   ```
   Scenarios [N/N pass]   Edge Cases [N tested]   Integration [N/N]
   VERDICT: APPROVE / REJECT
   ```
   - **Parallelism Info**: Can Parallel YES ｜ Prereq 所有功能 Phase

---

- [ ] F4 Scope Fidelity Check
   - **Validation Content**: git diff 不越界；🔴`aggregator.ts`/`saveExecutionRecord` diff 为空（含 `aggregator.ts:469` 的 `framework:'claudecode'` 字面量不变）；⚪`adapters/*`、`claude-watcher.ts` 未改；grep 核 consumer/sources/traces-aggregator 无新增裸 `framework === 'claude'` 判存量；**额外断言 traces-aggregator 逐字输出 `framework = serviceName`**（去重键不变量，对应 T009 回归）；无 schema 迁移；start.sh 运行时逻辑未被本轮接线改动（git status 中 start.sh/develop_start.sh 的既有改动与本轮无关，需确认）
   - **Output Format**:
   ```
   Authorized Changes [N/N]   Unauthorized [N - paths]   Scope Creep [CLEAN/N]
   VERDICT: APPROVE / REJECT
   ```
   - **Parallelism Info**: Can Parallel YES ｜ Prereq 所有功能 Phase

## §8 Appendix

### 8.1 Development Strategies

- **Delegate Tasks**: 每个 T 委托 subagent 执行，避免主 Agent 上下文膨胀。
- **Multi-Agent**: Wave 1 的 T001/T003/T004 可同时派发（T002 依赖 T001）。
- **TDD**: 每个 T 先定测试场景再写实现；T002 的 golden、T003 的半行容错、T006 的 fake-timers 双 debounce 是关键。
- **切换顺序铁律**: 先起消费者（Wave 2）再切端点（Wave 3），不可颠倒。
- **测试环境**: WSL + nvm node 22.17.1（Windows 侧 esbuild 会失败）。

### 8.2 Risk List

| Risk | Impact | Mitigation |
|------|------|----------|
| traces 抽函数改坏行为 | 中 | T002 golden 先行，逐字段对（Phase2 R-1） |
| 两路 framework 去重击穿 | 中 | Decision 3 + T009 回归测试一 task_id 一行（R-2） |
| globalThis 句柄泄漏出第二 loop | 中 | T006 存 timer 句柄 + clearInterval；TC-005（R-6） |
| 端点先切致中间窗口丢数据 | 中 | 切换顺序铁律（Decision 1） |
| 首启历史风暴 | 中 | 检查点缺失种 EOF（D-003/T007） |
| 中毒 session 反复打 LLM | 中 | T006 park + 失败计数（内存态，重启清零是已接受代价；R-4） |
| spool 无限增长 | 低 | T010 保留/压实（P1） |

### 8.3 Coding Notes

- 检查点**落库成功后**才推进（BR-004）；先推进后落库会在崩溃时丢数据。
- 不丢=检查点；不重=`dedupeEvents` + `{task_id,framework}` upsert（BR-004a）——两者职责不重叠，勿混。
- 源无关层与 consumer **禁** `framework===` 分支；按框架转换下沉 aggregate，走 registry 入口或现有函数。
- 沿用现有 `console` 日志风格做计数指标，不引观测依赖。
- traces 归一化失败丢弃该 span 继续，绝不静默落入 spool 造脏数据（S-009）。
- park 失败计数器仅内存态，**禁**写进检查点文件（检查点只存游标）；重启计数清零是已接受代价（R-4）。
- traces `sessionId` 解析必须含 route.ts:149 的 `'unknown'→traceId` 兜底，否则与现状 grouping 不等价。

### 8.4 与 framework-adapter-registry 的协作

- 互不阻塞。本轮 traces aggregate 内的「按框架转换」缝**仅注释标注**，不接线；registry 落地后由该线把 `aggregator.ts:476` 等 normalize 收编（其 Phase3 T5 已列为后续轮），届时本设计的缝自动复用 `getAdapter()`，**不改去重键**。
