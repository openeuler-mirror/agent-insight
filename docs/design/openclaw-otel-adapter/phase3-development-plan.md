# OpenClaw 平台适配（OTel / OTLP 接入）— 开发计划（SDD）
版本：v0.2
最后更新：2026-06-11

> 文档类型：Phase3 开发计划 ｜ base_commit：d351dad（master）｜ 状态：评审条件通过（87/100）→ **已按评审意见修订（v0.2）**
> 输入：[Phase1 需求分析](phase1-requirements-analysis.md) v0.2 + [Phase2 需求设计](phase2-requirements-design.md) v0.2
>
> **跨线依赖（同批未落地，需协调落地次序，详见 Phase2 §8.3）**：
> - `otel-spool-consumer`：薄壳 traces 端点、`traces-aggregator.aggregateOtelTraceSession`、`OtelTraceEvent`、检查点消费者。**协商项①**：protobuf 解码是对其「traces 输入 json 不变」契约的显式修订；**协商项②**：attribution-guard 落点（其 transformation 层之后、落库前）。
> - `framework-adapter-registry`：`getAdapter`/`listFrameworks`/`FrameworkAdapter`、已规划的 `adapters/openclaw.ts`。**协商项④**：`FrameworkDescriptor.onboardModes?` 扩展。
> - `hermes-otel-adapter`：适配层四纯函数（semantic-mapping/framework-resolver/payload-guard/agent-semantics）为本计划复用基座；**共改冲突点**：`data-service.ts:2155` 解门与 hermes 共改同一行（合并策略见 G5）。
> - **回退条款**：任一线滞后时，编码分派+解码仍挂现有端点同一位置（不依赖薄壳化）；聚合纯函数与归属防线临时由 route 现状同步路径调用；skill 走既有 dispatcher openclaw 分支（**已存在，零新增裸分支**）。两线落地后仅切换调用方，F4 核验不得固化临时路径。

## §1 Project Overview

| Information | Content |
|------|------|
| **Project Name** | agent-insight — OpenClaw OTel/OTLP 北向适配 |
| **Input Sources** | [Phase1 需求分析](phase1-requirements-analysis.md) v0.2 + [Phase2 需求设计](phase2-requirements-design.md) v0.2 |
| **Plan Type** | New Feature Development（北向多平台适配，含 1 项平台级协议能力） |
| **Estimated Effort** | Medium |
| **Parallel Execution** | YES - 4 Waves（+ FINAL） |
| **Critical Path** | T001 → T005 → T007 → T011 → F1-F4（T004 不依赖 T001，不在关键路径上） |

## §2 Change Scope

### 2.1 Initial Requirements

```text
目标是将 openclaw 适配到项目 agent-insight（服务于所有 agent 平台，将 agent 的执行记录上报到平台）：
（1）参考 openclaw 接入 langfuse 的指导方式，生成接入 agent-insight 的方式（使用 OTel 协议）；
（2）文档包含：1. 在 openclaw 端如何配置？或者类似对应的插件怎么写？ 2. 插件（如果有）如何接入到 agent-insight；
（3）参考已有但未落地的设计 docs/design/hermes-otel-adapter。
```

### 2.2 Key Clarifications

- 客户端双路径：纯配置内置 OTLP exporter（主，零代码）+ aliyun 形态 exporter 插件（增强，GenAI 语义 span 树）；自研插件仅兜底规约（BR-010）。
- 与既有本地 watcher 接入并存 + 互斥指引（BR-012），framework 单一标识 `openclaw`（BR-001），不做双路去重。
- **P0 服务端补 OTLP http/protobuf 解码**（OpenClaw 内置导出仅 http/protobuf；作为对 spool-consumer 契约的显式修订项，D-002）。
- 无归属会话在**聚合侧丢弃**（不落 anonymous，不改端点鉴权语义；丢弃不可恢复口径已声明，D-003）。
- 整形「双形状」：扁平 toolCall 块（置 `responseMessage.content`，既有抽取器零改动）+ opencode 同构 agent 标记（建树/派生/注册零改动）；唯一存量改动 = 解 `data-service.ts:2155` 门限（D-004）。
- 范围对齐 hermes 全量（子 Agent 树/skill 一等/自动注册/评测承接）；难度 Medium；T001 真实样本为第一里程碑（D-005）。

### 2.3 Module Change Details

| Status | Module | Change Description | Constraints |
|------|------|----------|------|
| 🔵 External | OpenClaw 内置 OTel 导出（纯配置主路径） | 上游数据源：env 配置指向平台（http/protobuf）。**平台不写代码**，仅出规约 | 不 fork、不改 OpenClaw 内核 |
| 🔵 External | aliyun 形态 exporter 插件（增强路径，复用开源） | GenAI 语义 span 树 + version-compat 矩阵；endpoint/鉴权头指向平台 | 鉴权头可配置性 = DC-009 待 T001 验证，失败走兜底链 |
| 🟢 New | `src/lib/ingest/otel/otlp-protobuf-decoder.ts` | 编码分派 + `ExportTraceServiceRequest` 解码 + **id bytes→hex / AnyValue 归一** + 解码前字节上限/批量上限 | 纯函数；产物与 json 路径**字段级同构**（AC-003）；选型优先复用 `@opentelemetry/sdk-node` 依赖树内 otlp-transformer/protobufjs |
| 🟡 Modified | `src/app/api/ingest/otel/v1/traces/route.ts` | **仅一处**：「读 body→parse」接入编码分派（`:43-47` 的 415 protobuf 分支改为解码受理；gRPC 维持拒绝+指引） | **契约修订项**（协商①闭环后落地）；禁改 `/v1/logs`、`/v1/metrics`；不内联新增落库逻辑 |
| 🟡 Modified | `semantic-mapping` / `framework-resolver`（hermes 适配层文件；该线滞后则本线先建骨架） | +openclaw 映射条目（`gen_ai.span.kind`、span 命名、生命周期 infra）；+`service.name=openclaw` 契约校验（缺失/变体告警，不落 unknown-service） | 仅加数据条目/校验分支；不改函数骨架；据 T001 定稿 |
| 🟡 Modified | `agent-semantics`（hermes 适配层文件，同上回退） | +openclaw **双形状整形**：扁平 toolCall 块（置 `responseMessage.content`）+ opencode 同构标记 | **禁止**嵌套 toolCall 对象/顶层 content[]（Phase2 E-1 教训）；golden 用例守护 |
| 🟢 New | `attribution-guard`（建议 `src/lib/ingest/otel/attribution-guard.ts`） | 聚合侧归属防线：user 无法解析 → 整会话不落库 + `unattributed` 结构化日志（框架无关，谓词式） | 不改端点鉴权语义；丢弃不可恢复口径写入排障文档 |
| 🟡 Modified | `src/lib/storage/data-service.ts::saveExecutionRecord`（`:2155`） | **唯一存量改动点**：`framework==='opencode'` 门限改为**集合判断**并纳入 openclaw（G5 合并策略：先落地者集合化，后落地者仅加值） | 仅改该行判断；opencode/claude 行为零变更；watcher-openclaw 存量过门安全退化（专项回归） |
| 🟡 Modified | `src/lib/ingest/adapters/openclaw.ts`（registry 线已规划文件） | 在其 watcher 形状 `extractSkills` 基础上确认双形状兼容（整形已归一，预期零扩展）+ 挂 subagentTree 整形能力 | 不加 dispatcher 裸分支；registry 滞后回退：既有 `data-service.ts:487-489` openclaw 分支零改动直用 |
| 🟡 Modified | `src/app/api/ingest/setup/route.ts` + `setup/auto/route.ts` | 交互式新增 openclaw（当前缺失）；双模式引导（watcher 保留 + otel 新增：env 块/插件块）+ 互斥声明 | bash/PS × setup/auto 多副本一致；框架清单引用 registry `listFrameworks()`（协商④未闭环则硬编码+标注待收编） |
| 🔴 Protected | `interaction-utils.ts::extractSkillsWithVersionsFromOpenClawSession`（`:146-178`） | **不改**。读 `responseMessage.content`/assistant `requestMessages[].content` 的扁平 toolCall 块 | 函数体冻结；golden 用例用**原函数**断言整形产物 |
| 🔴 Protected | `deriveSubagentExecutions`/`sweepStaleSubagents`（`data-service.ts:2230/2378-2390`）、`buildAgentCallTree`（`agent-trace.ts:209`）、`agent-registration.ts:14` | **不改**。消费整形后的同构 interaction；sweep 副作用由按会话全量聚合缓解 + 专项用例 | 函数体冻结；禁止让建树读 parentSpanId |
| 🔴 Protected | `openclaw-watcher.ts` / `openclaw-parser.ts`（存量 watcher 链路） | **不改**。与 OTel 并存互斥 | NFR-001 回归保障 |
| ⚪ Not Involved | `prisma/schema.prisma`、`otel/v1/logs`/`/v1/metrics`、opencode/claude 既有分支、`Dashboard` 框架筛选（动态派生） | 无迁移、不触碰 | 防误改 |

### 2.4 Functional Impact Details

| Change Type | Functional Node | Change Point | Corresponding Requirement |
|----------|----------|--------|----------|
| Add | 客户端接入规约 | 双路径配置规约 + 自研兜底附录 + 互斥声明 | FR-007/BR-010/BR-012 |
| Add | OTLP protobuf 受理 | 编码分派 + 解码 + id/AnyValue 归一 + 解码前防护 | FR-002/BR-004/DC-005 |
| Add/Modify | OTLP 接入解析 | openclaw 映射条目 + 双形状整形 + framework 契约校验 | FR-001/003/004/005/012 |
| Add | 鉴权归属 | 聚合侧无归属丢弃（端点语义不动） | BR-003/NFR-003 |
| Add/Modify | 健壮性 | 畸形 protobuf 400、超体量/批量 4xx、字段截断复用 | FR-013/BR-006 |
| Add | 子 Agent 树 | 整形 + 解 `:2155` 门（集合化，与 hermes 共改） | FR-008/009/BR-007/NFR-007 |
| Add | agent 注册 | 整形携带标记，复用框架无关注册 | FR-010/BR-008 |
| Reuse | Skill 解析 | toolCall 形状归一，抽取器/分支零改动 + golden 用例 | FR-011/BR-009 |
| Modify | 接入引导 | openclaw 双模式 + 互斥声明 + listFrameworks 单一出处 | FR-006/BR-012/NFR-005 |
| Reuse | 评测承接 | 主/子 Agent 随 Execution 入库自动承接 | FR-015 |
| Modify | 不支持传输反馈 | gRPC 维持拒绝；指引更新（protobuf 已支持） | FR-014 |
| Add | 可自检 | 受理侧 + 处理侧（含 unattributed 丢弃）双处结构化日志 | NFR-006 |

## §3 Technical Design

### 3.1 Tech Stack

- **Backend**: Next.js 16.1.4（App Router, Route Handlers）, Node.js 22.17.1（WSL/nvm）, TypeScript 5.x
- **DB/ORM**: Prisma 5.22 + SQLite（本期零迁移）
- **Telemetry**: OTLP/HTTP（`application/json` 既有 + `application/x-protobuf` 本期新增）；解码选型候选 `@opentelemetry/otlp-transformer` / `protobufjs`（均已在 `@opentelemetry/sdk-node ^0.216.0` 依赖树内，优先复用，避免新增直接依赖版本漂移）
- **Test**: 项目既有 Node test runner + tsx；新增解码/映射/整形纯函数单测与 golden 用例

### 3.2 Core Decisions

#### Decision 1: protobuf 解码 = 薄壳编码分派层适配（对 spool-consumer 的显式契约修订）
**Rationale**: OpenClaw 内置导出仅 http/protobuf，不解码则纯配置主路径不成立；放在「读 body」分派处使下游零分叉、框架无关。**选型决定性依据 = traceId/spanId hex 归一正确性**（归一错以「不报错、只裂会话/重复」隐蔽击穿幂等与归并）。
**Alternative**: 仅支持 json、靠插件转码（否决：主路径塌缩为插件依赖，违背用户 P0 确认）；端点外置转换代理（否决：新增部署面）。

#### Decision 2: 双形状整形复用两条下游链路（零改消费者）
**Rationale**: skill 链路认「`responseMessage.content` 内扁平 toolCall 块」（`interaction-utils.ts:146` 实际契约），树链路认 opencode 语义标记——整形各产一份，两边函数体零改动；唯一存量改动收敛到 `:2155` 一行。
**Alternative**: 改抽取器/建树读 OTLP 原生字段（否决：扩大冻结区改动、与 hermes 设计冲突）。

#### Decision 3: 聚合侧归属防线（不动端点鉴权）
**Rationale**: 端点壳层归 spool-consumer 线（其本轮明确不收紧）；在聚合产出前丢弃无归属会话即可满足 NFR-003 实质（0 落匿名/他人），且与薄壳异步模型无冲突。
**Alternative**: 端点强 401（否决：与 spool-consumer 正面冲突，用户已确认取舍）。

#### Decision 4: 客户端复用优先，平台零客户端代码
**Rationale**: 纯配置利用 OpenClaw 内置导出；插件路径复用 aliyun 形态 exporter（已解决 GenAI 语义与版本矩阵难点）；自研仅兜底规约。
**Alternative**: 平台自研维护专属插件（否决：承担版本兼容矩阵维护成本，BR-010）。

### 3.3 Data Model

零 schema 变更。interaction JSON 复用 hermes 设计可选字段（`raw`/`_degraded`/`_truncated`/agent 标记）+ openclaw 双形状容器约束（`responseMessage.content[]` 扁平 toolCall 块）。详见 [Phase2 §5](phase2-requirements-design.md)。

### 3.4 Interface Contracts

- **POST `/v1/traces`**（重写至 `/api/ingest/otel/v1/traces`）：Header `x-witty-api-key` + `Content-Type: application/json | application/x-protobuf`；Body OTLP `resourceSpans`（要求 `service.name=openclaw`）；错误码：400 畸形/非法 protobuf/缺 resourceSpans、413/400 超体量（解码前）、4xx 超批量+分批提示、gRPC 拒绝+指引。
- 客户端 env 契约：`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`（全路径）/`OTEL_EXPORTER_OTLP_HEADERS="x-witty-api-key=…"`/`OTEL_SERVICE_NAME=openclaw`/`OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`。
- 内部纯函数契约（IF-N01~N05、IF-M01/M02、IF-R01~R07）见 [Phase2 §6](phase2-requirements-design.md)。

## §4 Task Breakdown

### 4.1 Upstream Gap Analysis

- **G1 openclaw 两路径真实属性未知（DC-008）**：T001 双形状采样定稿映射表/契约；样本前以「标准 GenAI 判定 + 降级保留」先行实现。（Status: Default Applied，待 T001 收敛）
- **G2 插件鉴权头可配置性（DC-009）**：T001 一并验证；失败走兜底链（平台兼容 Basic 头列协商③ / 自研兜底规约）。（Status: Pending Decision，T001 后定）
- **G3 三线均未落地，落地顺序不定**：全部任务按「目标态接线 + 回退条款」双写；F4 核验不得固化临时路径。（Status: Resolved by 回退条款）
- **G4 protobuf 解码选型未定**：T004 内做对比 spike，决定性依据 = id hex 归一正确性 + 依赖树内复用优先。（Status: Resolved by T004 spike）
- **G5 `:2155` 与 hermes 共改同一行**：约定「先落地者把门限改为 `SUBAGENT_TREE_FRAMEWORKS` 集合判断，后落地者仅向集合加值」；本计划 T007 按此实现并在 PR 描述声明。（Status: Resolved by 集合化约定）
- **G6 性能基线**：端点受理继承 spool-consumer「P99<100ms、≤500 span」；protobuf 解码增量由 F3 实测回填。（Status: Default Applied）
- **G7 onboardModes 协商④未闭环**：T010 回退方案 = 引导内硬编码 openclaw 双模式输出 + 标注「待 registry descriptor 扩展后收编」。（Status: Pending Decision，不阻塞）

### 4.2 Task Organization Strategy

**Organization Method**: Hybrid（按架构耦合分组 + 按依赖分层）。

**Rationale**:
- Wave 0 聚焦「事实采集」（T001 双形状样本 + DC-009 验证）——它阻塞映射表/契约/规约三项定稿，且**不依赖平台 protobuf 支持**（可用本地 collector 接收转储），故最先行。
- Wave 1 聚焦「服务端核心链路」：protobuf 解码（T004，不依赖样本，可与 T001 并行启动 spike）与映射/整形/归属防线（T005/T006，依赖 T001）；构成 MVP。
- Wave 2 聚焦「下游能力打通」（解门/adapter/注册评测验证），彼此低耦合可并行。
- Wave 3 聚焦「接入体验与端到端验收」（引导 + 双路径端到端），依赖前两波。

**MVP Scope**:
- **Phase 1 (MVP)**: 纯配置路径 protobuf 上报 → 解码受理 → 解析归并 → 归属防线 → framework=openclaw 入库看板可见（FR-001/002/003/004/013 + NFR-002/003）。
- **Phase 2-3 (Incremental)**: 子 Agent 树/注册/skill 全链路（FR-008~012）、接入引导（FR-006）、客户端规约定稿（FR-007）、评测承接（FR-015）。

### 4.3 需求覆盖矩阵（FR/NFR → Task → AC）

| 需求 | Task | 验收 |
|-|-|-|
| FR-001 端到端接入 | T001(客户端) + T004 + T005 + T006 + T011 | AC-001/002 |
| FR-002 protobuf 解码 | **T004** | AC-001/003 |
| FR-003 解析归并 | T005 + spool/回退路径接线(T006) | AC-004(批次幂等) |
| FR-004 framework 标识 | T005(resolver 契约校验) | AC-001/018 |
| FR-005 属性映射兜底 | T005(降级保留) | AC-010 |
| FR-006 接入引导 | **T010** | AC-008 |
| FR-007 客户端接入规约 | **T002**（T001 后定稿） | AC-016 |
| FR-008 子 Agent 链路层级 | T005(整形) + T007 | AC-005 |
| FR-009 子 Agent 多 Execution 树 | **T007** | AC-012 |
| FR-010 agent 自动注册 | T009 | AC-013 |
| FR-011 skill 全链路 | T005(双形状) + T008 + golden 用例 | AC-014 |
| FR-012 语义契约 | T001 + T003（契约文档） | AC-016 |
| FR-013 畸形/超限 | T004(解码前防护) + 复用 payload-guard | AC-011 |
| FR-014 gRPC 显式反馈 | T004(分派处维持拒绝+指引更新) | AC-006 |
| FR-015 评测承接 | T009(验证) | AC-015 |
| BR-001 单一框架标识 | T005 + T011(TC-018) | AC-018 |
| BR-003/NFR-003 归属隔离 | **T006(attribution-guard)** | AC-006/009 |
| BR-012 watcher 互斥 | T002/T010(声明) | AC-008 |
| NFR-001 存量零回退 | 各任务 Must-NOT-do + T007(watcher 回归) + F3/F4 | AC-007 |
| NFR-002 幂等容错 | T004(id 归一) + T005(per-span 容错) + spool 机制 | AC-004/017 |
| NFR-004/005 可扩展/低成本 | T004(编码分派位) + T008(adapter 样板) | — |
| NFR-006 可自检 | T006(双处日志) | — |
| NFR-007 与 opencode 等价 | T005 + T007 | AC-012 |
| NFR-008 解码不劣化端点 | T004 + F3(基线回填) | — |

## §5 Execution Waves

```text
Phase 0: 事实采集与客户端规约 (Wave 0)
Preconditions: 真实 OpenClaw 环境可用（本地 collector 接收, 不依赖平台 protobuf 支持）
├── T001: 双路径真实样本采集 + DC-009 鉴权头验证 + service.name 缺省值确认 [Medium]
├── T002: 客户端接入规约文档（双路径 + 自研兜底附录 + 互斥声明; T001 后定稿） [Low]
└── T003: OTLP agent/skill 语义契约文档（openclaw 形状, 据 T001 定稿） [Low]
Deliverables: 两形状样本入库 docs/design/openclaw-otel-adapter/samples/；规约与契约文档（阻塞 T005 定稿）；G2 闭环

Phase 1: 服务端核心链路 (Wave 1, MVP)
Preconditions: 协商①(protobuf 契约修订)闭环；T004 可先行 spike；T005 需 T001 样本（T006 仅依赖协商②，与样本无关）
├── T004: otlp-protobuf-decoder（选型 spike + 解码 + id/AnyValue 归一 + 防护 + 端点编码分派接入） [High]
├── T005: openclaw 语义映射条目 + 双形状整形 + golden 用例（semantic-mapping/resolver/agent-semantics 扩展） [High]
└── T006: attribution-guard 归属防线 + 双处结构化日志 + 聚合编排接线（目标态 aggregator / 回退同步路径） [Medium]
Deliverables: 纯配置路径 protobuf 端到端入库, 看板出现 framework=openclaw（AC-001/003/011 核心路径）

Phase 2: 下游能力打通 (Wave 2)
Preconditions: Phase 1 完成；registry getAdapter 可用（或回退既有 dispatcher 分支）
├── T007: 解 :2155 门（集合化）+ sweep 副作用专项用例 + watcher 存量回归 [Medium]
├── T008: adapters/openclaw.ts OTel 能力挂载（extractSkills 双形状确认 + subagentTree 能力, 与 T007 并行） [Low-Medium]
└── T009: agent 自动注册与评测承接验证（验证型; **T007 完成后启动**, 可与 T008 剩余部分并行） [Low]
Deliverables: 多 Agent 拆多条 Execution + 树（AC-012）、自动注册（AC-013）、skill 全链路（AC-014）、可评测（AC-015）

Phase 3: 接入体验与端到端验收 (Wave 3, T010 可与 Wave 2 并行)
Preconditions: T010 需 Phase 0（配置块内容）；T011 需 Phase 1/2 全部
├── T010: setup 交互式+auto 双模式引导 + 互斥声明 + 多副本一致性 [Medium]
└── T011: 双路径端到端集成验收（json/protobuf 等价、归并键回退、双路单一口径） [Medium]
Deliverables: 引导可用（AC-008）、端到端验收通过（AC-001/002/003/017/018）

Phase FINAL: Quality Validation & Delivery (Wave N)
Preconditions: All functional Phases completed
├── F1: Plan Compliance Audit
├── F2: Code Quality Review
├── F3: Real Scenario Manual QA（含性能基线回填）
└── F4: Scope Fidelity Check（含「临时回退路径未固化」核验）
Deliverables: 全部 AC 通过, 待用户确认交付

Critical Path: T001 → T005 → T007 → T011 → F1-F4
Maximum Concurrency: Wave 1 有 3 任务（T004 与 T005/T006 可并行）
```

## §6 Task List

### Phase 0: 事实采集与客户端规约

**Core Objective**: 拿到两条路径的真实 OTLP 样本与配置事实，定稿客户端规约与语义契约，解除 G1/G2 阻塞。

**Independent Validation Criteria**:
- [ ] `ls docs/design/openclaw-otel-adapter/samples/*.json` → 至少 2 个样本（纯配置形状 + 插件形状）
- [ ] 规约/契约文档存在且记录 DC-009 验证结论与 service.name 实际缺省值

**Git Commit**:
- YES
- Message: `docs(openclaw-otel): 采集双路径真实样本并定稿客户端接入规约与语义契约`

**Task List**:

---

- [ ] T001 双路径真实样本采集 + DC-009 验证 - `docs/design/openclaw-otel-adapter/samples/`

   - **Delegate Subagent**:
     + YES
     + Subagent Type: explorer / tester
     + Effort: Medium
     + Parallelism: 无（Wave 0 首任务；T004 的 spike 子步可与其并行）

   - **What to do**:
     + 在真实 OpenClaw 环境（参考 langfuse 报告 §4/§5 的环境要求）：①**纯配置路径**——设置 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 指向本地 OTel collector（`otelcol-contrib` + file/debug exporter，protobuf→json 转储），跑一次含 LLM+工具调用（理想含多 Agent + skill）的任务，导出 trace JSON；②**插件路径**——安装 aliyun 形态 exporter，endpoint 指向本地 collector，同样跑一次并导出。
     + 验证 DC-009：检查插件配置面是否支持自定义 `x-witty-api-key` 头（标准 OTLP headers 透传机制）；记录结论（成功/失败 + 失败时走 §2.2.0 兜底链哪一支）。
     + 记录事实：两路径的 `service.name` 实际缺省值、是否携带 `session.id`、agent 身份属性有无（决定 D-005 能力差异口径是否触发）、`gen_ai.*`/`gen_ai.span.kind` 实际命名、skill 调用的 span 表示、trace 碎片化程度（一次任务产生几条 trace）。
     + 样本（脱敏后）存入 `docs/design/openclaw-otel-adapter/samples/`，事实清单写入采样纪要。

   - **Must NOT do**:
     + 不得把样本直接打到生产平台端点（污染数据）；不得修改 OpenClaw 内核或 fork 插件；不得在无样本时臆造属性约定写入契约。

   - **Parallelism Info**:
     + Can Parallel: YES（与 T004 的选型 spike 并行）
     + Prerequisite Tasks: 无
     + Blocking Tasks: T002, T003, T005

   - **Reading List**:
     + Pattern: `docs_backup/openclaw-langfuse-接入分析报告.md` §4.2/§5.2 - 两路径配置方式与容器网络坑
     + API/Type: `docs/design/openclaw-otel-adapter/phase2-requirements-design.md` §2.2.0/§4.2 - 待验证事实清单与契约左列

   - **Acceptance Criteria**:
     + [ ] `ls docs/design/openclaw-otel-adapter/samples/` → ≥2 个 JSON 样本 + 1 份采样纪要
     + [ ] 纪要含 DC-009 结论、service.name 缺省值、agent 身份属性有无、碎片化程度四项事实

   - **QA Scenario**:
   ```
   Scenario: 双路径样本完整性
     Tool: 人工核查 + jq
     Preconditions: 样本已入库
     Steps:
       1. jq '.resourceSpans[0].resource.attributes' samples/pure-config.json → 确认 service.name 记录
       2. 对照纪要核对 gen_ai.* 属性命名与 Phase2 §4.2 契约左列差异
     Expected Result: 契约左列每行均有「证实/证伪/缺失」标注
     Evidence: .sisyphus/evidence/task-T001-samples.txt
   ```

---

- [ ] T002 客户端接入规约文档（FR-007） - `docs/design/openclaw-otel-adapter/client-onboarding-spec.md`

   - **Delegate Subagent**:
     + YES
     + Subagent Type: documenter
     + Effort: Low
     + Parallelism: T003

   - **What to do**:
     + 按 Phase2 §2.2.0 成文：①纯配置 env 规约（含 `TRACES_ENDPOINT` 全路径 vs `ENDPOINT` 自动拼接的差异说明，规避 404）；②插件复用规约（安装、version-compat 矩阵机制、endpoint/鉴权配置，按 T001 的 DC-009 结论写定）；③附录自研插件最小规约（hook→GenAI span→OTLP 骨架 + 重试/超时/批量/背压/静默失败硬性要求）；④watcher 互斥声明；⑤排障自检清单（受理/处理双处日志、丢弃不可恢复口径、容器网络速查）。
     + 写明两路径能力差异口径（D-005：子 Agent 树完整能力以插件路径为准，若 T001 证实纯配置无 agent 身份属性）。

   - **Must NOT do**:
     + 不得写入未经 T001 证实的属性承诺；不得承诺双路（watcher+OTel）去重。

   - **Parallelism Info**:
     + Can Parallel: YES（与 T003）
     + Prerequisite Tasks: T001
     + Blocking Tasks: T010（引导配置块内容来源）

   - **Reading List**:
     + Pattern: `docs/design/hermes-otel-adapter/phase2-requirements-design.md` §2.2.0 - 同类客户端规约的结构
     + External: langfuse 报告 §4.2/§6 - 配置示例与排障坑位迁移

   - **Acceptance Criteria**:
     + [ ] 文档含 5 个章节（纯配置/插件/自研附录/互斥/排障）且 DC-009 结论已写定
     + [ ] AC-016 自查：属性约定记录与 T001 采样一致

   - **QA Scenario**:
   ```
   Scenario: 按规约冷启动接入
     Tool: 人工演练
     Preconditions: 纯净 OpenClaw 环境 + 文档
     Steps: 1. 仅凭文档完成纯配置路径配置 2. 检查无歧义步骤
     Expected Result: 不需要查阅文档以外的资料即可完成配置
     Evidence: .sisyphus/evidence/task-T002-spec-walkthrough.txt
   ```

---

- [ ] T003 OTLP agent/skill 语义契约文档（FR-012） - `docs/design/openclaw-otel-adapter/otel-semantic-contract.md`

   - **Delegate Subagent**:
     + YES
     + Subagent Type: documenter
     + Effort: Low
     + Parallelism: T002

   - **What to do**:
     + 以 Phase2 §4.2 契约表为骨架，用 T001 事实将左列（openclaw OTLP 来源）逐行定稿（证实/证伪/缺失三态；缺失项写明降级行为）；右列（整形目标）保持 Phase2 定义不变。
     + 区分纯配置与插件两种形状的差异列。

   - **Must NOT do**:
     + 不得改右列（下游消费者契约，受 golden 用例守护）；不得保留未标注三态的行。

   - **Parallelism Info**:
     + Can Parallel: YES（与 T002）
     + Prerequisite Tasks: T001
     + Blocking Tasks: T005（映射表/整形据此定稿）

   - **Reading List**:
     + Pattern: `docs/design/openclaw-otel-adapter/phase2-requirements-design.md` §4.2 - 契约骨架

   - **Acceptance Criteria**:
     + [ ] 契约表每行有三态标注与样本出处（样本文件名+span 名）

   - **QA Scenario**:
   ```
   Scenario: 契约-样本一致性抽查
     Tool: jq + 人工
     Preconditions: T001 样本 + 契约文档
     Steps: 1. 随机抽 3 行契约 2. 在样本中定位对应属性
     Expected Result: 3/3 行可在样本中复现或标注「缺失+降级行为」
     Evidence: .sisyphus/evidence/task-T003-contract-check.txt
   ```

---

### Phase 1: 服务端核心链路（MVP）

**Core Objective**: 纯配置路径（protobuf）端到端入库，看板可见 framework=openclaw；json/protobuf 等价；无归属会话不落库。

**Independent Validation Criteria**:
- [ ] 单测全绿：`npx tsx --test src/lib/ingest/otel/__tests__/*.test.ts` → PASS（WSL + node 22.17.1）
- [ ] 以 protobuf 样本 POST `/v1/traces` → 200；处理后看板查询返回 framework=openclaw 会话
- [ ] 同一逻辑 trace json/protobuf 双发 → 入库结果字段级一致

**Git Commit**:
- YES
- Message: `feat(ingest): OTLP protobuf 解码 + openclaw 语义映射/双形状整形 + 聚合侧归属防线`

**Task List**:

---

- [ ] T004 otlp-protobuf-decoder（选型 spike + 解码 + 归一 + 防护 + 端点接入） - `src/lib/ingest/otel/otlp-protobuf-decoder.ts`、`src/app/api/ingest/otel/v1/traces/route.ts:43-47`

   - **Delegate Subagent**:
     + YES
     + Subagent Type: coder
     + Effort: High
     + Parallelism: T005, T006（不依赖 T001 样本；spike 可在 Wave 0 期间先行）

   - **What to do**:
     + **TDD 先行**：先编写失败用例与断言清单（id 小写 hex 归一、json/protobuf 同 trace deepEqual、非法字节流/超体量/超批量 4xx、AnyValue 各类型归一），再做 spike 与实现。
     + **Spike**：对比 `@opentelemetry/otlp-transformer` 与 `protobufjs`+官方 OTLP proto 的解码产物——**决定性断言：traceId/spanId 输出为小写 hex（非 base64）**；AnyValue oneof/intValue 字符串化行为；优先复用 `@opentelemetry/sdk-node` 依赖树内版本（不新增直接依赖则锁版本说明）。
     + 实现纯函数 `decodeOtlpProtobuf(rawBytes, limits)`（Phase2 §4.1 伪码）：解码前字节上限（默认 8MB）→ 解码（失败→可判定错误对象，由 route 映射 400）→ span 批量上限（默认 500，超限→4xx 分批提示）→ id/AnyValue 归一 → 返回与 `JSON.parse` 产物同构对象。
     + route.ts 接入：`:43-47` 的 Content-Type 分支中，`application/x-protobuf` 由「返回 415」改为「调 decoder → 汇入既有 json 后续逻辑」；gRPC/未知类型维持拒绝，错误文案更新为「改用 OTLP/HTTP json 或 protobuf」。
     + 单测：合法 protobuf/非法字节流/空 body/超体量/超批量/id 归一（**与 json 同 trace 逐字段断言相等**）/AnyValue 各类型。

   - **Must NOT do**:
     + 不得改动 route 中编码分派以外的逻辑（鉴权/归并/落库现状归 spool-consumer 线）；不得触碰 `/v1/logs`、`/v1/metrics`；不得在协商①未闭环时合入 route 改动（decoder 纯函数与单测可先行合入）；不得新增与依赖树内版本冲突的直接依赖。

   - **Parallelism Info**:
     + Can Parallel: YES（与 T005/T006）
     + Prerequisite Tasks: 协商①闭环（仅 route 接入步）
     + Blocking Tasks: T011（protobuf 端到端）

   - **Reading List**:
     + Pattern: `src/app/api/ingest/otel/v1/traces/route.ts:43-47` - 现行 Content-Type 处理与 415 分支
     + API/Type: `docs/design/otel-spool-consumer/phase2-requirements-design.md` - 薄壳端点职责边界（IF-E02 契约修订对象）
     + External: OTLP proto 规范（trace/v1）- ExportTraceServiceRequest 结构与 JSON 映射约定（id hex）

   - **Recommended Skills**:
     + `verify`: route 接入后实际起服发包验证

   - **Acceptance Criteria**:
     + [ ] `npx tsx --test src/lib/ingest/otel/__tests__/otlp-protobuf-decoder.test.ts` → PASS（含 id hex 归一断言）
     + [ ] `curl -X POST /v1/traces -H 'Content-Type: application/x-protobuf' --data-binary @sample.pb` → 200（合法）/ 400（非法字节流）
     + [ ] 同 trace json/protobuf 双发归一化产物 deepEqual

   - **QA Scenario**:
   ```
   Scenario: protobuf 等价性与防护
     Tool: curl + 单测
     Preconditions: 平台运行（WSL）
     Steps:
       1. 以 T001 纯配置样本（转回 protobuf）上报 → 200
       2. 同内容 json 上报 → 入库结果比对
       3. 上报 9MB 包 / 600 span 包 / 随机字节流
     Expected Result: 等价一致；413/4xx 分批提示/400，无部分写入，无 5xx
     Evidence: .sisyphus/evidence/task-T004-protobuf.txt
   ```

---

- [ ] T005 openclaw 语义映射条目 + 双形状整形 + golden 用例 - `src/lib/ingest/otel/`（semantic-mapping / framework-resolver / agent-semantics；hermes 线滞后则本任务建骨架）

   - **Delegate Subagent**:
     + YES
     + Subagent Type: coder
     + Effort: High
     + Parallelism: T004, T006

   - **What to do**:
     + **TDD/golden 先行**：先编写 golden 用例（用 `extractSkillsWithVersionsFromOpenClawSession` 与 `buildAgentCallTree` **原函数**对整形产物断言）与映射单测清单（插件/纯配置/降级/infra/无 agent 退化五路径，输入取 T001 样本），再实现条目与整形。
     + 按 T003 契约实现映射条目：`gen_ai.span.kind` 分类（ENTRY/AGENT→agent 边界、LLM→llm、TOOL→tool）；纯配置回退判定（`gen_ai.*`/`llm.*` 前缀 + `tool.name`，把 `route.ts:94-141` 现行逻辑纯函数化复用）；生命周期 span（`session_start·end`/`gateway_start·stop`/`enter_openclaw_system`）归 infra 跳过；未命中但有效调用 → `raw`+`_degraded` 降级保留。
     + framework-resolver：`service.name=openclaw` 契约校验；T001 证实的变体（如有）入归一映射；缺失告警不落 `unknown-service`。
     + agent-semantics 双形状整形：工具/skill span → **扁平块 `{type:'toolCall', name, arguments}` 置入 `responseMessage.content[]`**；agent 边界 → opencode 同构标记（`tool_calls[name='task']`/`subagent_type`/`subagent_session_id`/`role`/`agent`）；无 agent 属性 → 单主 Agent 安全退化。
     + **golden 用例**：用 `extractSkillsWithVersionsFromOpenClawSession` **原函数**（import 自 `interaction-utils.ts:146`）跑整形产物，断言 invokedSkills 非空且含版本；用 `buildAgentCallTree` 原函数跑多 Agent 整形产物，断言树结构与构造预期一致。
     + 单测覆盖：插件形状/纯配置形状/降级/infra/无 agent 退化路径（输入用 T001 样本）。

   - **Must NOT do**:
     + **禁止**产出嵌套 `toolCall:{...}` 对象或置于 interaction 顶层 `content[]`（Phase2 E-1）；禁止修改 interaction-utils/agent-trace/agent-registration/derive 任何冻结函数；禁止让建树读 parentSpanId；禁止臆造 T001 未证实的属性键。

   - **Parallelism Info**:
     + Can Parallel: YES（与 T004/T006）
     + Prerequisite Tasks: T001, T003
     + Blocking Tasks: T007, T008, T011

   - **Reading List**:
     + Pattern: `src/lib/shared/interaction-utils.ts:146-178` - 抽取器实际读取容器与扁平块形状（右列契约的唯一事实）
     + Pattern: `src/lib/engine/observability/openclaw-parser.ts:140-145` - watcher 路径产出的同款形状
     + Pattern: `src/lib/engine/observability/agent-trace.ts:209` - buildAgentCallTree 期望的 opencode 语义键名
     + API/Type: `docs/design/hermes-otel-adapter/phase2-requirements-design.md` §2.2.1/§4.2 - 适配层纯函数骨架与 hermes 整形同款策略
     + API/Type: `docs/design/openclaw-otel-adapter/otel-semantic-contract.md`（T003 产物）- 定稿契约

   - **Acceptance Criteria**:
     + [ ] `npx tsx --test src/lib/ingest/otel/__tests__/openclaw-*.test.ts` → PASS
     + [ ] golden 用例：原函数抽取 invokedSkills 非空含版本；原函数建树结构正确

   - **QA Scenario**:
   ```
   Scenario: 双形状整形 golden 守护
     Tool: 单测
     Preconditions: T001 样本可用
     Steps: 1. 以插件形状样本整形 2. 原函数抽 skill/建树 3. 以纯配置样本整形验证退化
     Expected Result: skill 非空含版本; 树与预期一致; 纯配置无 agent 属性时单主 Agent 不报错
     Evidence: .sisyphus/evidence/task-T005-golden.txt
   ```

---

- [ ] T006 attribution-guard 归属防线 + 双处日志 + 聚合编排接线 - `src/lib/ingest/otel/attribution-guard.ts` + 接线点（目标态 traces-aggregator / 回退 `route.ts:194-209` 同步路径）

   - **Delegate Subagent**:
     + YES
     + Subagent Type: coder
     + Effort: Medium
     + Parallelism: T004, T005

   - **What to do**:
     + 实现谓词纯函数 `guardAttribution({user, taskId, framework, eventCount})` → `{pass} | {drop, reason:'unattributed'}`；调用方在产出 ExecutionRecord 后、`saveExecutionRecord` 前判定，drop 时记结构化日志（含会话键/原因/事件数）并**不落库**（不复制现状 `route.ts:204` 的 anonymous 兜底）。
     + 双处结构化日志：受理侧 `{authResult, contentType, spanTotal, httpCode}`（route 现有告警增补字段）；处理侧 `{taskId, framework, mappedCount, skippedCount, degradedCount, dropped?}`（聚合编排处统一记录，纯函数以 stats 返回值回传计数）。
     + 接线：目标态挂 `aggregateOtelTraceSession` 落库前；spool-consumer 滞后则挂 route 现状同步路径同一位置（标注 `TODO(切回薄壳)`）。
     + 单测：无 key/非法 key/合法 key 三态；端到端用例：无 key 上报 → 200 受理但 0 写入 + drop 日志。

   - **Must NOT do**:
     + 不得改端点鉴权返回码（强 401 归 spool-consumer 后续轮）；不得把 drop 会话写入任何用户（含 anonymous）名下；不得静默丢弃（必须有结构化日志）。

   - **Parallelism Info**:
     + Can Parallel: YES（与 T004/T005）
     + Prerequisite Tasks: 协商②（落点确认；回退路径不受阻）
     + Blocking Tasks: T011

   - **Reading List**:
     + Pattern: `src/app/api/ingest/otel/v1/traces/route.ts:25-36,194-209,204` - 现状鉴权解析与 anonymous 兜底（要替代的行为）
     + API/Type: `docs/design/otel-spool-consumer/phase2-requirements-design.md` - aggregator 编排位置与日志分层

   - **Acceptance Criteria**:
     + [ ] 单测三态 PASS；无 key 端到端：200 + DB 0 新增 + 日志含 `unattributed`
     + [ ] 合法 key 数据归属正确（TC-009 双用户隔离）

   - **QA Scenario**:
   ```
   Scenario: 无归属丢弃与隔离
     Tool: curl + sqlite 查询
     Preconditions: 平台运行, 两个测试用户 key
     Steps: 1. 无 key 上报 2. 用户A/B 各自上报 3. 查询 DB 与日志
     Expected Result: 无 key 0 写入+drop 日志; A/B 互不可见; 无 anonymous 记录
     Evidence: .sisyphus/evidence/task-T006-attribution.txt
   ```

---

### Phase 2: 下游能力打通

**Core Objective**: openclaw OTel 会话获得与 opencode 等价的子 Agent 树/自动注册/skill 全链路/评测承接；watcher 存量零回退。

**Independent Validation Criteria**:
- [ ] 多 Agent 样本入库 → `1+M` 条 Execution、parent/root 链正确、可按 rootExecutionId 聚合
- [ ] watcher 存量回归用例 PASS（解门后行为不变）
- [ ] RegisteredAgent 出现 platform=openclaw 主/子记录且无重复

**Git Commit**:
- YES
- Message: `feat(storage): openclaw 纳入子 Agent 树派生（集合化门限）+ adapter 能力挂载`

**Task List**:

---

- [ ] T007 解 :2155 门（集合化）+ sweep 专项用例 + watcher 回归 - `src/lib/storage/data-service.ts:2155`

   - **Delegate Subagent**:
     + YES
     + Subagent Type: coder
     + Effort: Medium
     + Parallelism: T008, T009

   - **What to do**:
     + 将 `targetRecord.framework === 'opencode'` 改为 `SUBAGENT_TREE_FRAMEWORKS.has(targetRecord.framework)`（集合常量，初值 `{'opencode','openclaw'}`；**若 hermes 线已先落地集合化，则仅向集合加 `'openclaw'`**——G5 合并策略，PR 描述显式声明）。
     + 专项用例①（sweep 副作用）：先入库含子 Agent 的 openclaw 会话 → 再以「缺 agent 标记的同会话全量数据」重聚合 → 断言子 Execution 不被误删（全量聚合语义下树仍可建）；用例②（构造性）：直接以 null 树路径调用验证 sweep 行为边界被理解记录。
     + watcher 存量回归：构造 watcher 形状 openclaw 记录过 `saveExecutionRecord` → 断言单 Execution、无子行、无 sweep 误删、行为与解门前一致。

   - **Must NOT do**:
     + 不得修改 `deriveSubagentExecutions`/`sweepStaleSubagents`/`buildAgentCallTree` 函数体；不得改 opencode/claude 行为；不得跳过 watcher 回归。

   - **Parallelism Info**:
     + Can Parallel: YES（与 T008/T009）
     + Prerequisite Tasks: T005
     + Blocking Tasks: T011

   - **Reading List**:
     + Pattern: `src/lib/storage/data-service.ts:2155,2230,2378-2390` - 门限与 sweep 调用链
     + API/Type: `docs/design/hermes-otel-adapter/phase2-requirements-design.md` D-004 - 同款解门策略

   - **Acceptance Criteria**:
     + [ ] 多 Agent 整形数据 → 1+M 条 Execution（isSubagent/parent/root 正确）
     + [ ] sweep 专项用例 + watcher 回归 PASS

   - **QA Scenario**:
   ```
   Scenario: 子 Agent 树与 sweep 守护
     Tool: 单测 + sqlite
     Preconditions: T005 整形可用
     Steps: 1. 入库 1主+2子 样本 2. 缺标记批次重聚合 3. watcher 形状记录入库
     Expected Result: 3 条 Execution 树正确; 重聚合不丢子行; watcher 行为不变
     Evidence: .sisyphus/evidence/task-T007-subagent.txt
   ```

---

- [ ] T008 adapters/openclaw.ts OTel 能力挂载 - `src/lib/ingest/adapters/openclaw.ts`（registry 线规划文件）

   - **Delegate Subagent**:
     + YES
     + Subagent Type: coder
     + Effort: Low-Medium
     + Parallelism: T007, T009

   - **What to do**:
     + 目标态：在 registry 的 `adapters/openclaw.ts` 上确认 `extractSkills`（指向 `interaction-utils.ts:146` 既有函数）对整形产物直通（golden 用例已证）；挂 subagentTree/整形能力到 registry 预留扩展点（`capabilities`）。
     + 回退态（registry 未落地）：**零代码改动**——既有 dispatcher `data-service.ts:487-489` openclaw 分支直接生效；本任务降级为验证 + 在跟踪 issue 标注「registry 落地后收编」。

   - **Must NOT do**:
     + 不得在 dispatcher 新增任何分支（openclaw 分支已存在）；不得复制抽取函数（单一实现）；不得另建框架清单。

   - **Parallelism Info**:
     + Can Parallel: YES（与 T007/T009）
     + Prerequisite Tasks: T005；registry getAdapter（目标态）
     + Blocking Tasks: T011

   - **Reading List**:
     + Pattern: `docs/design/framework-adapter-registry/phase2-requirements-design.md` §2/§3 - FrameworkAdapter 接口与 openclaw.ts 规划
     + Pattern: `src/lib/storage/data-service.ts:476-492` - 现行 dispatcher（回退态直用）

   - **Acceptance Criteria**:
     + [ ] OTel 入库会话的 invokedSkills 非空（含子 Agent 加载 skill 与版本）
     + [ ] 回退态：`git diff` 显示 dispatcher 零改动

   - **QA Scenario**:
   ```
   Scenario: skill 全链路
     Tool: 端到端 + sqlite
     Preconditions: T005/T007 完成, 样本含主调 skillA + 子加载 skillB
     Steps: 1. 上报入库 2. 查询 invokedSkills 3. Skill 诊断页核对
     Expected Result: 含 skillA/skillB 及版本; 诊断页「实际调用」非空
     Evidence: .sisyphus/evidence/task-T008-skills.txt
   ```

---

- [ ] T009 agent 自动注册与评测承接验证（验证型） - 无新增代码（`agent-registration.ts:14` 复用验证）

   - **Delegate Subagent**:
     + YES
     + Subagent Type: tester
     + Effort: Low
     + Parallelism: T007, T008

   - **What to do**:
     + 验证：openclaw OTel 主/子 Agent 首次入库 → RegisteredAgent 出现 platform=openclaw 记录（main/subagent 区分正确）；重复上报无重复行（(platform,name,user) 去重）。
     + 验证：入库 Execution（主与子）在「从 Trace」评测入口可检索/选中/发起评测（FR-015/AC-015）。
     + 若注册未生效，**先查整形标记**（T005 的 `agent/subagent_name/role`）而非改注册函数；确需改动则仅泛化 role 判定并保持框架无关，单独评审。

   - **Must NOT do**:
     + 默认不修改 `agent-registration.ts`；不得为 openclaw 加专属注册分支。

   - **Parallelism Info**:
     + Can Parallel: 部分（依赖 T007 完成后启动；启动后可与 T008 剩余部分并行）
     + Prerequisite Tasks: T005, T007
     + Blocking Tasks: T011

   - **Reading List**:
     + Pattern: `src/lib/engine/observability/agent-registration.ts:14` + `data-service.ts:2016-2050`（extractObservedAgentRegistrations 调用与 RegisteredAgent upsert）- 框架无关注册机制

   - **Acceptance Criteria**:
     + [ ] 首次上报后 RegisteredAgent 含 main+subagent 记录；重复上报行数不变
     + [ ] 主/子 Agent 均可发起「从 Trace」评测

   - **QA Scenario**:
   ```
   Scenario: 注册去重与评测承接
     Tool: 端到端 + UI
     Preconditions: 多 Agent 样本
     Steps: 1. 首次上报 2. 重复上报 3. 评测入口检索发起
     Expected Result: 注册记录正确无重复; 评测成功发起
     Evidence: .sisyphus/evidence/task-T009-registration.txt
   ```

---

### Phase 3: 接入体验与端到端验收

**Core Objective**: 用户可经引导自助完成双模式接入；双路径端到端验收通过。

**Independent Validation Criteria**:
- [ ] 引导输出两种 OTel 配置块 + 互斥声明；watcher 模式保留
- [ ] TC-001/002/003/004/017/018 端到端通过

**Git Commit**:
- YES
- Message: `feat(setup): openclaw 双模式接入引导 + OTel 端到端验收用例`

**Task List**:

---

- [ ] T010 setup 双模式引导 + 互斥声明 + 多副本一致性 - `src/app/api/ingest/setup/route.ts:97-98`、`setup/auto/route.ts:106-110,244-246`

   - **Delegate Subagent**:
     + YES
     + Subagent Type: coder
     + Effort: Medium
     + Parallelism: T011 前置，可与 Wave 2 并行

   - **What to do**:
     + 交互式 `route.ts` 新增 openclaw 选项（当前缺失）；`auto/route.ts` 在既有 watcher 项基础上增加 otel 模式分支（保留 watcher 下载逻辑 `:244-246` 不动）。
     + otel 模式输出 T002 规约中的可复制配置块（纯配置 env 块 / 插件安装块），均嵌互斥声明（BR-012）。
     + 配置块抽共享常量/模板，bash+PS × setup+auto 多副本一致性核验（脚本断言或对照测试）。
     + 框架清单：协商④闭环则读 `listFrameworks()` 的 `onboardModes`；未闭环则硬编码双模式输出 + `TODO(待 registry descriptor 扩展收编)` 标注（G7）。

   - **Must NOT do**:
     + 不得移除/改动 watcher 模式既有行为；不得另建第二份框架清单常量（registry 落地后）；不得输出未含互斥声明的 OTel 配置块。

   - **Parallelism Info**:
     + Can Parallel: YES（与 Wave 2 各任务）
     + Prerequisite Tasks: T002
     + Blocking Tasks: T011（AC-008 验收路径）

   - **Reading List**:
     + Pattern: `src/app/api/ingest/setup/auto/route.ts:106-110,244-246` - 既有框架枚举与 watcher 下载
     + Pattern: `docs/design/hermes-otel-adapter/phase3-development-plan.md` T005 - 同类四副本一致性处理

   - **Acceptance Criteria**:
     + [ ] 交互式与 auto 均出现 openclaw 双模式；配置块与 T002 规约一致；含互斥声明
     + [ ] 多副本一致性断言通过

   - **QA Scenario**:
   ```
   Scenario: 引导自助接入
     Tool: curl + 人工
     Preconditions: 平台运行
     Steps: 1. 走交互式引导选 openclaw→otel→纯配置 2. 按输出配置真实环境 3. 上报一次
     Expected Result: 看板 ≤1 次刷新出现会话（AC-008）
     Evidence: .sisyphus/evidence/task-T010-setup.txt
   ```

---

- [ ] T011 双路径端到端集成验收 - `src/lib/ingest/otel/__tests__/openclaw-e2e.test.ts` + 人工演练记录

   - **Delegate Subagent**:
     + YES
     + Subagent Type: tester
     + Effort: Medium
     + Parallelism: 无（收口任务）

   - **What to do**:
     + 按 Phase1 §4.2 执行并自动化（可自动化部分）：TC-001（纯配置 protobuf 端到端）、TC-002（插件路径端到端）、TC-003（json/protobuf 等价）、TC-004（分批幂等）、TC-017（归并键回退三组）、TC-018（watcher+OTel 双路单一 framework 口径）。
     + 真实环境演练 TC-016（按 T002 规约冷启动两路径），记录证据。

   - **Must NOT do**:
     + 不得跳过 protobuf 路径只测 json；不得用构造样本替代 T001 真实样本做 TC-001/002。

   - **Parallelism Info**:
     + Can Parallel: NO
     + Prerequisite Tasks: T004~T010
     + Blocking Tasks: F1-F4

   - **Reading List**:
     + API/Type: `docs/design/openclaw-otel-adapter/phase1-requirements-analysis.md` §4.2 - 全部 TC 定义

   - **Acceptance Criteria**:
     + [ ] TC-001/002/003/004/017/018 全部 PASS（自动化输出 + 演练记录）

   - **QA Scenario**:
   ```
   Scenario: 端到端全路径验收
     Tool: 自动化测试 + 真实环境演练
     Preconditions: 全部功能任务完成
     Steps: 按 TC 清单逐项执行
     Expected Result: 6/6 PASS
     Evidence: .sisyphus/evidence/task-T011-e2e.txt
   ```

---

## §7 Phase FINAL: Quality Validation & Delivery

**Objective**: 确保所有功能满足需求、代码质量达标、系统可交付。

**Validation Criteria**:
- [ ] Phase1 §4.1 全部 18 条 AC 通过（含修订补充的 AC-017/018）
- [ ] 代码质量检查通过（lint/type/test）
- [ ] 真实场景人工验收通过（含性能基线回填）
- [ ] 用户明确批准交付

**Task List**:

---

- [ ] F1 Plan Compliance Audit

   - **Validation Content**:
     + 实现满足 §4.3 覆盖矩阵全部需求；T001~T011 交付物齐备
   - **Output Format**:
   ```
   Must Have [N/N Pass]
   Must NOT Have [N/N Pass]
   Requirement Coverage [15 FR + 8 NFR Implemented]
   Evidence Files [N/N Exist]
   VERDICT: APPROVE / REJECT
   ```
   - **Parallelism Info**:
     + Can Parallel: YES
     + Prerequisite Tasks: All functional Phases

---

- [ ] F2 Code Quality Review

   - **Validation Content**:
     + lint / type check / 全部单测与 golden 用例
   - **Output Format**:
   ```
   Lint: PASS / FAIL
   Type Check: PASS / FAIL
   Tests: N pass / N fail
   Code Smells: N issues
   VERDICT: APPROVE / REJECT
   ```
   - **Parallelism Info**:
     + Can Parallel: YES
     + Prerequisite Tasks: All functional Phases

---

- [ ] F3 Real Scenario Manual QA

   - **Validation Content**:
     + Phase1 §2.1 主成功/备选/异常场景全表核验（含 S-017 互斥声明、S-018 版本矩阵的文档性验收）
     + 边界：空 body、9MB 包、600 span、非法 protobuf、无 key、缺 session.id
     + **性能基线回填**：端点受理 P99（json 与 protobuf 各测）、解码增量，回填 Phase2 §7.2
   - **Output Format**:
   ```
   Scenarios [N/N pass]
   Edge Cases [N tested]
   Perf Baseline [P99 json=Nms / protobuf=Nms]
   VERDICT: APPROVE / REJECT
   ```
   - **Parallelism Info**:
     + Can Parallel: YES
     + Prerequisite Tasks: All functional Phases

---

- [ ] F4 Scope Fidelity Check

   - **Validation Content**:
     + git diff 不超出 §2.3 授权范围；🔴 Protected/⚪ Not Involved 模块零改动（watcher 链路、冻结函数、schema、logs/metrics、opencode/claude 分支）
     + **临时回退路径未固化核验**：若 spool/registry 已落地，确认调用方已切回（无遗留 `TODO(切回薄壳)`/`TODO(待收编)`）
     + `:2155` 改动符合 G5 集合化约定（与 hermes 线无冲突合并）
   - **Output Format**:
   ```
   Authorized Changes [N/N files]
   Unauthorized Changes [N files - list paths]
   Fallback Residue [CLEAN / N TODOs]
   Scope Creep [CLEAN / N issues]
   VERDICT: APPROVE / REJECT
   ```
   - **Parallelism Info**:
     + Can Parallel: YES
     + Prerequisite Tasks: All functional Phases

## §8 Appendix

### 8.1 Development Strategies

- **Delegate Tasks**: 任务执行必须委派 sub-agent，防止主 Agent 上下文膨胀。
- **Multi-Agent**: Wave 内任务识别并行性后同时派发——Wave 1 同发 T004/T005/T006；Wave 2 先同发 T007/T008，T007 完成后再派 T009。
- **TDD**: 每个任务先定义测试清单再写实现；golden 用例（原函数断言）在整形实现前先行编写。
- **跨线协商先行**: 协商①（protobuf 契约修订）须在 T004 route 接入步前闭环；协商②④可异步，回退条款兜底。

### 8.2 Risk List

| Risk | Impact | Mitigation Measures |
|------|------|----------|
| T001 样本显示纯配置路径无 agent 身份属性 | Medium（FR-009 主路径退化） | D-005 能力差异口径：引导/规约明示完整能力走插件路径；不阻塞 MVP |
| DC-009 鉴权头假设证伪 | Medium（插件路径受阻） | 兜底链：协商③ Basic 头兼容评估 → 自研兜底规约启用 |
| 解码库 id 输出 base64（选型不当） | High（隐蔽裂会话/重复） | T004 spike 决定性断言 + json/protobuf 等价 golden 用例双层守护 |
| 三线落地顺序失配 | Medium（返工） | 回退条款 + F4「回退残留」核验；`:2155` 集合化约定（G5） |
| trace 碎片化（纯配置路径） | Low（已知限制） | 需求层已定可接受；引导推荐插件路径；T001 量化碎片化程度 |
| sweep 误删子 Execution | Medium | 按会话全量聚合 + T007 专项用例 |
| watcher 双开重复呈现 | Low（已知限制） | 互斥声明双处输出；不做去重 |

### 8.3 Coding Notes

- **测试环境**：必须在 WSL（Ubuntu-22.04）+ nvm node 22.17.1 下运行测试（Windows 侧 node 会因 esbuild 二进制失败）。
- 纯函数模块（decoder/mapping/semantics/guard）禁止 DB I/O 与日志副作用（计数走 stats 返回值），保证可单测。
- 错误响应必须确定性（同输入同状态码），4xx 文案含可操作指引（改用编码/分批/检查 key）。
- 所有新增可选 interaction 字段须保证旧消费者忽略安全（向后兼容）；禁止改既有字段语义。
- 提交粒度按 Phase（§6 各 Phase 的 Git Commit 约定）；`:2155` 改动单独小提交便于与 hermes 线合并。

### 8.4 评审与变更记录

| 版本 | 内容 |
|-|-|
| v0.1 | Phase3 初稿：4 Wave + FINAL、11 任务、G1~G7 缺口分析、需求覆盖矩阵、跨线协商先行策略与回退条款 |
| v0.2 | 评审修订（条件通过 87/100，0 ERROR）：**W-1** 关键路径统一为 T001→T005→T007→T011→F（移除 T004）；**W-2** T009 改为 T007 完成后启动（修正并行标注）、T008 Blocking 补 T011；**W-3** T009 注册机制锚点更正为 `data-service.ts:2016-2050`；**I-1** `agent-trace.ts` 锚点 :207→:209；**I-2** Wave1 前置修正（T006 不依赖样本）；**I-3** §8.1 笔误与 Phase3 验收补 TC-004；**I-4** T004/T005 任务体步骤前置 TDD/golden 用例编写 |
