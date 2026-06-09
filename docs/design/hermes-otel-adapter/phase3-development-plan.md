# Hermes 平台适配（OTel / OTLP 接入）— 开发计划（SDD）
版本：v0.2
最后更新：2026-06-03 06:16:34

> 文档类型：Phase3 开发计划 ｜ base_commit：c47829a（master_0530）｜ 更新时间：2026-06-02 ｜ 状态：待 Phase3 评审

## §1 Project Overview

| Information | Content |
|------|------|
| **Project Name** | agent-insight — Hermes OTel/OTLP 北向适配 |
| **Input Sources** | [Phase1 需求分析](phase1-requirements-analysis.md) v0.2 + [Phase2 需求设计](phase2-requirements-design.md) v0.2 |
| **Plan Type** | New Feature Development（北向多平台适配） |
| **Estimated Effort** | Medium |
| **Parallel Execution** | YES - 2 Waves（+ FINAL）|
| **Critical Path** | T001 → T002 → T003 → F1-F4 |

## §2 Change Scope

### 2.1 Initial Requirements

```text
1. agent-insight 北向兼容多 agent 平台，当前已适配 opencode，目标新增适配 hermes；
2. hermes 通过标准 OpenTelemetry (OTel/OTLP) 协议接入。
```

### 2.2 Key Clarifications

- 适配深度：观测/链路追踪为本期核心(P0)，评测随 Execution 入库承接(P1/P2)，Skill 优化为未来（用户未答弹窗，按默认假设推进）。
- OTLP 编码：HTTP/JSON 为主路径复用现有端点；protobuf/gRPC 仅显式拒绝 + 可扩展位，不实现。
- span 语义：假设遵循/可配置 GenAI 语义约定；以映射表 + 降级保留兜底自定义属性，**交付前需真实样本校准（T001）**。
- 接入引导：提供（安装脚本四副本 + 共享常量 + Claude 风格配置指引）。
- 关键设计决策：零 schema 迁移；引入可单测 OTLP 适配层；traces 端点鉴权收敛为 401（受控破坏性变更，仅 traces）。

### 2.3 Module Change Details

| Status | Module | Change Description | Constraints |
|------|------|----------|------|
| 🟢 New | `src/lib/ingest/otel/`（otel-trace-mapper / semantic-mapping / framework-resolver / payload-guard / **agent-semantics**）| OTLP span→内部模型映射、语义兜底、framework 解析、体量防护、**agent 身份/skill 标记契约** | 纯函数、无 DB I/O |
| 🟢 New | `src/lib/ingest/frameworks.ts` | 已知框架共享常量（name/value/接入方式）| 仅声明，无逻辑 |
| 🟡 Modified | `src/app/api/ingest/otel/v1/traces/route.ts` | 鉴权收敛 401 + 防护 + 调用适配层 + 结构化日志 | 禁改 `/v1/logs`、`/v1/metrics` |
| 🟡 Modified | `src/lib/storage/data-service.ts::saveExecutionRecord`（:1937 门限）| **唯一存量改动点**：解除 `framework==='opencode'` 门，纳入 hermes 触发子 Agent 派生；经统一调度器抽 skill | **仅改 :1937 门限判断；opencode/claude/openclaw 既有路径行为零变更** |
| 🔴 Protected | `src/lib/storage/data-service.ts::deriveSubagentExecutions`（:2006-2112）| **不改**。被纳入 hermes 后消费「整形为 opencode 同构」的 interaction | 函数体冻结；hermes 同构由 agent-semantics 整形 |
| 🔴 Protected | `src/lib/engine/observability/agent-trace.ts::buildAgentCallTree`（:207）/`inferSubagentType` | **不改**。仅认 opencode 语义（`tool_calls[task]`/`subagent_type`/`subagent_session_id`/`role`，无 parentSpanId）| **禁止改其读 parentSpanId**；由适配层整形为同构后复用 |
| 🔴 Protected | `src/lib/engine/observability/agent-registration.ts::extractObservedAgentRegistrations`（**:14**，data-service:1801 调用）| **不改（框架无关）**。依据 interaction `agent/subagent_name/role` 自动注册 | 本期多半零改；如改也仅泛化 role 判定，保框架无关语义 |
| 🟡 Modified | `src/lib/storage/data-service.ts::extractInvokedSkillsFromSessionInteractions`（:476-492 调度器）| 新增 `fw==='hermes'` 分支（含子 Agent 加载 skill）| **仅改调度器分支** |
| 🟡 Modified | `src/lib/shared/interaction-utils.ts` | 新增 `extractSkillsWithVersionsFromHermesSession`（OTLP 形状）| 既有抽取函数冻结 |
| 🟡 Modified | `src/app/api/eval/rejudge/route.ts`（:60-66）| 内联 switch 改走统一调度器（补回 openclaw）| 对既有框架行为等价 |
| 🟡 Modified | `src/app/api/ingest/setup/route.ts` + `setup/auto/route.ts` | 四副本加入 hermes + 配置指引块，引用共享常量 | bash/PS×setup/auto 四处一致 |
| 🔴 Protected | `opencode/claude/openclaw` 既有分支（建树/派生/注册/skill 抽取）| 不改 | 防回退 |
| ⚪ Not Involved | `prisma/schema.prisma`、`otel/v1/logs`、`/v1/metrics` | 无迁移（agent 树/注册字段已存在）、不触碰 | 防误改 |

### 2.4 Functional Impact Details

| Change Type | Functional Node | Change Point | Corresponding Requirement |
|----------|----------|--------|----------|
| Add | OTLP 接入解析 | 适配层 + 语义映射兜底 + framework 显式解析 | FR-001/002/003/004 |
| Modify | 鉴权 | 缺/非法 Key → 401（限 traces）| BR-003/NFR-003 |
| Add | 健壮性 | 畸形/超限防护、缺 resourceSpans → 400 | FR-009/BR-006 |
| Add | 子 Agent 链路层级 | 整形为 opencode 同构后复用建树（UI 展示，零改建树）| FR-005/AC-003 |
| Add | 子 Agent 多 Execution 树 | 适配层整形为同构 + 解 :1937 门，复用 deriveSubagentExecutions | FR-010/AC-011/NFR-007 |
| Add | agent 注册 | 整形带 agent/subagent_name 标记，复用框架无关注册（自动生效，多半零改）| FR-011/AC-012 |
| Add | OTLP agent/skill 语义契约 | agent-semantics.ts 整形为 opencode 同构字段 | FR-013 |
| Modify | Skill 解析 | OTLP 形状 extractor + 版本 + 子 Agent 加载 skill | FR-012/AC-013 |
| Modify | 接入引导 | 四副本 + 配置指引 + 共享常量 | FR-006/NFR-005 |
| Modify | 评测承接 | 统一 skill 调度，主/子 Agent 可评测 | FR-008/AC-010 |
| Add | 可自检 | 结构化接入日志 | NFR-006 |

## §3 Technical Design

### 3.1 Tech Stack

- **Backend**: Next.js 16.1.4（App Router, Route Handlers）, Node.js ≥20, TypeScript 5.x
- **DB/ORM**: Prisma 5.22 + SQLite（本期不迁移）
- **Telemetry**: OpenTelemetry OTLP/HTTP-JSON（复用既有端点）
- **Test**: Node test runner + tsx（项目既有），新增适配层单测

### 3.2 Core Decisions

#### Decision 1: 复用 OTLP traces 端点 + 零 schema 迁移
**Rationale**: `Execution.framework` 自由字符串、看板筛选项动态派生，hermes 天然可观测；改动面最小、向后兼容最强。
**Alternative**: 新建 hermes 专用端点/表（否决：重复造轮、增加维护面）。

#### Decision 2: 抽出可单测 OTLP 适配层（Adapter）
**Rationale**: 当前逻辑内联在 route 难测难扩展；纯函数适配层为下一个框架提供低成本扩展点。
**Alternative**: 继续在 route 内联加分支（否决：route 膨胀、不可测、加深技术债）。

#### Decision 3: traces 鉴权收敛 401（受控破坏性变更）
**Rationale**: 多租户隔离硬需求；当前匿名兜底存在越权写入风险；首方调用方（Claude=logs、OpenCode=upload）零影响。
**Alternative**: 维持匿名兜底（否决：违反 BR-003/NFR-003）。仅限 traces，不动 logs。

### 3.3 Data Model

无 schema 变更。interaction JSON 新增可选字段 `raw` / `_degraded` / `_truncated`（向后兼容，旧消费者忽略）。详见 [Phase2 §5](phase2-requirements-design.md)。

### 3.4 Interface Contracts

- **POST `/v1/traces`**（重写至 `/api/ingest/otel/v1/traces`）：Header `x-witty-api-key`(必填) + `Content-Type: application/json`；Body OTLP `resourceSpans`（要求 `service.name=hermes`）；错误码 400/401/413/415。
- 内部纯函数契约 IF-N01~N04、IF-M01~M02 见 [Phase2 §6](phase2-requirements-design.md)。

## §4 Task Breakdown

### 4.1 Upstream Gap Analysis

- **G1 hermes 真实 span 属性命名未知**：以 T001 采集真实样本校准映射表；无样本前先用「标准 gen_ai.* + 降级保留」实现，样本到位后补映射条目。（Status: Default Applied，待 T001 收敛）
- **G2 性能绝对阈值无基线**：固定测量条件（≤500 span/批、同 taskId 串行、SQLite 单实例），数值由 F3 压测回填。（Status: Default Applied）
- **G3 子 Agent 层级重建依赖样本结构**：FR-005/AC-003 列为 P1，置于 Phase 2；若 T001 样本无多 Agent 结构，则按 parentSpanId 通用树重建实现并以构造样本验证。（Status: Resolved by 通用实现）
- **G4 体量上限默认值**：默认单批体 ~8MB、单字段沿用既有 `SKILL_INSIGHT_MAX_TOOL_IO`/`MAX_EVENT_STRING`，可配置。（Status: Default Applied）

### 4.2 Task Organization Strategy

**Organization Method**: Hybrid（按架构耦合分组 + 按依赖分层）。

**Rationale**:
- Phase 1 聚焦「接入入库」核心链路（适配层 → route），是一切下游能力的前提，构成 MVP。
- Phase 2 聚焦「下游打通 + 接入体验」（评测 skill 调度统一、安装引导、子 Agent 层级），彼此低耦合、可并行。
- 适配层与 route 强耦合、串行；评测/安装/层级三者独立，归同一 wave 并行。

**MVP Scope**:
- **Phase 1 (MVP)**: hermes OTLP/JSON 上报 → 鉴权 → 解析归并 → framework=hermes 入库并在看板可见（FR-001/002/003/009 + 安全/健壮性）。
- **Phase 2 (Incremental)**: **skill 与 subagent 一等公民**（FR-010/011/012/013）、评测承接（FR-008）、接入引导（FR-006）、子 Agent 链路层级（FR-005）、自定义属性映射定稿（FR-004）。

### 4.3 需求覆盖矩阵（FR/NFR → Task → AC）

| 需求 | Task | 验收 |
|-|-|-|
| FR-001 接入 | T002, T003 | AC-001 |
| FR-002 解析归并 | T002, T003 | AC-001, AC-002 |
| FR-003 framework 标识 | T002(resolver), T003 | AC-001 |
| FR-004 自定义属性兜底 | T001, T002(degrade) | AC-008 |
| FR-005 子 Agent 链路层级 | T006 | AC-003 |
| FR-006 接入引导 | T005 | AC-006 |
| FR-007 不支持编码反馈 | T003 | AC-004 |
| FR-008 评测承接(主/子) | T004, T009 | AC-010 |
| FR-009 畸形/超限 | T002(guard), T003 | AC-009 |
| **FR-010 子 Agent 多 Execution 树** | **T009** | AC-011 |
| **FR-011 agent 自动注册** | **T010** | AC-012 |
| **FR-012 skill 全链路解析** | **T004(扩) + T008** | AC-013 |
| **FR-013 OTLP agent/skill 语义契约** | **T007（依赖 T001）+ T008** | AC-011/012/013 |
| BR-003/NFR-003 鉴权隔离 | T003 | AC-004, AC-007 |
| NFR-001 存量不回退 | Must-NOT-do（各任务）+ F3(TC-005) + F4 | AC-005 |
| NFR-002 幂等/容错 | T002(per-span 跳过) + T003(串行幂等) | AC-002, AC-004 |
| NFR-004/005 可扩展/低成本 | T002(数据化映射), T005(共享常量) | — |
| NFR-006 可自检 | T003(结构化日志) | — |
| **NFR-007 与 opencode 等价** | **T009** | AC-011 |

## §5 Execution Waves

```text
Phase 1: 接入核心 (Wave 1)
Preconditions: Phase2 设计评审通过
├── T001: 采集真实 hermes OTLP trace 样本并校准映射规约 [Low]
├── T002: 新增 OTLP 适配层模块 (mapper/semantic/resolver/guard) + 单测 [High]
└── T003: 改造 traces/route.ts (鉴权401+防护+编排+日志) [Medium]
Deliverables: hermes http/json 上报端到端可入库, 看板出现 framework=hermes (AC-001/002/004/009)

Phase 2: Skill 与 Subagent 一等公民 (Wave 2)
Preconditions: Phase 1 完成 (入库正确) + T001 样本
├── T007: 定义 OTLP agent 身份/skill 语义契约 (FR-013, 依赖 T001) [Low]
├── T008: 适配层 agent-semantics 整形为 opencode 同构 interaction (扩 T002, 关键) [Medium]
├── T009: 解 :1937 门 + 复用建树/派生 (不改建树) 拆多条 Execution [Medium-High]
├── T010: agent 自动注册 (框架无关函数, 多半零改+验证) [Low]
└── T004: skill 全链路解析 (OTLP 形状 extractor + 版本 + 子 Agent 加载) + rejudge 统一 [Medium]
Deliverables: 多 Agent 拆多条 Execution+树 (AC-011)、自动注册 (AC-012)、skill 全链路 (AC-013)、主/子可评测 (AC-010)

Phase 3: 接入引导与链路展示 (Wave 3, 可与 Wave 2 部分并行)
Preconditions: Phase 1 完成 (T006 另需 T008/T009)
├── T005: 安装脚本四副本 + frameworks 共享常量 + hermes 配置指引 [Medium]
└── T006: 子 Agent 链路展示 (纯 UI 消费, 零改建树) [Low]
Deliverables: 安装引导可用 (AC-006)、链路层级展示 (AC-003)

Phase FINAL: Quality Validation & Delivery (Wave N)
Preconditions: All functional Phases completed
├── F1: Plan Compliance Audit
├── F2: Code Quality Review
├── F3: Real Scenario Manual QA (含并发幂等/压测回填性能/opencode 等价性)
└── F4: Scope Fidelity Check (重点核验冻结区: opencode 派生/注册/skill 抽取未被改)
Deliverables: 通过全部验收准则 (AC-001~013), 等待用户确认

Critical Path: T001 → T002 → T003 → T007 → T008 → T009 → F1-F4
Maximum Concurrency: Wave 2 (T008→T009/T010/T004 依赖 T007/T008 后并行) + Wave 3 (T005/T006)
```

## §6 Task List

### Phase 1: 接入核心

**Core Objective**: 让 hermes 以 OTLP/HTTP-JSON 上报后，经鉴权与防护被正确解析归并、以 framework=hermes 入库并在链路追踪看板可见。

**Independent Validation Criteria**:
- [ ] `node --import tsx --test src/lib/ingest/otel/*.test.ts` → PASS
- [ ] 构造 OTLP/JSON 上报（带有效 key, service.name=hermes）→ 看板 `framework=hermes` 会话出现、token/latency 非空
- [ ] 无 key 上报 → HTTP 401 且无写入；缺 resourceSpans → HTTP 400

**Git Commit**: YES — `feat(ingest): add hermes OTLP adapter and harden traces ingestion`

**Task List**:

---

- [ ] T001 采集真实 hermes OTLP trace 样本并校准映射规约 - `docs/design/hermes-otel-adapter/hermes-trace-sample.md`

   - **Delegate Subagent**: YES / researcher / Effort: Low / Parallelism: 可与 T002 骨架并行（T002 映射表定稿依赖本任务结论）
   - **What to do**:
     + 获取/构造一条真实 hermes 运行的 OTLP/HTTP-JSON trace（resourceSpans 原文），记录其 `service.name`、资源属性、span 属性键（是否 `gen_ai.*`/`llm.*`/`tool.name` 或自定义命名）、是否含 `session.id`、是否含父子 span。
     + 产出「hermes→内部模型」映射规约表（属性键对照 + skill 调用识别方式），供 T002 的 semantic-mapping 映射表与 T004 的 skill 抽取使用。
   - **Must NOT do**: 不改任何代码；不臆造属性命名（无法获取真实样本时，明确标注「假设」并给出最可能命名）。
   - **Parallelism Info**: Can Parallel: YES / Prerequisite: 无 / Blocking: T002(映射表定稿)、T004(skill 抽取)
   - **Reading List**:
     + Pattern: `src/app/api/ingest/otel/v1/traces/route.ts:88-140` - 现有属性解析方式
     + External: OpenTelemetry GenAI semantic conventions - 标准属性命名
   - **Acceptance Criteria**:
     + [ ] 样本文档含 ≥1 条真实/构造 trace 与映射对照表，标注每个属性的识别策略

---

- [ ] T002 新增 OTLP 适配层模块 + 单测 - `src/lib/ingest/otel/{otel-trace-mapper,semantic-mapping,framework-resolver,payload-guard}.ts`

   - **Delegate Subagent**: YES / coder / Effort: High / Parallelism: 与 T001 部分并行；映射表定稿待 T001
   - **What to do**:
     + `payload-guard.ts`：`guardPayload(rawSize, parsed)` → 体量上限（默认 ~8MB，可配置 G4）；`resourceSpans` 缺失/空 → 返回 `{ok:false, code:400}`；超大字段截断并返回 `truncatedFields`。
     + `semantic-mapping.ts`：`classify(attrs)`（llm/tool/other/infra）+ `mapSpan(span, resourceAttrs, table)`，标准 `gen_ai.*`/`llm.*`/`tool.name` + hermes 映射表；`other`（有效调用无标准语义）走降级保留 `raw`+`_degraded`；`infra` 跳过。
     + `framework-resolver.ts`：`resolveFramework(resourceAttrs)` 优先 `service.name`，缺失按兜底判定，hermes 契约校验（缺 service.name 告警，不静默落 unknown）。
     + `otel-trace-mapper.ts`：`mapOtlpTrace(body, resourceAttrs, apiUser)` 编排上述，输出 `{interactions[], taskId, framework, user, sessionMeta, stats}`；归并键 `session.id→service.instance.id→traceId`；按 spanId 去重、timestamp 排序。
     + **单 span 容错（NFR-002）**：逐 span `try/catch`，单条异常/非 GenAI span → 跳过并计数（`skippedCount`/`skipReasons`），**绝不中止整批**；其余 span 正常入库。
     + 全部为纯函数、无 DB I/O；附 `*.test.ts` 覆盖标准/自定义/降级/infra/畸形/超限/缺字段/缺 resourceSpans/**单 span 异常跳过**路径。
   - **Must NOT do**: 不在适配层访问 DB/网络；不改 route 行为（T003 负责接入）；不动既有 opencode/claude 解析。
   - **Parallelism Info**: Can Parallel: 部分（骨架）/ Prerequisite: T001(映射表) / Blocking: T003
   - **Reading List**:
     + Pattern: `src/app/api/ingest/otel/v1/traces/route.ts:6-21,71-151` - getValue 与归并逻辑（迁移参考）
     + API/Type: `src/lib/storage/data-service.ts:47-107` - ExecutionRecord/interaction 形状
   - **Recommended Skills**: `code-review`：模块成型后自查复用与边界
   - **Acceptance Criteria**:
     + [ ] `node --import tsx --test src/lib/ingest/otel/*.test.ts` → PASS（含上述全部分支用例）
   - **QA Scenario**:
   ```
   Scenario: 自定义属性降级保留
     Tool: 单测
     Preconditions: 构造一条非标准命名的有效调用 span
     Steps: 1. 调 mapSpan 2. 检查输出
     Expected Result: 返回 interaction._degraded=true 且 raw 含原始属性, 未被丢弃
     Evidence: .sisyphus/evidence/task-T002-degrade.txt
   ```

---

- [ ] T003 改造 traces/route.ts：鉴权收敛 + 防护 + 调用适配层 + 结构化日志 - `src/app/api/ingest/otel/v1/traces/route.ts`

   - **Delegate Subagent**: YES / coder / Effort: Medium / Parallelism: 依赖 T002
   - **What to do**:
     + 鉴权最先生效：`x-witty-api-key` 缺失/非法 → 401、不写入（D-003）；早于编码判定（protobuf 仍 415 但在 401 之后）。
     + 调 `guardPayload` 做体量/结构校验；缺 resourceSpans → 400。
     + 用 `mapOtlpTrace` 替换内联解析；以「同 taskId 串行键互斥 + spanId 集合幂等合并」写入会话（Phase2 §2.2.2 选定方案），再复用 `saveExecutionRecord`。
     + **透传 agent 身份**：把 mapper 解析出的 `agentName/agentType` 传入 `saveExecutionRecord`（当前调用未传，:194-205），并确保整形后的 agent/skill 标记已写入 interaction，供下游建树/注册/skill 消费。
     + 输出结构化接入日志（NFR-006 字段：taskId/framework/authResult/spanTotal/mappedCount/skippedCount/skipReasons/degradedCount/truncatedFields/httpCode）。
   - **Must NOT do**: 不改 `/v1/logs`、`/v1/metrics` 的 route；不改 `saveExecutionRecord` 内部；不破坏既有 OPTIONS/CORS。
   - **Parallelism Info**: Can Parallel: NO / Prerequisite: T002 / Blocking: Phase 2
   - **Reading List**:
     + Pattern: `src/app/api/ingest/otel/v1/traces/route.ts:23-220` - 现有编排（重构对象）
     + Pattern: `src/app/api/ingest/setup/route.ts:323-325` - Claude logs 端点（确认不受影响）
   - **Acceptance Criteria**:
     + [ ] 有效 key + service.name=hermes 上报 → 200，看板出现 framework=hermes
     + [ ] 无/错 key → 401 且 DB 无新增；缺 resourceSpans → 400；protobuf → 415
     + [ ] 分 3 批（含重复 spanId）并发上报同一会话 → interaction 无重复、聚合正确
   - **QA Scenario**:
   ```
   Scenario: 并发幂等
     Tool: curl/脚本并发
     Preconditions: 平台运行, 有效 key
     Steps: 1. 同 taskId 并发 POST 3 批(含重复 spanId) 2. 查看会话
     Expected Result: interaction 去重 100%, token/latency 聚合正确 (AC-002)
     Evidence: .sisyphus/evidence/task-T003-idempotency.txt
   ```

---

### Phase 2: Skill 与 Subagent 一等公民

**Core Objective**: hermes 多 Agent 运行拆为多条 Execution 并组成树（与 opencode 等价）、主/子 Agent 自动注册、skill（含子 Agent 加载）全链路解析并打通评测/A-B/优化。

**Independent Validation Criteria**:
- [ ] 含 1 主+M 子 Agent 的 hermes 运行 → 生成 1+M 条 Execution，子 Agent parent/root/isSubagent 链正确（AC-011）
- [ ] hermes 主/子 Agent 出现在 RegisteredAgent（platform=hermes），重复上报不重复（AC-012）
- [ ] hermes 主+子 Agent 加载的 skill 均入 invokedSkills（带版本），Skill 诊断/路由评测显示非空（AC-013）
- [ ] 与等价 opencode 运行的 agent 树结构一致（NFR-007）

**Git Commit**: YES — `feat(hermes): first-class skill & subagent ingestion (agent tree, registration, skill parsing)`

**Task List**:

---

- [ ] T007 定义 OTLP agent 身份/skill 语义契约 - `docs/design/hermes-otel-adapter/hermes-trace-sample.md`（追加契约表）

   - **Delegate Subagent**: YES / researcher / Effort: Low / Parallelism: 依赖 T001
   - **What to do**:
     + 据 T001 真实样本，定稿 hermes 在 OTLP 中标识：agent 名/类型、父子关系（parentSpanId/agent 边界 span）、agent 会话、skill 调用（tool.name + arguments 中的 skill/version）、子 Agent 加载的 skill 的属性约定。
     + 产出契约表（内部语义 ↔ OTLP 属性键），作为 T008/T009/T010/T004 的唯一依据；同步到 hermes 接入文档（T005 配置指引引用）。
   - **Must NOT do**: 不改代码；契约缺省值需与 Phase2 §4.2 表一致，偏差需显式标注。
   - **Parallelism Info**: Can Parallel: NO / Prerequisite: T001 / Blocking: T008/T009/T010/T004
   - **Acceptance Criteria**:
     + [ ] 契约表覆盖 agent 名/类型/父子/会话/skill/子 Agent skill 六项，每项给出 OTLP 属性来源与缺省兜底

---

- [ ] T008 适配层 agent-semantics：把 hermes OTLP 整形为 opencode 同构 interaction - `src/lib/ingest/otel/agent-semantics.ts`(新增), `src/lib/ingest/otel/otel-trace-mapper.ts`(扩展)

   - **Delegate Subagent**: YES / coder / Effort: Medium / Parallelism: 依赖 T007；阻塞 T009/T010/T004
   - **What to do**:
     + 新增 `agent-semantics.ts`：纯函数 `toOpencodeShape(span/interactions, resourceAttrs, table)`（IF-N05），把 OTLP（`parentSpanId` + agent 名/类型/会话 + skill 语义）**整形为 `buildAgentCallTree`/注册函数期望的 opencode 同构字段名**：`tool_calls[].name='task'`、`subagent_type`、`subagent_session_id`、`role`、`agent`/`subagent_name`，以及规范化 skill 标记。**这是关键工作量——不要发明自定义键名，必须匹配下游消费者已读取的字段。**
     + `otel-trace-mapper` 产出 interaction 时附带上述同构字段（可选、向后兼容）。
     + 单测覆盖：标准/缺失 agent 名/子 Agent(spawn 边界)/带版本 skill/无 skill 路径；并断言输出字段名与 `agent-trace.ts`/`agent-registration.ts` 读取的键一致。
   - **Must NOT do**: 不访问 DB；不改既有框架解析；不改 buildAgentCallTree/注册函数；标记字段仅可选新增。
   - **Parallelism Info**: Can Parallel: NO / Prerequisite: T007, T002 / Blocking: T009/T010/T004
   - **Reading List**:
     + Pattern: `src/lib/engine/observability/agent-trace.ts:207,408,428-430,498,692,703-705` - buildAgentCallTree 读取的 opencode 字段（task/subagent_type/subagent_session_id/role）
     + Pattern: `src/lib/engine/observability/agent-registration.ts:14` - 注册函数读取的 agent/subagent_name/role
   - **Acceptance Criteria**:
     + [ ] `node --import tsx --test src/lib/ingest/otel/agent-semantics.test.ts` → PASS（含「输出字段名 == 下游消费者期望键名」断言）

---

- [ ] T009 hermes 子 Agent 多 Execution 树（解门限 + 复用建树，**不改建树**） - `src/lib/storage/data-service.ts`(**仅 :1937 门限**)

   - **Delegate Subagent**: YES / coder / Effort: Medium-High / Parallelism: 依赖 T008
   - **What to do**:
     + **唯一存量改动**：解除 `saveExecutionRecord` 中 `deriveSubagentExecutions` 的 `framework==='opencode'` 门限（:1937），泛化为「opencode 或 hermes」。
     + **不改 `buildAgentCallTree` 与 `deriveSubagentExecutions` 函数体**——它们直接消费 T008 整形后的 opencode 同构 interaction（`tool_calls[task]`/`subagent_type`/`subagent_session_id`/`role`），产出多条 Execution（`parentExecutionId/rootExecutionId/agentSessionId/subagentType/subagentName/isSubagent`，字段已存在，无迁移）。
     + **本任务的真实难点在 T008 的整形质量**——若树不对，先修 T008 整形而非改建树。
     + 加等价性测试：同构多 Agent 运行，hermes 与 opencode 产出同构树（NFR-007）。
   - **Must NOT do**: **禁止改 `buildAgentCallTree`/`deriveSubagentExecutions` 函数体（尤其禁止让建树读 `parentSpanId`）**；不动 opencode 分支；不加 DB 字段/迁移。
   - **Parallelism Info**: Can Parallel: 与 T010/T004 部分并行 / Prerequisite: T008 / Blocking: 无
   - **Reading List**:
     + Pattern: `src/lib/storage/data-service.ts:1937-1949,2006-2112` - 门限与 deriveSubagentExecutions（只读，理解输入）
     + Pattern: `src/lib/engine/observability/agent-trace.ts:207-451,690-705` - 建树读取的 opencode 字段（确认整形目标）
   - **Acceptance Criteria**:
     + [ ] 1 主+M 子 Agent 运行 → 1+M 条 Execution；子行 isSubagent=true、parent/root 链正确；按 rootExecutionId 聚合得全树
     + [ ] opencode 既有多 Agent 用例回归不变（树结构、Execution 条数一致）；`buildAgentCallTree`/`deriveSubagentExecutions` 函数体 git diff 为空
   - **QA Scenario**:
   ```
   Scenario: 子 Agent 多 Execution 树与 opencode 等价
     Tool: 单测 + 看板
     Preconditions: 构造同构的 hermes 与 opencode 多 Agent 运行(1主+M子)
     Steps: 1. 分别上报 2. 对比 Execution 树
     Expected Result: hermes 生成 1+M 条 Execution; 与 opencode 树结构同构 (AC-011/NFR-007)
     Evidence: .sisyphus/evidence/task-T009-subtree.txt
   ```

---

- [ ] T010 agent 自动注册 hermes 路径（**框架无关函数，多半零改 + 验证**） - `src/lib/engine/observability/agent-registration.ts:14`（如需）, 验证 `src/lib/storage/data-service.ts:1801-1842` 调用

   - **Delegate Subagent**: YES / coder / Effort: Low / Parallelism: 依赖 T008
   - **What to do**:
     + **首选「零改 + 验证」**：`extractObservedAgentRegistrations`（`agent-registration.ts:14`）框架无关、从 interaction 的 `agent/subagent_name/role` 读取，且 data-service:1801 调用已对任意非空 framework 执行。只要 T008 整形使 hermes interaction 携带这些标记，注册即自动生效——**优先只补测试验证，不改函数**。
     + 仅当验证发现 hermes 标记无法被现有 `role` 判定接纳时，才**最小泛化** role 判定以接纳 hermes 标记（保持框架无关语义，不引入 per-framework 分支）。
   - **Must NOT do**: 不引入 per-framework if/switch；不破坏既有框架注册；无 agent 名时回退单主 Agent，不报错。
   - **Parallelism Info**: Can Parallel: 与 T009/T004 / Prerequisite: T008 / Blocking: 无
   - **Reading List**:
     + Pattern: `src/lib/engine/observability/agent-registration.ts:14` - 框架无关注册逻辑（读取字段）
     + Pattern: `src/lib/storage/data-service.ts:1801-1842` - 调用处（platform 来源）
   - **Acceptance Criteria**:
     + [ ] hermes 主/子 Agent 首次上报后出现于 RegisteredAgent（platform=hermes，agentType 正确）；重复上报无重复行
     + [ ] 既有框架注册行为不变（若改了函数，opencode/claude 注册回归通过）

---

- [ ] T004 skill 全链路解析（OTLP 形状）+ 统一调度 + rejudge - `src/lib/shared/interaction-utils.ts`, `src/lib/storage/data-service.ts:476-492`, `src/app/api/eval/rejudge/route.ts:60-66`

   - **Delegate Subagent**: YES / coder / Effort: Medium / Parallelism: 依赖 T008；与 T009/T010 并行
   - **What to do**:
     + `interaction-utils.ts` 新增 `extractSkillsWithVersionsFromHermesSession`：解析 **OTLP 形状**（`interaction.toolCall:{name,arguments(字符串)}`），`toolCall.name∈{skill,load_skill}` 时从 arguments 解析 `skill/skill_name/name` 与 `version`。
     + **覆盖子 Agent 加载的 skill**：对齐 opencode `task.load_skills` 语义，借 T008 的 agent 身份标记把 skill 归属到对应 agent，一并并入 invokedSkills。
     + 调度器 `extractInvokedSkillsFromSessionInteractions` 新增 `fw==='hermes'` 分支；`rejudge/route.ts:60-66` 内联 switch 改走该调度器（**补回遗漏的 openclaw**）。
   - **Must NOT do**: 不改既有 opencode/claude/openclaw 抽取函数实现；不改 saveExecutionRecord 既有分支。
   - **Parallelism Info**: Can Parallel: YES(T009/T010) / Prerequisite: T008（skill 标记）/ Blocking: 无
   - **Reading List**:
     + Pattern: `src/lib/shared/interaction-utils.ts:55-178` - 既有抽取函数风格（注意形状差异）
     + API/Type: `src/lib/storage/data-service.ts:476-492` - 调度器现状（未知框架返 null）
     + Pattern: `src/app/api/eval/rejudge/route.ts:60-66` - 重复 switch
   - **Acceptance Criteria**:
     + [ ] hermes 主 Agent 与子 Agent 加载的 skill 均入 invokedSkills（带版本，若上报含）
     + [ ] Skill 诊断/路由评测显示「实际调用 skill」非空；既有框架 rejudge 行为不变；openclaw 现可抽取
   - **QA Scenario**:
   ```
   Scenario: skill 全链路(含子 Agent 加载)
     Tool: 单测 + 看板
     Preconditions: hermes 运行主 Agent 调 skillA、子 Agent 加载 skillB(带版本)
     Steps: 1. 按契约上报 2. 查看 invokedSkills 与 Skill 诊断
     Expected Result: invokedSkills 含 skillA、skillB 及版本; 可发起 A-B/优化 (AC-013)
     Evidence: .sisyphus/evidence/task-T004-skill.txt
   ```

---

### Phase 3: 接入引导与链路展示

**Core Objective**: 安装引导可用、子 Agent 链路层级展示。

**Independent Validation Criteria**:
- [ ] 安装脚本（bash/PS × setup/auto）均出现 Hermes 选项并输出配置指引（AC-006）
- [ ] 含父子 span 的 hermes 会话层级深度=上报深度（AC-003）

**Git Commit**: YES — `feat(hermes): install guide and sub-agent hierarchy view`

**Task List**:

---

- [ ] T005 安装脚本四副本 + frameworks 共享常量 + hermes 配置指引 - `src/lib/ingest/frameworks.ts`(新增), `src/app/api/ingest/setup/route.ts`, `src/app/api/ingest/setup/auto/route.ts`

   - **Delegate Subagent**: YES / coder / Effort: Medium / Parallelism: 与 T006 及 Wave 2 各任务并行（仅依赖 Phase 1）
   - **What to do**:
     + 新增 `frameworks.ts` 共享常量：`[{name,value,onboard:'plugin'|'env'}]`，含 `{name:'Hermes',value:'hermes',onboard:'env'}`。
     + 四处选择器（setup bash :80-84 / PS :540-544；auto bash / PS）引用共享常量加入 hermes。
     + hermes 为 env 接入（非插件下载）：参照 Claude 配置块（`setup/route.ts:300-344`）输出 hermes OTLP exporter 配置指引（endpoint=`/v1/traces`、`x-witty-api-key`、`OTEL_EXPORTER_OTLP_PROTOCOL=http/json`、`service.name=hermes`）。
   - **Must NOT do**: 不改 opencode/claude/openclaw 既有安装分支逻辑；保持 bash/PS 四副本一致。
   - **Parallelism Info**: Can Parallel: YES(T006, Wave 2 各任务) / Prerequisite: 无 / Blocking: 无
   - **Reading List**:
     + Pattern: `src/app/api/ingest/setup/route.ts:80-84,151-159,300-344` - 选择器、安装 flag、Claude env 块
     + Pattern: `src/app/api/ingest/setup/auto/route.ts` - 第二处副本
   - **Acceptance Criteria**:
     + [ ] 四处脚本生成结果均含 Hermes 选项；选 hermes 后输出可复制 OTLP 配置指引
     + [ ] opencode/claude/openclaw 安装路径无变化

---

- [ ] T006 子 Agent 链路展示（**纯 UI 消费，零改建树**） - 验证 `src/components/observe/AgentTraceView.tsx`

   - **Delegate Subagent**: YES / coder / Effort: Low / Parallelism: 与 T005 并行
   - **What to do**:
     + `AgentTraceView` 客户端已用 `buildAgentCallTree(interactions)` 渲染层级。因 T008 已把 hermes 整形为 opencode 同构 interaction，链路视图对 hermes **自动生效**——本任务**仅做验证 + 必要的 UI 边界适配**，不改建树。
     + 用 T001 样本或构造的多 Agent 样本验证层级展示。
   - **Must NOT do**: **不改 `buildAgentCallTree`**（由 T009 守护其不变）；不引入框架分支。
   - **Parallelism Info**: Can Parallel: 与 T005 / **Prerequisite: T008、T009（消费其整形与解门限结果，不并改建树）** / Blocking: 无
   - **Reading List**:
     + Pattern: `src/components/observe/AgentTraceView.tsx:375` - 客户端建树渲染
   - **Acceptance Criteria**:
     + [ ] 含父子 span 样本：链路视图层级深度=上报深度，子 Agent 挂载于父之下；`buildAgentCallTree` 未被本任务改动
   - **QA Scenario**:
   ```
   Scenario: 子 Agent 层级还原
     Tool: 单测 + 看板
     Preconditions: 构造 1 主 + ≥1 子 Agent 的 hermes 样本(深度 D)
     Steps: 1. 上报 2. 查看链路
     Expected Result: 还原深度=D, parentSpanId 链一致 (AC-003)
     Evidence: .sisyphus/evidence/task-T006-hierarchy.txt
   ```

---

## §7 Phase FINAL: Quality Validation & Delivery

**Objective**: 确保全部需求实现、质量达标、可交付。

**Validation Criteria**:
- [ ] 全部验收准则 AC-001~AC-013 通过
- [ ] 代码质量检查通过（lint/type/test）
- [ ] 真实场景手测通过（含并发幂等、性能回填、**子 Agent 树与 opencode 等价**）
- [ ] 用户明确确认交付

**Task List**:

---

- [ ] F1 Plan Compliance Audit
   - **Validation Content**: 实现满足 Phase1 全部 FR/NFR 与 AC-001~013（含 FR-010~013 subagent/skill 一等公民）
   - **Output Format**:
   ```
   Must Have [N/N Pass]
   Must NOT Have [N/N Pass]   (冻结区未改 / 不支持编码显式拒绝)
   Requirement Coverage [N/N FR&NFR Implemented]
   Evidence Files [N/N Exist]
   VERDICT: APPROVE / REJECT
   ```
   - **Parallelism Info**: Can Parallel: YES / Prerequisite: All functional Phases

---

- [ ] F2 Code Quality Review
   - **Validation Content**: 代码质量、适配层单测覆盖、复用度
   - **Output Format**:
   ```
   Lint: PASS / FAIL
   Type Check: PASS / FAIL
   Tests: N pass / N fail
   Code Smells: N issues
   VERDICT: APPROVE / REJECT
   ```
   - **Parallelism Info**: Can Parallel: YES / Prerequisite: All functional Phases

---

- [ ] F3 Real Scenario Manual QA
   - **Validation Content**: 主成功场景 S-001；备选/异常 S-002~S-010；边界（空输入、超大输入、并发）；**存量框架回归 TC-005（opencode/claude/openclaw）→ 全通过（AC-005/NFR-001 显式归属）**；性能压测回填 §7.2 阈值
   - **Perf 测量命令（回填模板）**：
   ```
   # 测量条件: 单批 500 span, 同 taskId 串行, SQLite 单实例
   ab -n 200 -c 8 -p sample-500span.json -T application/json \
      -H "x-witty-api-key:$KEY" http://localhost:3000/v1/traces
   # 断言: P95 处理时延 < [回填]ms; 无 5xx; 无 OOM
   ```
   - **Output Format**:
   ```
   Scenarios [N/N pass]
   Edge Cases [N tested]   (并发幂等 AC-002 / 超限 AC-009 / 多租户 AC-007)
   Existing-framework regression TC-005 [N/N pass]   (AC-005)
   Integration [N/N pass]
   Perf baseline filled: YES/NO (P95=___ms)
   VERDICT: APPROVE / REJECT
   ```
   - **Parallelism Info**: Can Parallel: YES / Prerequisite: All functional Phases

---

- [ ] F4 Scope Fidelity Check
   - **Validation Content**: git diff 是否越界；对照 §2.3；**重点核验冻结区函数体 git diff 为空：`deriveSubagentExecutions`（data-service.ts:2006）、`buildAgentCallTree`（agent-trace.ts:207，尤其未读 parentSpanId）、`extractObservedAgentRegistrations`（agent-registration.ts:14）、既有框架 skill 抽取分支；`prisma schema` 无迁移、`/v1/logs`/`/v1/metrics` 未被改**；确认 hermes 接入仅由「适配层整形 + `data-service.ts:1937` 解门限 + 调度器 hermes 分支」实现；每个任务仅改其描述文件
   - **Output Format**:
   ```
   Authorized Changes [N/N files]
   Unauthorized Changes [N files - list paths]
   Scope Creep [CLEAN / N issues]
   VERDICT: APPROVE / REJECT
   ```
   - **Parallelism Info**: Can Parallel: YES / Prerequisite: All functional Phases

## §8 Appendix

### 8.1 Development Strategies

- **Delegate Tasks**: 任务执行委派子 Agent，避免主 Agent 上下文膨胀。
- **Multi-Agent**: Wave 2（T009/T010/T004 依赖 T008 后并行）+ Wave 3（T005/T006）并行派发。
- **TDD**: T002/T003/T008 先写测试用例再实现；适配层纯函数优先单测；T009 必须含「与 opencode 等价」对比测试。
- **样本/契约先行**: T001→T007 阻塞 agent/skill 解析定稿，优先完成。

### 8.2 Risk List

| Risk | Impact | Mitigation Measures |
|------|------|----------|
| hermes 真实属性命名与假设不符 | High | T001 样本 + T007 契约先行；映射表数据化、可快速补条目；降级保留兜底 |
| hermes 的 agent 身份/skill 在 OTLP 中无明确表示 | High | T007 契约定稿；缺失时退化单主 Agent、skill 返空，不报错；据样本演进 |
| 实现者误改 buildAgentCallTree 去读 parentSpanId（撞冻结区）| High | 设计已明确「整形复用而非改建树」；T008 整形为同构字段、T009 仅解 :1937 门；F4 核验建树函数体 diff 为空 |
| hermes→opencode 同构整形不正确致树错 | High | T008 单测断言「输出字段名==下游期望键」；先修整形而非改建树；T001 样本校准 |
| 鉴权收敛影响未知第三方 keyless 采集器 | Medium | 文档显式声明破坏性变更；仅限 traces；提供配置指引 |
| SQLite 并发写丢 span | Medium | 同 taskId 串行键互斥 + spanId 集合幂等（已定稿）；F3 并发用例验证 |
| T006/T009 依赖 T008 整形质量 | Medium | T008 先行并充分单测；T006/T009 仅消费，不并改建树 |
| 安装脚本四副本漂移 | Low | 抽共享常量 frameworks.ts；F4 核验一致 |

### 8.3 Coding Notes

- 适配层纯函数、无副作用，禁直接 DB/网络访问。
- 鉴权最先生效；所有异常路径返回确定性 4xx（非 5xx），不部分写入。
- 新增 interaction 字段均可选，旧消费者忽略未知字段；不改既有字段语义。
- 严守冻结区：`deriveSubagentExecutions`/`buildAgentCallTree`/`extractObservedAgentRegistrations` **函数体不动**、既有框架 skill 抽取分支、prisma schema、`/v1/logs`、`/v1/metrics`。
- 核心范式：**hermes 接入 = 适配层把 OTLP 整形为 opencode 同构 interaction + `data-service.ts:1937` 解门限 + 调度器/setup 新增 hermes 分支**；共享建树/注册函数只复用、不改（如必须改则仅最小防御扩展且 opencode 回归守护）。

---

## 变更记录（合成文档）

| 版本 | 内容 |
|-|-|
| v0.1 | Phase1/2/3 三阶段初稿，各自通过独立 reviewer 闸门（P1 84 条件通过→修订；P2 73 条件通过→修订；P3 Pass）|
| v0.2 | 可行性验证修订：rejudge 第二处 switch 统一化、framework 兜底澄清、缺 resourceSpans 确定性 400、并发幂等定稿、setup 四副本+共享常量 |
| v0.3 | **refine：skill / subagent 一等公民**——新增 FR-010/011/012/013、NFR-007、BR-007/008/009、AC-011/012/013、D-004/D-005、§2.2.4/2.2.5、IF-N05、任务 T007~T010 与 T004 升级 |
| v0.3.1（本合成） | 据代码二次核对修正两处 ERROR：①`extractObservedAgentRegistrations` 实为 `agent-registration.ts:14` 框架无关函数（不加分支、靠标记自动注册）；②`buildAgentCallTree` 无 parentSpanId 能力，改为「适配层把 hermes 整形为 opencode 同构 interaction，建树/派生/注册函数零改动」。同步收敛冻结区与任务边界（T008 整形为关键、T009 仅解 :1937 门、T010 多半零改、T006 纯 UI 消费）|

> 注：本文件为三阶段 + refine + 代码核对修正的**合成终稿**，取代此前的分阶段草稿与 .refine 副本。
