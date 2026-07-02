# Hermes 平台适配（OTel / OTLP 接入）— 开发计划（SDD）
版本：v0.4.1
最后更新：2026-06-10

> 文档类型：Phase3 开发计划 ｜ base_commit：d72f05e（master）｜ 更新时间：2026-06-10 ｜ 状态：待 Phase3 评审（v0.4.1：补客户端插件一键安装闭环 + 对齐同批两线）
>
> **v0.4 关键修订**（详见 [Phase2 §2.0/§8.4](phase2-requirements-design.md) 与 [Phase1 v0.4](phase1-requirements-analysis.md)）：
> 1. **新增客户端插件接入任务**（T000）：hermes 内核无 OTel，**复用开源 `briancaffey/hermes-otel`** 配 `otlp` 后端指向平台——这是 v0.3 完全缺失的上游适配器。
> 2. **服务端落同批两线目标架构**：traces 端点退薄壳（`otel-spool-consumer`），hermes 映射下沉到 `traces-aggregator`；skill/整形走 `framework-adapter-registry` 的 `getAdapter('hermes')`，**不改 route 内联落库、不加 dispatcher 裸分支**。
> 3. **撤销强 401 收敛**（端点鉴权归 spool-consumer 后续轮）；**框架清单并入 registry 的 `listFrameworks()`**（取消独立 `frameworks.ts`）。
>
> **v0.4.1 补充**：T000/T005 纳入「一键 curl 安装」设计。脚本必须以 `$HERMES_HOME` 探测 Hermes 正式安装目录和 runtime venv，自动安装/启用 `hermes_otel`，把 OTel 依赖装进 Hermes 自身 venv，并写入/提示 `otlp` 后端配置；不得 hardcode README 示例的 `~/git/hermes-agent/venv/bin/pip`。
>
> **v0.4.1 编码校正**：据 `hermes-otel` 代码核实，当前插件使用 `opentelemetry-exporter-otlp-proto-http`，首次真实上报可能是 OTLP/HTTP protobuf。平台当前 JSON-only 端点若返回 415，不视为插件安装失败，而是进入后续服务端 protobuf 支持或临时 capture/proxy 取样的技术决策。
>
> **跨线依赖（同批未开发，需协调落地次序）**：
> - 依赖 `otel-spool-consumer` 提供：薄壳 traces 端点、`traces-aggregator.aggregateOtelTraceSession`、`OtelTraceEvent` 类型、后台消费者 + 检查点。hermes 把纯函数插进 aggregator。
> - 依赖 `framework-adapter-registry` 提供：`getAdapter`/`resolveFrameworkId`/`listFrameworks`、`FrameworkAdapter` 接口（含 `extractSkills?` 与预留 `capabilities`）。hermes 注册 `adapters/hermes.ts`。
> - 回退：任一线滞后则 hermes 走临时同步路径（route 内聚合落库 / dispatcher 标注待收编分支），落地后切回，F4 核验不得固化。

## §1 Project Overview

| Information | Content |
|------|------|
| **Project Name** | agent-insight — Hermes OTel/OTLP 北向适配 |
| **Input Sources** | [Phase1 需求分析](phase1-requirements-analysis.md) v0.2 + [Phase2 需求设计](phase2-requirements-design.md) v0.2 |
| **Plan Type** | New Feature Development（北向多平台适配） |
| **Estimated Effort** | Medium |
| **Parallel Execution** | YES - 2 Waves（+ FINAL）|
| **Critical Path** | T000 → T001 → T002 → T003 → F1-F4 |

## §2 Change Scope

### 2.1 Initial Requirements

```text
1. agent-insight 北向兼容多 agent 平台，当前已适配 opencode，目标新增适配 hermes；
2. hermes 通过标准 OpenTelemetry (OTel/OTLP) 协议接入。
```

### 2.2 Key Clarifications

- 适配深度：观测/链路追踪为本期核心(P0)，评测随 Execution 入库承接(P1/P2)，Skill 优化为未来（用户未答弹窗，按默认假设推进）。
- OTLP 编码：平台现有端点以 HTTP/JSON 为主路径；但 `hermes-otel` 当前实际使用 OTLP/HTTP protobuf exporter。Phase 0 真实上报需先确认是否 415；若 415，后续在服务端 protobuf 解码与客户端侧临时 capture/proxy 间选型。
- span 语义：以 hermes-otel 插件实际发出的**双约定属性**（OpenInference + OTel GenAI）为准；以映射表 + 降级保留兜底，**交付前需真实样本校准（T000/T001）**。
- 接入引导：提供（安装脚本四副本，**onboard:'plugin'** —— 插件安装步骤 + otlp 后端配置块，引用 registry `listFrameworks()`）。
- **客户端（v0.4）**：hermes 内核无 OTel，**复用开源 `briancaffey/hermes-otel`** 配 `otlp` 后端指向平台，平台不写客户端代码。
- **一键安装（v0.4.1）**：setup/curl 引导需要替用户完成插件安装、Hermes runtime venv 依赖安装和 OTLP 配置探测；路径以 `$HERMES_HOME` 为根，不假设 `~/git/hermes-agent`。
- 关键设计决策（v0.4）：零 schema 迁移；可单测 OTLP 适配层（**由 traces-aggregator 调用**）；**服务端落 spool-consumer 管线 + registry 查表**；**撤销强 401 收敛**（端点鉴权归 spool-consumer 后续轮）。

### 2.3 Module Change Details

| Status | Module | Change Description | Constraints |
|------|------|----------|------|
| 🔵 External | **`briancaffey/hermes-otel`（客户端插件，复用开源）** | 上游适配器：hook→Span→双父栈重建树→双约定属性→OTLP 导出。**平台不写代码**，但 setup/curl 需要自动安装插件、安装 Hermes runtime OTel 依赖、写入/提示 `otlp` 后端配置 | 纯观察者；不 fork（缺口确认后再评估最小 fork）；路径探测以 `$HERMES_HOME` 为根 |
| 🟢 New | `src/lib/ingest/otel/`（otel-trace-mapper / semantic-mapping / framework-resolver / payload-guard / **agent-semantics**）| OTLP span→内部模型映射、**双约定**语义兜底、framework 解析、体量防护、agent 身份/skill 标记契约 | 纯函数、无 DB I/O；**由 `traces-aggregator` 调用，不由 route 调用** |
| 🟢 New | `src/lib/ingest/adapters/hermes.ts`（registry 线文件，hermes 填充）| hermes `FrameworkAdapter`：`descriptor{onboard:'plugin'}` + `extractSkills` + `capabilities.subagentTree`/整形 | 注册即生效；**不在 dispatcher 加裸分支** |
| ⚪ 取消 | ~~`src/lib/ingest/frameworks.ts`~~ | **取消**——框架清单并入 registry 的 `listFrameworks()`（单一出处）| 与 registry §3 对齐，避免两套清单 |
| 🟡 Modified | `src/app/api/ingest/otel/v1/traces/route.ts`（**spool-consumer 线主改**）| 退薄壳：`span→OtelTraceEvent→写 spool→200`。hermes 仅确保其数据流经此壳（service.name=hermes）| 由 spool-consumer 主导改造；hermes **不在此内联落库/收敛 401** |
| 🟢 New | `traces-aggregator.aggregateOtelTraceSession`（spool-consumer 线文件，hermes 接线）| 调用 `src/lib/ingest/otel/*` 纯函数把 `OtelTraceEvent[]`→interaction[]→ExecutionRecord | hermes 把映射纯函数「插入」此聚合器；落库走 `saveExecutionRecord` |
| 🟡 Modified | `src/lib/storage/data-service.ts::saveExecutionRecord`（:1937 门限）| **唯一存量改动点**：解除 `framework==='opencode'` 门，纳入 hermes 触发子 Agent 派生；经统一调度器抽 skill | **仅改 :1937 门限判断；opencode/claude/openclaw 既有路径行为零变更** |
| 🔴 Protected | `src/lib/storage/data-service.ts::deriveSubagentExecutions`（:2006-2112）| **不改**。被纳入 hermes 后消费「整形为 opencode 同构」的 interaction | 函数体冻结；hermes 同构由 agent-semantics 整形 |
| 🔴 Protected | `src/lib/engine/observability/agent-trace.ts::buildAgentCallTree`（:207）/`inferSubagentType` | **不改**。仅认 opencode 语义（`tool_calls[task]`/`subagent_type`/`subagent_session_id`/`role`，无 parentSpanId）| **禁止改其读 parentSpanId**；由适配层整形为同构后复用 |
| 🔴 Protected | `src/lib/engine/observability/agent-registration.ts::extractObservedAgentRegistrations`（**:14**，data-service:1801 调用）| **不改（框架无关）**。依据 interaction `agent/subagent_name/role` 自动注册 | 本期多半零改；如改也仅泛化 role 判定，保框架无关语义 |
| ⚪ 不改(registry 线) | `src/lib/storage/data-service.ts::extractInvokedSkillsFromSessionInteractions`（:476 dispatcher）| registry 线已缩为 `getAdapter(fw).extractSkills?.(n) ?? null`；**hermes 不加 `fw==='hermes'` 分支**，靠注册 adapter 生效 | 禁裸分支（registry 红线）|
| 🟢 New | `extractSkillsWithVersionsFromHermesSession`（放 `interaction-utils.ts` 或 `adapters/hermes.ts`）| hermes OTLP 形状 skill 抽取（含版本 + 子 Agent 加载）；挂为 hermes adapter 的 `extractSkills` | 既有抽取函数冻结 |
| ⚪ 不改(registry 线) | `src/app/api/eval/rejudge/route.ts`（:61）| registry 线已把它改走 dispatcher 并补回 openclaw；hermes **复用其结果** | 不重复改 |
| 🟡 Modified | `src/app/api/ingest/setup/route.ts` + `setup/auto/route.ts` | 四副本加入 hermes（onboard:'plugin'）+ **一键 curl 安装脚本/插件安装步骤 + otlp 配置块**，引用 registry 的 `listFrameworks()` | bash/PS×setup/auto 四处一致；非「仅配 env」；不得 hardcode `~/git/hermes-agent` |
| 🟢 New | hermes-otel **客户端接入规约文档** | 插件安装 + `otlp` 后端配置（endpoint/key/service.name/协议/隐私开关）+ 默认属性约定记录 | 复用开源；平台不写客户端代码 |
| 🔴 Protected | `opencode/claude/openclaw` 既有分支（建树/派生/注册/skill 抽取）| 不改 | 防回退 |
| ⚪ Not Involved | `prisma/schema.prisma`、`otel/v1/logs`、`/v1/metrics` | 无迁移（agent 树/注册字段已存在）、不触碰 | 防误改 |

### 2.4 Functional Impact Details

| Change Type | Functional Node | Change Point | Corresponding Requirement |
|----------|----------|--------|----------|
| Add | **客户端接入** | 复用 hermes-otel 插件 + 配 otlp 后端 + 接入规约 | FR-014/BR-010 |
| Add | OTLP 接入解析 | 适配层纯函数（aggregator 调用）+ 双约定语义兜底 + framework 显式解析 | FR-001/002/003/004 |
| Modify | 鉴权 | user 按 key 归属正确；**强 401 收敛降级后续轮（对齐 spool-consumer）** | BR-003/NFR-003（实质）|
| Add | 健壮性 | 畸形/超限防护（端点写 spool 前 + aggregator）| FR-009/BR-006 |
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
- **Telemetry**: OpenTelemetry OTLP/HTTP；平台当前主路径为 JSON，hermes-otel 当前实际 exporter 为 proto-http，需在 Phase 0 验证编码兼容性
- **Test**: Node test runner + tsx（项目既有），新增适配层单测

### 3.2 Core Decisions

#### Decision 1: 复用 OTLP traces 端点 + 零 schema 迁移
**Rationale**: `Execution.framework` 自由字符串、看板筛选项动态派生，hermes 天然可观测；改动面最小、向后兼容最强。
**Alternative**: 新建 hermes 专用端点/表（否决：重复造轮、增加维护面）。

#### Decision 2: 可单测 OTLP 适配层纯函数，由 traces-aggregator 调用（v0.4 改）
**Rationale**: 纯函数适配层为下一个框架提供低成本扩展点；**调用方落在 spool-consumer 的 `aggregateOtelTraceSession`**，而非 route 内联——与同批接收管线一致。
**Alternative**: 在 route 内联加分支（否决：与 spool-consumer「route 退薄壳、删同步落库」冲突、route 膨胀、不可测）。

#### Decision 2b: 客户端复用开源 hermes-otel 插件（v0.4 新增）
**Rationale**: hermes 内核无 OTel，必须装插件；`briancaffey/hermes-otel` 已实现跨线程双父栈、合成根 Span、双语义约定等核心难点；接入≈纯配置（`otlp` 后端指向平台）。
**Alternative**: 自研客户端插件（否决：重复造轮、与上游演进脱钩）；最小 fork 留作「缺口确认后」的延后选项。

#### Decision 3: traces 鉴权语义对齐 spool-consumer，强 401 收敛降级后续轮（v0.4 改）
**Rationale**: 端点退薄壳后请求内不落库，原「请求内 401 + 不写入」与薄壳/异步管线冲突；端点鉴权语义归 spool-consumer 统管。安全实质（user 按 key 正确归属、不污染他人）仍满足。
**Alternative**: hermes 线单独把端点改成「401 + 同步落库」（否决：与 spool-consumer 正面冲突、两线各改一套鉴权）。

### 3.3 Data Model

无 schema 变更。interaction JSON 新增可选字段 `raw` / `_degraded` / `_truncated`（向后兼容，旧消费者忽略）。详见 [Phase2 §5](phase2-requirements-design.md)。

### 3.4 Interface Contracts

- **POST `/v1/traces`**（重写至 `/api/ingest/otel/v1/traces`，**薄壳受理**）：Header `x-witty-api-key`（解析 user，无效不阻塞，D-003 v0.4）。JSON 路径为 `Content-Type: application/json` + OTLP `resourceSpans`（要求 `service.name=hermes`）；hermes-otel 当前 proto-http 上报若命中现有 JSON-only 端点，预期 415，后续需补 protobuf 解码或临时 capture/proxy。错误码 400 畸形/缺 resourceSpans、413 超限、415 protobuf、append 失败非 2xx。
- 内部纯函数契约（IF-N01~N05、IF-M01、IF-R04 等，调用方为 traces-aggregator / registry）见 [Phase2 §6](phase2-requirements-design.md)。

## §4 Task Breakdown

### 4.1 Upstream Gap Analysis

- **G1 hermes 真实 span 属性命名未知**：以 T001 采集真实样本校准映射表；无样本前先用「标准 gen_ai.* + 降级保留」实现，样本到位后补映射条目。（Status: Default Applied，待 T001 收敛）
- **G2 性能绝对阈值无基线**：固定测量条件（≤500 span/批、同 taskId 串行、SQLite 单实例），数值由 F3 压测回填。（Status: Default Applied）
- **G3 子 Agent 层级重建依赖样本结构**：FR-005/AC-003 列为 P1，置于 Phase 2；若 T001 样本无多 Agent 结构，则按 parentSpanId 通用树重建实现并以构造样本验证。（Status: Resolved by 通用实现）
- **G4 体量上限默认值**：默认单批体 ~8MB、单字段沿用既有 `SKILL_INSIGHT_MAX_TOOL_IO`/`MAX_EVENT_STRING`，可配置。（Status: Default Applied）

### 4.2 Task Organization Strategy

**Organization Method**: Hybrid（按架构耦合分组 + 按依赖分层）。

**Rationale**:
- Phase 0 聚焦「让 hermes 吐 OTLP」（复用插件 + 真实样本），是服务端映射的事实前提。
- Phase 1 聚焦「接入入库」核心链路（适配层纯函数 → 插进 traces-aggregator），是一切下游能力的前提，构成 MVP。
- Phase 2 聚焦「下游打通 + 接入体验」（skill 走 registry adapter、安装引导、子 Agent 层级），彼此低耦合、可并行。
- 适配层与 aggregator 接线强耦合、串行；评测/安装/层级三者独立，归同一 wave 并行。

**MVP Scope**:
- **Phase 1 (MVP)**: hermes OTLP/JSON 上报 → 鉴权 → 解析归并 → framework=hermes 入库并在看板可见（FR-001/002/003/009 + 安全/健壮性）。
- **Phase 2 (Incremental)**: **skill 与 subagent 一等公民**（FR-010/011/012/013）、评测承接（FR-008）、接入引导（FR-006）、子 Agent 链路层级（FR-005）、自定义属性映射定稿（FR-004）。

### 4.3 需求覆盖矩阵（FR/NFR → Task → AC）

| 需求 | Task | 验收 |
|-|-|-|
| **FR-014 客户端插件接入规约** | **T000** | AC-014 |
| FR-001 接入 | T000(插件) + T002 + T003(aggregator 接线) | AC-001, AC-014 |
| FR-002 解析归并 | T002, T003(aggregator) | AC-001, AC-002 |
| FR-003 framework 标识 | T002(resolver) | AC-001 |
| FR-004 自定义属性兜底 | T001, T002(degrade) | AC-008 |
| FR-005 子 Agent 链路层级 | T006 | AC-003 |
| FR-006 接入引导（含插件安装）| T005 | AC-006, AC-014 |
| FR-007 不支持编码反馈 | T003(端点) | AC-004 |
| FR-008 评测承接(主/子) | T004, T009 | AC-010 |
| FR-009 畸形/超限 | T002(guard) + T003(端点写 spool 前) | AC-009 |
| **FR-010 子 Agent 多 Execution 树** | **T009** | AC-011 |
| **FR-011 agent 自动注册** | **T010** | AC-012 |
| **FR-012 skill 全链路解析** | **T004(registry adapter) + T008** | AC-013 |
| **FR-013 OTLP agent/skill 语义契约** | **T007（依赖 T000/T001）+ T008** | AC-011/012/013 |
| BR-003/NFR-003 鉴权隔离 | T003（user 归属；强 401 后续轮）| AC-007 |
| BR-010/BR-011 复用插件/落两线 | T000 + T002/T003/T004 接线 | AC-014 |
| NFR-001 存量不回退 | Must-NOT-do（各任务）+ F3(TC-005) + F4 | AC-005 |
| NFR-002 幂等/容错 | T002(per-span 跳过) + spool-consumer 检查点/upsert | AC-002, AC-004 |
| NFR-004/005 可扩展/低成本 | T002(数据化映射), registry adapter, listFrameworks | — |
| NFR-006 可自检 | T003(端点+aggregator 双处日志) | — |
| **NFR-007 与 opencode 等价** | **T009** | AC-011 |

## §5 Execution Waves

```text
Phase 0: 客户端插件接入 + 样本 (Wave 0, v0.4 新增)
Preconditions: Phase2 设计评审通过；平台有可达 traces 端点 + 有效 key
├── T000: 复用 hermes-otel 插件, 配 otlp 后端指向平台, 跑通端到端 + 出接入规约 [Low-Medium]
└── T001: 采集真实 hermes OTLP trace 样本并校准映射规约 (现由 T000 跑出的真实 trace 提供) [Low]
Deliverables: 端到端「插件→平台」打通 (AC-014)；真实 trace 样本 + 映射规约 (阻塞 T002/T007)

Phase 1: 服务端接入核心 (Wave 1)
Preconditions: Phase 0 出样本；spool-consumer 的薄壳端点 + traces-aggregator 骨架可用(或走回退同步路径)
├── T002: 新增 OTLP 适配层纯函数 (mapper/semantic[双约定]/resolver/guard) + 单测 [High]
└── T003: 把适配层接进 aggregateOtelTraceSession + (端点侧)编码/结构拒绝 + 双处结构化日志 [Medium]
Deliverables: hermes 经薄壳→spool→消费者→aggregator 入库, 看板出现 framework=hermes (AC-001/002/004/009)

Phase 2: Skill 与 Subagent 一等公民 (Wave 2)
Preconditions: Phase 1 完成 + T001 样本 + registry 的 getAdapter/FrameworkAdapter 可用
├── T007: 定义 OTLP agent 身份/skill 语义契约 (FR-013, 据 T000 插件实际属性 + T001) [Low]
├── T008: 适配层 agent-semantics 整形为 opencode 同构 interaction (扩 T002, 关键) [Medium]
├── T009: 解 :1937 门 + 复用建树/派生 (不改建树) 拆多条 Execution [Medium-High]
├── T010: agent 自动注册 (框架无关函数, 多半零改+验证) [Low]
└── T004: skill 全链路解析 + 注册 adapters/hermes.ts 的 extractSkills (不加 dispatcher 裸分支) [Medium]
Deliverables: 多 Agent 拆多条 Execution+树 (AC-011)、自动注册 (AC-012)、skill 全链路 (AC-013)、主/子可评测 (AC-010)

Phase 3: 接入引导与链路展示 (Wave 3, 可与 Wave 2 部分并行)
Preconditions: Phase 0/1 完成 (T006 另需 T008/T009)；registry 的 listFrameworks 可用
├── T005: 安装脚本四副本加 hermes(onboard:'plugin') + 插件安装步骤/otlp 配置块, 引用 listFrameworks [Medium]
└── T006: 子 Agent 链路展示 (纯 UI 消费, 零改建树) [Low]
Deliverables: 安装引导(含插件)可用 (AC-006/AC-014)、链路层级展示 (AC-003)

Phase FINAL: Quality Validation & Delivery (Wave N)
Preconditions: All functional Phases completed
├── F1: Plan Compliance Audit
├── F2: Code Quality Review
├── F3: Real Scenario Manual QA (含端到端插件接入/幂等/压测回填/opencode 等价性)
└── F4: Scope Fidelity Check (冻结区: 建树/派生/注册函数体 diff 空; 无 dispatcher 裸分支; 端点鉴权未被 hermes 单独收紧; 无固化的临时同步路径)
Deliverables: 通过全部验收准则 (AC-001~014), 等待用户确认

Critical Path: T000 → T001 → T002 → T003 → T007 → T008 → T009 → F1-F4
跨线依赖: T003 依赖 spool-consumer(薄壳端点+aggregator); T004 依赖 registry(getAdapter); T005 依赖 registry(listFrameworks)
Maximum Concurrency: Wave 2 (T008→T009/T010/T004 并行) + Wave 3 (T005/T006)
```

## §6 Task List

### Phase 0: 客户端插件接入 + 真实样本（v0.4 新增）

**Core Objective**: 用开源 hermes-otel 插件让 hermes 端到端吐数据到平台，并产出真实 trace 样本与接入规约——这是上游适配器，也是所有服务端映射任务的事实输入。

**Independent Validation Criteria**:
- [ ] 一键安装脚本能在标准 Hermes 安装布局中探测 `$HERMES_HOME/hermes-agent/venv/bin/pip`，安装并启用 hermes-otel 插件，安装 OTel runtime 依赖，配置 `otlp` 后端。
- [ ] 装好 hermes-otel 插件、配 `otlp` 后端指向平台后，跑一次 hermes 任务 → 看板出现 framework=hermes 会话（AC-014）
- [ ] 产出 ≥1 条真实 OTLP/HTTP trace 原文或 protobuf 解码结果 + 属性映射对照表

**Git Commit**: NO（客户端配置 + 文档，不改平台代码）

**Task List**:

---

- [ ] T000 复用 hermes-otel 插件并跑通端到端 + 出接入规约 - `docs/design/hermes-otel-adapter/hermes-onboarding.md`(新增), `docs/design/hermes-otel-adapter/hermes-trace-sample.md`

   - **Delegate Subagent**: YES / researcher / Effort: Low-Medium / Parallelism: 阻塞 T001/T002/T007
   - **What to do**:
     + 验证一键安装策略：以 `HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"` 为根探测 Hermes 安装；优先使用 `$HERMES_HOME/hermes-agent/venv/bin/pip`，仅在不存在时 fallback 到 `~/git/hermes-agent/venv/bin/pip`、`~/agent/hermes-agent/venv/bin/pip` 等开发者布局；找不到 venv 时停止并给出可操作提示。
     + 安装 `briancaffey/hermes-otel` 插件到 `$HERMES_HOME/plugins/hermes_otel/` 并启用（`hermes plugins install briancaffey/hermes-otel --enable`）；不要把用户手动 clone 的 `~/agent/hermes-otel` 当作自动发现目录。
     + 将 OTel runtime 依赖安装到 Hermes runtime venv：优先执行 `"$HERMES_PIP" install -e "$HERMES_HOME/plugins/hermes_otel"`，必要时 fallback 到 README 中的 `opentelemetry-api`、`opentelemetry-sdk`、`opentelemetry-exporter-otlp-proto-http` 显式安装。
     + 配置其**通用 `otlp` 后端**：`endpoint=…/api/ingest/otel/v1/traces` 或 `/v1/traces`、`headers: x-witty-api-key`、`resource_attributes.service.name=hermes`。写 `$HERMES_HOME/config.yaml` 前必须备份，且只改 hermes-otel 相关块。
     + 编码兼容性验证：记录真实请求的 `Content-Type`。若为 `application/x-protobuf` 且平台返回 415，保留插件 debug/服务端日志，后续进入「服务端补 protobuf」或「临时 capture/proxy 解码」决策，不把它误判为插件安装失败。
     + 输出自检信息：Hermes home、插件目录、pip 路径、OTel 包版本、endpoint、`service.name`、插件是否 enabled；API key 只脱敏展示，不明文打印。
     + 跑一次含 LLM/工具（最好含子 Agent + skill）的 hermes 任务，确认平台出现 framework=hermes 会话；抓取一条真实 OTLP trace 原文。
     + 产出**接入规约文档** `hermes-onboarding.md`：插件安装步骤、后端配置块、协议/隐私/采样开关、排障（无数据时先查「装没装插件 + 配没配后端」）。
     + 记录插件**实际发出的属性**（OpenInference 如 `llm.token_count.*`/`openinference.span.kind`、OTel GenAI 如 `gen_ai.usage.*`、agent/session span 命名、skill 是否带版本、是否有 `parentSpanId` 嵌套），写入 `hermes-trace-sample.md` 供 T002/T007。
   - **Must NOT do**: 不 fork/改插件源码（缺口确认后才评估最小 fork）；不改平台代码；不臆造属性（拿不到真实环境时用插件源码/文档推断并显式标注「假设」）；不把依赖装进系统 Python 或 agent-insight 自身 venv；不明文打印 API key。
   - **Parallelism Info**: Can Parallel: NO / Prerequisite: 平台可达 + 有效 key / Blocking: T001/T002/T007
   - **Reading List**:
     + External: `briancaffey/hermes-otel`（plugin.yaml / backends.py 的通用 otlp resolver / tracer.py 双约定）
     + Source: `docs/series-articles/hermes-otel-设计文档.md`（机制全解）
     + Pattern: `src/app/api/ingest/otel/v1/traces/route.ts` - 服务端当前接收形状
   - **Acceptance Criteria**:
     + [ ] 安装脚本/手动验证记录证明：插件目录、Hermes runtime venv、OTel 依赖、`service.name=hermes` 均命中正确位置
     + [ ] 端到端：插件→平台，看板出现 framework=hermes 会话（AC-014）
     + [ ] `hermes-onboarding.md` 含可复制的安装步骤 + otlp 后端配置块
     + [ ] `hermes-trace-sample.md` 含真实/推断 trace + 属性对照（标注双约定命名与缺口）

---

### Phase 1: 服务端接入核心

**Core Objective**: 让 hermes 经薄壳端点→spool→后台消费者→`aggregateOtelTraceSession`（调用本设计适配层纯函数）正确解析归并、以 framework=hermes 入库并在看板可见。

**Independent Validation Criteria**:
- [ ] `node --import tsx --test src/lib/ingest/otel/*.test.ts` → PASS
- [ ] 经 hermes-otel 插件上报（service.name=hermes）→ 看板 `framework=hermes` 会话出现、token/latency 非空
- [ ] 缺 resourceSpans / protobuf → 端点确定性 4xx；鉴权无效 → 按 spool-consumer 现状（告警继续，不在本设计单独 401）

**Git Commit**: YES — `feat(ingest): plug hermes OTLP adapter into traces-aggregator`

**Task List**:

---

- [ ] T001 采集真实 hermes OTLP trace 样本并校准映射规约 - `docs/design/hermes-otel-adapter/hermes-trace-sample.md`

   - **Delegate Subagent**: YES / researcher / Effort: Low / Parallelism: 可与 T002 骨架并行（T002 映射表定稿依赖本任务结论）
   - **What to do**:
     + 获取/构造一条真实 hermes 运行的 OTLP/HTTP trace（JSON 原文或 protobuf 解码后的 resourceSpans），记录其 `service.name`、资源属性、span 属性键（是否 `gen_ai.*`/`llm.*`/`tool.name` 或自定义命名）、是否含 `session.id`、是否含父子 span。
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
     + **双约定（v0.4）**：semantic-mapping 必须**同时认两套 key**——OpenInference（`llm.token_count.*`/`openinference.span.kind`）与 OTel GenAI（`gen_ai.usage.*`），因 hermes-otel 插件两套都发（T000 样本为准）。
   - **Must NOT do**: 不在适配层访问 DB/网络；不改 route/端点行为（T003 负责接线）；不动既有 opencode/claude 解析。
   - **Parallelism Info**: Can Parallel: 部分（骨架）/ Prerequisite: T000/T001(真实样本+映射表) / Blocking: T003
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

- [ ] T003 把适配层接进 traces-aggregator + 端点编码/结构拒绝 + 双处结构化日志 - `claude-otel/traces-aggregator.ts`(spool-consumer 线), `src/app/api/ingest/otel/v1/traces/route.ts`(仅薄壳侧)

   - **Delegate Subagent**: YES / coder / Effort: Medium / Parallelism: 依赖 T002 + spool-consumer 骨架
   - **What to do**:
     + **主接线（转换层）**：在 `aggregateOtelTraceSession(sessionId)` 内调 `mapOtlpTrace(events, resourceAttrs, apiUser)`（消费 traces spool 的 `OtelTraceEvent[]`）→ interaction[] → ExecutionRecord（framework=hermes），落库走唯一出口 `saveExecutionRecord`。**不在 route 内落库**。
     + **端点侧（薄壳，spool-consumer 主导，hermes 仅确认）**：编码判定（protobuf→415 + 改用 http/json 指引）、结构校验（缺 resourceSpans→400）、`span→OtelTraceEvent` 归一化（畸形 span 丢弃）→ 写 spool→200 受理；append 失败→非 2xx。**鉴权按 spool-consumer 现状（无效 key 告警继续），本设计不单独收敛 401（D-003 v0.4）**。
     + **并发幂等不自建**：依赖 spool-consumer 的检查点 + `{task_id,framework}` upsert + dedupeEvents（撤销 v0.3 的「同 taskId 串行键」）。hermes 仅保证 `framework=hermes` 稳定（R-2 红线）。
     + **透传 agent 身份**：确保整形后的 agent/skill 标记写入 interaction（供下游建树/注册/skill）。
     + **双处结构化日志**（NFR-006）：端点记 `{authResult,spanTotal,acceptedToSpool,httpCode}`；aggregator 记 `{taskId,framework,mappedCount,skippedCount,skipReasons,degradedCount,truncatedFields,saved}`。
     + **回退**：若 spool-consumer 未就绪，临时在 route 内同步调 `aggregateOtelTraceSession + saveExecutionRecord`，**代码标注 `// TODO: 切回薄壳（spool-consumer 落地后）`**，不固化。
   - **Must NOT do**: 不改 `/v1/logs`、`/v1/metrics`；不改 `saveExecutionRecord` 内部；**不在 hermes 线把端点鉴权改成 401 拒绝**（归 spool-consumer）；不自建并发锁。
   - **Parallelism Info**: Can Parallel: NO / Prerequisite: T002 + spool-consumer(薄壳端点/aggregator 骨架) / Blocking: Phase 2
   - **Reading List**:
     + Pattern: `src/app/api/ingest/otel/v1/traces/route.ts:23-220` - 现有逻辑（被 spool-consumer 退薄壳）
     + Cross-line: `docs/design/otel-spool-consumer/phase2-requirements-design.md §2.2.1/§5.3/§6.2` - 薄壳端点 / OtelTraceEvent / aggregate 接口
   - **Acceptance Criteria**:
     + [ ] 经插件上报（service.name=hermes）→ 看板出现 framework=hermes（异步可见）
     + [ ] 缺 resourceSpans → 端点 400；protobuf → 415；append 失败→非 2xx
     + [ ] 分 3 批（含重复 spanId）上报同一会话 → 经检查点/upsert/dedupe，interaction 无重复、聚合正确（AC-002，机制属 spool-consumer，hermes 验证不击穿去重键）
   - **QA Scenario**:
   ```
   Scenario: 跨 logs/traces 不击穿去重键
     Tool: 单测 + 看板
     Preconditions: 平台运行, 有效 key, framework=hermes
     Steps: 1. 同 task_id 经 traces 多批上报 2. 查会话行数
     Expected Result: 一个 task_id → 一行(framework=hermes); 去重 100% (AC-002, R-2)
     Evidence: .sisyphus/evidence/task-T003-dedup.txt
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

- [ ] T004 skill 全链路解析（OTLP 形状）→ 注册为 hermes adapter 的 extractSkills - `src/lib/ingest/adapters/hermes.ts`(registry 线文件), `src/lib/shared/interaction-utils.ts`(可放抽取纯函数)

   - **Delegate Subagent**: YES / coder / Effort: Medium / Parallelism: 依赖 T008 + registry 骨架；与 T009/T010 并行
   - **What to do**:
     + 新增 `extractSkillsWithVersionsFromHermesSession`：解析 **OTLP 形状**（`interaction.toolCall:{name,arguments(字符串)}`），`toolCall.name∈{skill,load_skill}` 时从 arguments 解析 `skill/skill_name/name` 与 `version`。
     + **覆盖子 Agent 加载的 skill**：对齐 opencode `task.load_skills` 语义，借 T008 的 agent 身份标记把 skill 归属到对应 agent，一并并入 invokedSkills。
     + **挂为 `adapters/hermes.ts` 的 `extractSkills`**（registry 的 `FrameworkAdapter.extractSkills?`）。**不在 dispatcher（`data-service.ts:476`）加 `fw==='hermes'` 裸分支**——registry 已把 dispatcher 改为 `getAdapter(fw).extractSkills?.(n) ?? null`，注册即生效。
     + **rejudge 不重复改**：registry 线已把 `rejudge/route.ts:61` 改走 dispatcher 并补回 openclaw；hermes 复用其结果。
     + 回退：若 registry 未就绪，临时在 dispatcher 加 hermes 分支并标注 `// TODO: 收编为 adapters/hermes.ts（registry 落地后）`。
   - **Must NOT do**: 不改既有 opencode/claude/openclaw 抽取函数实现；**不固化 dispatcher 裸分支**；不改 saveExecutionRecord 既有分支。
   - **Parallelism Info**: Can Parallel: YES(T009/T010) / Prerequisite: T008（skill 标记）+ registry(getAdapter/FrameworkAdapter) / Blocking: 无
   - **Reading List**:
     + Pattern: `src/lib/shared/interaction-utils.ts:55-178` - 既有抽取函数风格（注意形状差异）
     + Cross-line: `docs/design/framework-adapter-registry/phase2-requirements-design.md §2.2/§3` - FrameworkAdapter.extractSkills 与 hermes.ts 占位
   - **Acceptance Criteria**:
     + [ ] hermes 主 Agent 与子 Agent 加载的 skill 均入 invokedSkills（带版本，若上报含）
     + [ ] `getAdapter('hermes').extractSkills` 被 dispatcher 命中；Skill 诊断/路由评测显示非空；既有框架行为不变；无新增 dispatcher 裸分支（F4 核验）
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
- [ ] 安装脚本（bash/PS × setup/auto）均出现 Hermes 选项并输出一键 curl 安装命令 + 配置指引（AC-006）
- [ ] 含父子 span 的 hermes 会话层级深度=上报深度（AC-003）

**Git Commit**: YES — `feat(hermes): install guide and sub-agent hierarchy view`

**Task List**:

---

- [ ] T005 安装脚本四副本加 hermes(onboard:'plugin') + 一键 curl 安装/otlp 配置块 - `src/app/api/ingest/setup/route.ts`, `src/app/api/ingest/setup/auto/route.ts`（框架清单引用 registry `listFrameworks()`）

   - **Delegate Subagent**: YES / coder / Effort: Medium / Parallelism: 与 T006 及 Wave 2 各任务并行（依赖 registry listFrameworks）
   - **What to do**:
     + **框架清单单一出处**：hermes descriptor 进 registry 的 `listFrameworks()`：`{id:'hermes', label:'Hermes', onboard:'plugin'}`。**不新建 `src/lib/ingest/frameworks.ts`**（v0.4 取消，避免与 registry 各搞一套）。
     + 四处选择器（setup bash :80-84 / PS :540-544；auto bash / PS）引用 `listFrameworks()` 加入 hermes。
     + hermes 为 **plugin 接入**（非 Claude 那种「仅配 env」）：输出**三段**——①**一键 curl 安装脚本**（探测 `$HERMES_HOME`、执行 `hermes plugins install ... --enable`、安装 Hermes runtime OTel 依赖、备份并更新 `$HERMES_HOME/config.yaml`）；②**手动 fallback 步骤**（装到 `$HERMES_HOME/plugins/hermes_otel/`，优先 `$HERMES_HOME/hermes-agent/venv/bin/pip`）；③**通用 `otlp` 后端配置块**（endpoint=`/v1/traces`、`x-witty-api-key`、`resource_attributes.service.name=hermes`、协议与服务端一致）。内容引用 T000 的 `hermes-onboarding.md`。
     + 安装脚本要脱敏输出 API key，自检 Hermes home、插件目录、pip 路径、OTel 包版本、endpoint、`service.name`；如果找不到 Hermes runtime venv，停止并提示用户设置 `HERMES_HOME`，不得退到系统 Python。
   - **Must NOT do**: 不改 opencode/claude/openclaw 既有安装分支逻辑；保持 bash/PS 四副本一致；不把 hermes 标为 `env`；不 hardcode `~/git/hermes-agent/venv/bin/pip`；不明文打印 API key。
   - **Parallelism Info**: Can Parallel: YES(T006, Wave 2 各任务) / Prerequisite: registry(listFrameworks) + T000(规约内容) / Blocking: 无
   - **Reading List**:
     + Pattern: `src/app/api/ingest/setup/route.ts:80-84,151-159,300-344` - 选择器、安装 flag、Claude env 块（结构参照，但 hermes 是 plugin 形态）
     + Cross-line: `docs/design/framework-adapter-registry` - listFrameworks 单一出处
     + Doc: `hermes-onboarding.md`（T000 产出）- 插件安装 + otlp 配置内容来源
   - **Acceptance Criteria**:
     + [ ] 四处脚本生成结果均含 Hermes 选项（onboard:'plugin'）；选 hermes 后输出「一键 curl 安装 + 手动 fallback + otlp 后端配置块」
     + [ ] 一键脚本包含 `$HERMES_HOME` 探测、runtime venv 依赖安装、配置备份、API key 脱敏、自检输出
     + [ ] 框架清单只有 `listFrameworks()` 一个出处；opencode/claude/openclaw 安装路径无变化

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
   - **Validation Content**: git diff 是否越界；对照 §2.3；**重点核验冻结区函数体 git diff 为空：`deriveSubagentExecutions`（data-service.ts:2006）、`buildAgentCallTree`（agent-trace.ts:207，尤其未读 parentSpanId）、`extractObservedAgentRegistrations`（agent-registration.ts:14）、既有框架 skill 抽取分支；`prisma schema` 无迁移、`/v1/logs`/`/v1/metrics` 未被改**；确认 hermes 接入仅由「适配层整形（由 aggregator 调用）+ `data-service.ts:1937` 解门限 + 注册 `adapters/hermes.ts`」实现；**核验无新增 dispatcher 裸分支、无 hermes 单独把端点鉴权改 401、无固化的临时同步路径（`// TODO: 切回薄壳` 已清）、框架清单仅 `listFrameworks()` 一处**；每个任务仅改其描述文件
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
- **插件/样本/契约先行**: T000（插件接入 + 真实样本）→ T001 → T007 阻塞 agent/skill 解析定稿，优先完成。
- **跨线协调**: 与 `otel-spool-consumer`、`framework-adapter-registry` 同批；优先对齐两者接口骨架（aggregator/getAdapter/listFrameworks），再插入 hermes；任一线滞后走回退路径并标 TODO，落地后切回。

### 8.2 Risk List

| Risk | Impact | Mitigation Measures |
|------|------|----------|
| 误判「hermes 仅配置即可」（v0.3 旧前提）| High | **已纠正**：hermes 内核无 OTel，必须装 hermes-otel 插件；T000 端到端验证 + 接入规约强调「装插件」为第一步 |
| 插件实际属性与服务端假设不符（尤其 OpenInference 命名）| High | T000 采真实属性 + T007 契约先行；semantic-mapping 双约定都认；映射表数据化、降级保留兜底 |
| 插件未发 skill 版本 / agent.type | Medium | 先降级保留 + 父子推断；若 T000 证实影响 FR-012/010，评估最小 fork 补属性（默认不 fork）|
| 实现者误改 buildAgentCallTree 去读 parentSpanId（撞冻结区）| High | 「整形复用而非改建树」；T008 整形为同构字段、T009 仅解 :1937 门；F4 核验建树函数体 diff 为空 |
| hermes→opencode 同构整形不正确致树错 | High | T008 单测断言「输出字段名==下游期望键」；先修整形而非改建树；T000/T001 样本校准 |
| **跨线冲突**：hermes 改 route 内联落库 / 加 dispatcher 裸分支 / 单独收敛 401 | High | **设计已下沉到 aggregator + registry + 撤销强 401**；回退路径必须标 TODO，F4 核验无固化 |
| 框架清单两处（frameworks.ts vs listFrameworks）漂移 | Medium | **取消 frameworks.ts**，单一 `listFrameworks()`；F4 核验只有一处 |
| 并发写丢 span | Medium | **依赖 spool-consumer**：检查点 + `{task_id,framework}` upsert + dedupe；hermes 仅保 framework=hermes 稳定（R-2）|
| 落库去重键被击穿（framework≠hermes）| Medium | 钉死 `framework=serviceName=hermes` 回归测试（R-2 红线）|

### 8.3 Coding Notes

- 适配层纯函数、无副作用，禁直接 DB/网络访问；**调用方是 traces-aggregator，不是 route**。
- 端点鉴权语义**归 spool-consumer**：hermes 不在 traces 端点单独做 401 收敛；user 按 key 正确归属即可。
- semantic-mapping **双约定都认**（OpenInference + OTel GenAI），因 hermes-otel 插件两套都发。
- 新增 interaction 字段均可选，旧消费者忽略未知字段；不改既有字段语义。
- 严守冻结区：`deriveSubagentExecutions`/`buildAgentCallTree`/`extractObservedAgentRegistrations` **函数体不动**、既有框架 skill 抽取分支、prisma schema、`/v1/logs`、`/v1/metrics`。
- **核心范式（v0.4）**：**hermes 接入 = 复用 hermes-otel 插件（客户端）+ 适配层纯函数插进 `aggregateOtelTraceSession`（整形为 opencode 同构 interaction）+ `data-service.ts:1937` 解门限 + 注册 `adapters/hermes.ts`（extractSkills/capabilities）+ setup 加 hermes(plugin)**；共享建树/注册/dispatcher 只复用、不改；不内联落库、不加裸分支、不单独改鉴权。
- **一键安装范式（v0.4.1）**：setup/curl 负责探测 `$HERMES_HOME`、安装并启用 `hermes_otel`、把 OTel 依赖装进 Hermes runtime venv、备份并更新 Hermes config；不得硬编码 `~/git/hermes-agent`，不得把依赖装入系统 Python 或 agent-insight venv，API key 输出必须脱敏。

---

## 变更记录（合成文档）

| 版本 | 内容 |
|-|-|
| v0.1 | Phase1/2/3 三阶段初稿，各自通过独立 reviewer 闸门（P1 84 条件通过→修订；P2 73 条件通过→修订；P3 Pass）|
| v0.2 | 可行性验证修订：rejudge 第二处 switch 统一化、framework 兜底澄清、缺 resourceSpans 确定性 400、并发幂等定稿、setup 四副本+共享常量 |
| v0.3 | **refine：skill / subagent 一等公民**——新增 FR-010/011/012/013、NFR-007、BR-007/008/009、AC-011/012/013、D-004/D-005、§2.2.4/2.2.5、IF-N05、任务 T007~T010 与 T004 升级 |
| v0.3.1（本合成） | 据代码二次核对修正两处 ERROR：①`extractObservedAgentRegistrations` 实为 `agent-registration.ts:14` 框架无关函数（不加分支、靠标记自动注册）；②`buildAgentCallTree` 无 parentSpanId 能力，改为「适配层把 hermes 整形为 opencode 同构 interaction，建树/派生/注册函数零改动」。同步收敛冻结区与任务边界（T008 整形为关键、T009 仅解 :1937 门、T010 多半零改、T006 纯 UI 消费）|
| **v0.4（本次 refine）** | **补客户端插件 + 对齐同批两线**：① 新增 **Phase 0 / T000**（复用 `briancaffey/hermes-otel` 插件、配 otlp 后端、跑通端到端 + 出接入规约/真实样本）；② §2.3 模块表改：route 退薄壳、适配层由 traces-aggregator 调用、skill 注册 `adapters/hermes.ts`（不加 dispatcher 裸分支）、取消 `frameworks.ts`（并入 `listFrameworks()`）；③ Decision 2/2b/3 重写（aggregator 调用 / 复用插件 / 撤销强 401）；④ T002 加双约定、T003 改「接 aggregator + 端点薄壳 + 不自建并发锁」、T004 改注册 adapter、T005 改 plugin 接入；⑤ §4.3 覆盖矩阵加 FR-014/BR-010/011、Critical Path 加 T000、标注跨线依赖；⑥ §8 风险/编码范式/ F4 核验项全面对齐（无内联落库/无裸分支/无单独 401/无固化 TODO/单一框架清单）|
| **v0.4.1** | 补齐 T000/T005 的一键 curl 安装闭环：`$HERMES_HOME` 探测、插件目录 `$HERMES_HOME/plugins/hermes_otel`、Hermes runtime venv 依赖安装、配置备份与 OTLP 后端写入、API key 脱敏、自检输出；修正顶部 Critical Path 从 T000 开始；补充 `hermes-otel` 实际使用 OTLP/HTTP protobuf exporter 的编码校正与 415 后续决策。 |

> 注：本文件为三阶段 + refine + 代码核对修正的合成稿；v0.4.1 在 v0.4 基础上补齐客户端一键安装闭环，原 v0.3.1 文件保留以便生成变更记录。
