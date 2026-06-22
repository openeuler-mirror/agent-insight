# OpenClaw 平台适配（OTel / OTLP 接入）— 开发计划（SDD）
版本：v0.3
最后更新：2026-06-17

> 文档类型：Phase3 开发计划 ｜ base_commit：5976cbb（master）｜ 状态：**v0.3（基于已评审 v0.2 重生成 + 现状刷新 → Phase3 评审通过 92/100，0 ERROR → 已按 W-A/W-B 微调）**
> 输入：[Phase1 需求分析](phase1-requirements-analysis.md) v0.3 + [Phase2 需求设计](phase2-requirements-design.md) v0.3.1
>
> **v0.3 核心刷新（相对 v0.2）**：同批两条目标架构**已落地**（详见 [Phase2 §8.2](phase2-requirements-design.md)），故 v0.2 的「跨线未落地依赖 + 回退条款」大幅收敛：
> - `otel-spool-consumer` 已落地（薄壳端点 `traces/route.ts` + 聚合 `claude-otel/` + 后台消费者 `otel-consumer/consumer.ts`）——无需回退同步路径。
> - `framework-adapter-registry` 已落地（`getAdapter`/`listFrameworks`、dispatcher 无裸分支、`openclawAdapter` 已注册）——skill 经 `getAdapter` 自动生效，无需 dispatcher 裸分支。
> - 残留协调项仅两条：**G5**（`:2368` 解门与 hermes 线潜在共改同一行，集合化约定）、**G7**（`onboardModes` 与 registry 线协商，不阻塞）。

## §1 Project Overview

| Information | Content |
|------|------|
| **Project Name** | agent-insight — OpenClaw OTel/OTLP 北向适配 |
| **Input Sources** | [Phase1](phase1-requirements-analysis.md) v0.3 + [Phase2](phase2-requirements-design.md) v0.3.1 |
| **Plan Type** | New Feature Development（北向多平台适配，含 1 项平台级协议能力 protobuf 解码） |
| **Estimated Effort** | Medium |
| **Parallel Execution** | YES - 4 Waves（+ FINAL） |
| **Critical Path** | T001 →(T003)→ T005 → T007 → T011 → F1-F4（T003 为 T005 的轻量前置契约门，含于 T001→T005 段；T004 不在关键路径） |

## §2 Change Scope

### 2.1 Initial Requirements

```text
使用 aet-analysis-and-design，参考 hermes-otel-adapter，生成 openclaw 的需求设计输出到 openclaw-adapter；
首先深入调查 openclaw 对 OTel 的支持；最终目标：把 openclaw 中 agent 的执行记录对接适配到 agent-insight。
```

### 2.2 Key Clarifications

- 客户端双路径：纯配置内置 OTLP exporter（主，零代码）+ aliyun 形态 exporter 插件（增强）；自研插件仅兜底（BR-010）。
- 与既有本地 watcher 接入并存 + 互斥指引（BR-012），framework 单一标识 `openclaw`（BR-001），不做双路去重。
- **P0 服务端补 OTLP http/protobuf 解码**（OpenClaw 内置导出仅 http/protobuf；端点现状 `:22-27` 返 415）。
- 无归属会话在**后台消费者落库前丢弃**（不落 anonymous，复用 `isServiceTraceOwner`；不改端点鉴权语义，D-003）。
- 双形状桥接经**已落地 `openclawAdapter.normalizeForStorage` 钩子**（`data-service.ts:1957` 调用）：扁平 toolCall 块（既有抽取器零改动）+ opencode 同构 agent 标记（建树/派生/注册零改动）；唯一存量逻辑改动 = 解 `data-service.ts:2368` 门限（D-004）。
- 范围对齐 hermes 全量（子 Agent 树/skill 一等/自动注册/评测承接）；难度 Medium；T001 真实样本为第一里程碑（D-005）。

### 2.3 Module Change Details

| Status | Module | Change Description | Constraints |
|------|------|----------|------|
| 🔵 External | OpenClaw 内置 OTel 导出（纯配置主路径） | env 指向平台（http/protobuf）。**平台不写代码**，仅出规约 | 不 fork、不改内核 |
| 🔵 External | aliyun 形态 exporter 插件（增强，复用开源） | GenAI 语义 span 树 + version-compat 矩阵 | 鉴权头 = DC-009 待 T001 验证，失败走兜底链 |
| 🟢 New | `src/lib/ingest/claude-otel/otlp-protobuf-decoder.ts` | 编码分派 + `ExportTraceServiceRequest` 解码 + **id bytes→hex / AnyValue 归一** + 解码前字节/批量上限 | 纯函数；产物与 json 路径**字段级同构**（AC-003）；优先复用 `@opentelemetry/sdk-node` 依赖树内 otlp-transformer/protobufjs |
| 🟡 Modified | `src/app/api/ingest/otel/v1/traces/route.ts:22-27` | `application/x-protobuf` 由「返回 415」改为「调 decoder → 汇入既有 json 后续」；gRPC 维持拒绝+指引（文案更新） | 仅改编码分派一处；禁改 `/v1/logs`、`/v1/metrics`；不内联落库 |
| 🟡 Modified | `src/lib/ingest/claude-otel/otlp-json.ts::normalizeClaudeOtlpTraces`（`:155-157`） | +openclaw 语义识别：`gen_ai.span.kind`(ENTRY/AGENT/LLM/TOOL)、span 命名、生命周期 span 归 infra 跳过、降级保留 | 仅叠加判定/数据条目；不改既有 claude/opencode 路径结果；据 T001 定稿 |
| 🟢 New | `src/lib/ingest/adapters/openclaw.ts` 的 `normalizeForStorage` | **双形状桥接**：嵌套 tool_calls → 扁平 `{type:'toolCall',name,arguments}` 置 `responseMessage.content` + opencode 同构 agent 标记 | **禁止**嵌套 toolCall 对象/顶层 content[]（Phase2 D-004/E-1 教训）；golden 用例守护；`extractSkills` 维持指向既有函数 |
| 🟢 New | `src/lib/ingest/claude-otel/attribution-guard.ts` + 接线 | 归属防线谓词；判定「user 空 或 `isServiceTraceOwner(user)`」→ drop + 日志 | 接线在 **`otel-consumer/consumer.ts:202-204` 与 `:225-230`** 两处 save 前（建议包 `saveExecution` 包装器）；复用 `isServiceTraceOwner`（`data-service.ts:165`）；不改端点鉴权语义 |
| 🟡 Modified | `src/lib/storage/data-service.ts:2368` | **唯一存量逻辑改动点**：`framework==='opencode'` 门限改为**集合判断**并纳入 openclaw（G5：先落地者集合化，后落地者仅加值） | 仅改该行；opencode/claude/hermes 行为零变更；watcher-openclaw 存量过门安全退化（专项回归） |
| 🟡 Modified | `src/app/api/ingest/setup/route.ts`（无 openclaw）+ `setup/auto/route.ts`（`:109` 有 watcher） | 交互式新增 openclaw；双模式引导（watcher 保留 + otel 新增：env 块/插件块）+ 互斥声明 | bash/PS × setup/auto 多副本一致；框架清单引用 registry `listFrameworks()`；`onboardModes` 协商（G7）未闭环则引导内输出 + 标注待收编 |
| 🔴 Protected | `interaction-utils.ts::extractSkillsWithVersionsFromOpenClawSession` | **不改**。读扁平 toolCall 块（`responseMessage.content`/assistant `requestMessages[].content`） | 函数体冻结；golden 用例用**原函数**断言桥接产物（含 version） |
| 🔴 Protected | `traces-aggregator.ts`（聚合器）、`deriveSubagentExecutions`（`:2437`）/`sweepStaleSubagents`（`:2601`）、`buildAgentCallTree`（`agent-trace.ts`）、`agent-registration.ts` | **不改**。聚合器框架无关；建树/派生/注册消费桥接后同构 interaction；sweep 副作用由按会话全量聚合缓解 + 专项用例 | 函数体冻结；禁止让建树读 parentSpanId |
| 🔴 Protected | `openclaw-watcher.ts`/`openclaw-parser.ts`（存量 watcher 链路） | **不改**。与 OTel 并存互斥 | NFR-001 回归保障 |
| ⚪ Not Involved | `prisma/schema.prisma`、`otel/v1/logs`/`/v1/metrics`、opencode/claude/hermes 既有分支、`Dashboard` 框架筛选（动态派生） | 无迁移、不触碰 | 防误改 |

### 2.4 Functional Impact Details

| Change Type | Functional Node | Change Point | Requirement |
|----------|----------|--------|----------|
| Add | 客户端接入规约 | 双路径配置规约 + 自研兜底附录 + 互斥声明 | FR-007/BR-010/BR-012 |
| Add | OTLP protobuf 受理 | 端点编码分派 + 解码 + id/AnyValue 归一 + 解码前防护 | FR-002/BR-004/DC-005 |
| Modify | OTLP 语义识别 | `otlp-json.ts` 扩 openclaw 条目（span.kind/生命周期/降级） | FR-001/003/005 |
| Add | 双形状桥接 | `adapters/openclaw.ts` normalizeForStorage | FR-011/FR-009 |
| Modify | framework 标识/变体 | service.name=openclaw 校验 + aliases 归一 | FR-004/BR-001 |
| Add | 鉴权归属 | 消费者落库前丢弃无归属（复用 isServiceTraceOwner） | BR-003/NFR-003 |
| Add/Modify | 健壮性 | 畸形 protobuf 400、超体量/批量 4xx、字段截断 | FR-013/BR-006 |
| Add | 子 Agent 树 | 解 `:2368` 门（集合化，与 hermes 共改） | FR-008/009/BR-007/NFR-007 |
| Add | agent 注册 | 桥接携带标记，复用框架无关注册 | FR-010/BR-008 |
| Reuse | Skill 解析 | 桥接为扁平 toolCall 形状，抽取器/getAdapter 零改动 + golden | FR-011/BR-009 |
| Modify | 接入引导 | openclaw 双模式 + 互斥声明 + listFrameworks 单一出处 | FR-006/BR-012/NFR-005 |
| Reuse | 评测承接 | 主/子 Agent 随 Execution 入库自动承接 | FR-015 |
| Modify | 不支持传输反馈 | gRPC 维持拒绝；指引更新（protobuf 已支持） | FR-014 |
| Add | 可自检 | 受理侧 + 处理侧（含 unattributed 丢弃）双处结构化日志 | NFR-006 |

## §3 Technical Design

### 3.1 Tech Stack

- **Backend**: Next.js 16.1.4（App Router）, Node.js 22.17.1（**WSL/nvm，测试必须在此环境**）, TypeScript 5.x
- **DB/ORM**: Prisma 5.22 + SQLite（本期零迁移）
- **Telemetry**: OTLP/HTTP（`application/json` 既有 + `application/x-protobuf` 本期新增）；解码选型候选 `@opentelemetry/otlp-transformer` / `protobufjs`（均在 `@opentelemetry/sdk-node ^0.216.0` 依赖树内，优先复用，避免新增直接依赖版本漂移）
- **Test**: 项目既有 Node test runner + tsx；新增解码/桥接/防线纯函数单测与 golden 用例

### 3.2 Core Decisions（摘自 Phase2，便于排程）

- **D-002 protobuf 解码** = 端点编码分派层适配（框架无关）；选型决定性依据 = traceId/spanId hex 归一正确性（归一错以「不报错、只裂会话/重复」隐蔽击穿 AC-003/004/017）。
- **D-004 双形状桥接** 经已落地 `openclawAdapter.normalizeForStorage`（`:1957` 已调用）；消费者期望形状：skill 链路认扁平 toolCall 块、树链路认 opencode 标记，两边零改动。
- **D-003 归属防线** 在 `otel-consumer/consumer.ts` 两处 save 前，判定复用 `isServiceTraceOwner`（聚合器 `:145` 已兜底 `'anonymous'`，单判 `!user` 会失效）。
- **D-001/D-006** 复用已落地通路 + watcher 并存互斥 + 零 schema 迁移。

### 3.3 Data Model

零 schema 变更。interaction JSON 复用 hermes 设计可选字段（`raw`/`_degraded`/`_truncated`/agent 标记）+ openclaw 双形状容器约束（`responseMessage.content[]` 扁平 toolCall 块）。详见 [Phase2 §5](phase2-requirements-design.md)。

### 3.4 Interface Contracts

- **POST `/v1/traces`**（重写至 `/api/ingest/otel/v1/traces`，薄壳受理）：Header `x-witty-api-key` + `Content-Type: application/json | application/x-protobuf`；Body OTLP `resourceSpans`（要求 `service.name=openclaw`）；错误码 400 畸形/非法 protobuf/缺 resourceSpans、413/400 超体量（解码前）、4xx 超批量+分批提示、gRPC 拒绝+指引。
- 客户端 env：`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`（全路径）/`OTEL_EXPORTER_OTLP_HEADERS="x-witty-api-key=…"`/`OTEL_SERVICE_NAME=openclaw`/`OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`。
- 内部契约（IF-N01~N05、IF-M01/M02、IF-R01~R06）见 [Phase2 §6](phase2-requirements-design.md)。

## §4 Task Breakdown

### 4.1 Upstream Gap Analysis

- **G1 openclaw 两路径真实属性未知（DC-008）**：T001 双形状采样定稿映射/契约；样本前以「标准 GenAI 判定 + 降级保留」先行。（Default Applied，待 T001）
- **G2 插件鉴权头可配置性（DC-009）**：T001 验证；失败走兜底链（平台兼容 Basic 头评估 / 自研兜底）。（Pending，T001 后定）
- **G4 protobuf 解码选型未定**：T004 内对比 spike，决定性依据 = id hex 归一正确性 + 依赖树内复用优先。（Resolved by T004 spike）
- **G5 `:2368` 与 hermes 潜在共改同一行**：约定「先落地者把门限改为 `SUBAGENT_TREE_FRAMEWORKS` 集合判断，后落地者仅加值」；T007 按此实现并在 PR 描述声明。（Resolved by 集合化约定）
- **G6 性能基线**：端点受理继承 spool-consumer 端点基线（≤500 span）；protobuf 解码增量由 F3 实测回填。（Default Applied）
- **G7 onboardModes 协商**：T010 回退 = 引导内输出双模式 + 标注「待 registry descriptor 扩展 `onboardModes?` 后收编」。（Pending，不阻塞）

### 4.2 Task Organization Strategy

**Method**: Hybrid（按架构耦合分组 + 按依赖分层）。

- Wave 0「事实采集」（T001 双形状样本 + DC-009）——阻塞映射/契约/规约三项定稿，不依赖平台 protobuf 支持（用本地 collector 转储），最先行。
- Wave 1「服务端核心」：protobuf 解码（T004，不依赖样本，可与 T001 并行 spike）+ 语义识别/桥接/归属防线（T005/T006，T005 依赖 T001）；构成 MVP。
- Wave 2「下游能力」（解门/adapter/注册评测验证），低耦合可并行。
- Wave 3「接入体验与端到端验收」（引导 + 双路径端到端），依赖前两波。

**MVP Scope**:
- **Phase 1 (MVP)**: 纯配置路径 protobuf 上报 → 解码受理 → 语义识别归并 → 归属防线 → framework=openclaw 入库看板可见（FR-001/002/003/004/013 + NFR-002/003）。
- **Phase 2-3 (Incremental)**: 子 Agent 树/注册/skill 全链路（FR-008~012）、接入引导（FR-006）、客户端规约定稿（FR-007）、评测承接（FR-015）。

### 4.3 需求覆盖矩阵（FR/NFR → Task → AC）

| 需求 | Task | 验收 |
|-|-|-|
| FR-001 端到端接入 | T001 + T004 + T005 + T006 + T011 | AC-001/002 |
| FR-002 protobuf 解码 | **T004** | AC-001/003 |
| FR-003 解析归并 | T005 + 既有聚合 | AC-004 |
| FR-004 framework 标识/变体 | T005（service.name 校验/aliases 归一） | AC-001/018 |
| FR-005 属性映射兜底 | T005（降级保留） | AC-010 |
| FR-006 接入引导 | **T010** | AC-008 |
| FR-007 客户端接入规约 | **T002**（T001 后定稿） | AC-016 |
| FR-008 子 Agent 链路层级 | T005(桥接) + T007 | AC-005 |
| FR-009 子 Agent 多 Execution 树 | **T007** | AC-012 |
| FR-010 agent 自动注册 | T009 | AC-013 |
| FR-011 skill 全链路 | T005(桥接) + T008 + golden 用例 | AC-014 |
| FR-012 语义契约 | T001 + T003（契约文档） | AC-016 |
| FR-013 畸形/超限 | T004(解码前防护) | AC-011 |
| FR-014 gRPC 显式反馈 | T004(分派处维持拒绝+指引更新) | AC-006 |
| FR-015 评测承接 | T009(验证) | AC-015 |
| BR-001 单一框架标识 | T005 + T011(TC-018) | AC-018 |
| BR-003/NFR-003 归属隔离 | **T006(attribution-guard)** | AC-006/009 |
| BR-012 watcher 互斥 | T002/T010(声明) | AC-008 |
| NFR-001 存量零回退 | 各任务 Must-NOT-do + T007(watcher 回归) + F3/F4 | AC-007 |
| NFR-002 幂等容错 | T004(id 归一) + T005(per-span 容错) + 既有 dedupe/upsert | AC-004/017 |
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
Deliverables: 两形状样本入库 docs/design/openclaw-adapter/samples/；规约与契约文档；G2 闭环

Phase 1: 服务端核心链路 (Wave 1, MVP)
Preconditions: T004 可先行 spike；T005 需 T001 样本；T006 仅依赖 consumer 落点（与样本无关）
├── T004: otlp-protobuf-decoder（选型 spike + 解码 + id/AnyValue 归一 + 防护 + 端点编码分派接入） [High]
├── T005: otlp-json 语义条目扩展 + adapters/openclaw.ts normalizeForStorage 桥接 + golden 用例 [High]
└── T006: attribution-guard + 双处日志 + 接线 otel-consumer/consumer.ts 两处 save 前 [Medium]
Deliverables: 纯配置路径 protobuf 端到端入库, 看板出现 framework=openclaw（AC-001/003/011 核心）

Phase 2: 下游能力打通 (Wave 2)
Preconditions: Phase 1 完成
├── T007: 解 :2368 门（集合化）+ sweep 副作用专项用例 + watcher 存量回归 [Medium]
├── T008: adapters/openclaw.ts extractSkills 双形状确认（registry 已落地, 多半零扩展验证） [Low]
└── T009: agent 自动注册与评测承接验证（验证型; T007 完成后启动, 可与 T008 并行） [Low]
Deliverables: 多 Agent 拆多条 Execution + 树（AC-012）、自动注册（AC-013）、skill 全链路（AC-014）、可评测（AC-015）

Phase 3: 接入体验与端到端验收 (Wave 3, T010 可与 Wave 2 并行)
├── T010: setup 交互式+auto 双模式引导 + 互斥声明 + 多副本一致性 [Medium]
└── T011: 双路径端到端集成验收（json/protobuf 等价、归并键回退、双路单一口径） [Medium]
Deliverables: 引导可用（AC-008）、端到端验收通过（AC-001/002/003/017/018）

Phase FINAL: Quality Validation & Delivery (Wave N)
├── F1: Plan Compliance Audit
├── F2: Code Quality Review
├── F3: Real Scenario Manual QA（含性能基线回填）
└── F4: Scope Fidelity Check（冻结区零改动 + 解门符合 G5 集合化约定 + 无临时残留）

Critical Path: T001 →(T003)→ T005 → T007 → T011 → F1-F4  (T003 含于 T001→T005 段, 轻量前置)
Maximum Concurrency: Wave 1 三任务（T004 与 T005/T006 可并行）
```

## §6 Task List

### Phase 0: 事实采集与客户端规约

**Core Objective**: 拿到两条路径真实 OTLP 样本与配置事实，定稿客户端规约与语义契约，解除 G1/G2 阻塞。

**Independent Validation Criteria**:
- [ ] `ls docs/design/openclaw-adapter/samples/*.json` → 至少 2 个样本（纯配置形状 + 插件形状）
- [ ] 规约/契约文档记录 DC-009 验证结论与 service.name 实际缺省值

**Git Commit**: YES — `docs(openclaw): 采集双路径真实样本并定稿客户端接入规约与语义契约`

---

- [ ] T001 双路径真实样本采集 + DC-009 验证 - `docs/design/openclaw-adapter/samples/`
   - **Delegate Subagent**: YES / explorer+tester / Effort: Medium / Parallelism: Wave 0 首任务（T004 spike 可并行）
   - **What to do**:
     + 真实 OpenClaw 环境（参考 langfuse 报告 §4/§5）：①**纯配置路径**——`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 指向本地 OTel collector（`otelcol-contrib` + file/debug exporter，protobuf→json 转储），跑一次含 LLM+工具（理想含多 Agent + skill）任务导出 trace JSON；②**插件路径**——装 aliyun 形态 exporter，endpoint 指向本地 collector 同样导出。
     + 验证 DC-009：插件配置面是否支持自定义 `x-witty-api-key` 头（标准 OTLP headers 透传）；记录结论（成功/失败 + 失败走哪支兜底链）。
     + 记录事实：两路径 `service.name` 实际缺省值（及是否变体）、是否携带 `session.id`、agent 身份属性有无（决定 D-005 能力差异是否触发）、`gen_ai.*`/`gen_ai.span.kind` 实际命名、skill 调用的 span 表示、trace 碎片化程度。
     + 样本（脱敏）入 `docs/design/openclaw-adapter/samples/`，事实清单写采样纪要。
   - **Must NOT do**: 不打生产平台端点（污染数据）；不改 OpenClaw 内核/不 fork 插件；不臆造属性写入契约。
   - **Parallelism**: Can Parallel YES（与 T004 spike）/ Prereq 无 / Blocking T002/T003/T005
  - **Reading List**: [Phase1 §5.2](phase1-requirements-analysis.md)（已内嵌上游三路径调研摘要、OpenClaw OTel/exporter 事实与已知限制）；[Phase2 §2.2.0/§4.2](phase2-requirements-design.md)
   - **Acceptance**: ≥2 JSON 样本 + 1 采样纪要；纪要含 DC-009 结论、service.name 缺省值、agent 身份属性有无、碎片化程度四项事实

---

- [ ] T002 客户端接入规约文档（FR-007） - `docs/design/openclaw-adapter/client-onboarding-spec.md`
   - **Delegate Subagent**: YES / documenter / Effort: Low / Parallelism: T003
   - **What to do**: 按 [Phase2 §2.2.0](phase2-requirements-design.md) 成文：①纯配置 env 规约（含 `TRACES_ENDPOINT` 全路径 vs `ENDPOINT` 自动拼接的 404 差异说明）；②插件复用规约（安装、version-compat 矩阵、endpoint/鉴权，按 T001 的 DC-009 结论写定）；③附录自研插件最小规约（hook→GenAI span→OTLP + 重试/超时/批量/背压/静默失败硬性要求）；④watcher 互斥声明；⑤排障自检清单（受理/处理双处日志、丢弃不可恢复口径、容器网络速查）。写明 D-005 能力差异口径。
   - **Must NOT do**: 不写入未经 T001 证实的属性承诺；不承诺双路去重。
   - **Parallelism**: Can Parallel YES（T003）/ Prereq T001 / Blocking T010
   - **Acceptance**: 5 章节齐备且 DC-009 结论写定；属性约定与 T001 采样一致

---

- [ ] T003 OTLP agent/skill 语义契约文档（FR-012） - `docs/design/openclaw-adapter/otel-semantic-contract.md`
   - **Delegate Subagent**: YES / documenter / Effort: Low / Parallelism: T002
   - **What to do**: 以 [Phase2 §4.2](phase2-requirements-design.md) 契约表为骨架，用 T001 事实把左列（openclaw OTLP 来源）逐行定稿（证实/证伪/缺失三态；缺失写明降级行为）；右列（桥接目标）保持不变；区分纯配置与插件差异列。
   - **Must NOT do**: 不改右列（下游消费者契约，golden 守护）；不留未标注三态的行。
   - **Parallelism**: Can Parallel YES（T002）/ Prereq T001 / Blocking T005
   - **Acceptance**: 契约表每行有三态标注与样本出处（样本文件名+span 名）

---

### Phase 1: 服务端核心链路（MVP）

**Core Objective**: 纯配置路径（protobuf）端到端入库，看板可见 framework=openclaw；json/protobuf 等价；无归属会话不落库。

**Independent Validation Criteria**:
- [ ] 单测全绿：`npx tsx --test src/lib/ingest/claude-otel/__tests__/*.test.ts`（WSL + node 22.17.1）
- [ ] protobuf 样本 POST `/v1/traces` → 200；处理后看板查询返回 framework=openclaw 会话
- [ ] 同一逻辑 trace json/protobuf 双发 → 入库结果字段级一致

**Git Commit**: YES — `feat(ingest): OTLP protobuf 解码 + openclaw 语义识别/双形状桥接 + 消费者侧归属防线`

---

- [ ] T004 otlp-protobuf-decoder（选型 spike + 解码 + 归一 + 防护 + 端点接入） - `src/lib/ingest/claude-otel/otlp-protobuf-decoder.ts`、`src/app/api/ingest/otel/v1/traces/route.ts:22-27`
   - **Delegate Subagent**: YES / coder / Effort: High / Parallelism: T005/T006（不依赖样本；spike 可在 Wave 0 并行）
   - **What to do**:
     + **TDD 先行**：先写失败用例（id 小写 hex、json/protobuf 同 trace deepEqual、非法字节流/超体量/超批量 4xx、AnyValue 各类型归一），再 spike 与实现。
     + **Spike**：对比 `@opentelemetry/otlp-transformer` 与 `protobufjs`+官方 proto——**决定性断言：traceId/spanId 输出小写 hex（非 base64）**；优先复用 `@opentelemetry/sdk-node` 依赖树内版本（锁版本说明）。
     + 实现纯函数 `decodeOtlpProtobuf(rawBytes, limits)`（[Phase2 §4.1](phase2-requirements-design.md) 伪码）：解码前字节上限（默认 8MB）→ 解码（失败→可判定错误，route 映射 400）→ span 批量上限（默认 500，超限→4xx 分批提示）→ id/AnyValue 归一（产物喂给既有 `getOtelAnyValue`/`otelAttrsToObject`）→ 返回与 `JSON.parse` 同构对象，**汇入既有 `normalizeClaudeOtlpTraces`**。
     + route.ts `:22-27`：`application/x-protobuf` 由「415」改为「调 decoder → 汇入既有 json 后续」；gRPC/未知维持拒绝，文案更新为「改用 OTLP/HTTP json 或 protobuf」。
   - **Must NOT do**: 不改 route 编码分派以外逻辑；不触碰 `/v1/logs`、`/v1/metrics`；不引入与依赖树内冲突的直接依赖。
   - **Parallelism**: Can Parallel YES（T005/T006）/ Prereq 无 / Blocking T011
   - **Reading List**: `traces/route.ts:21-39`（现行 Content-Type/parse/normalize）；`claude-otel/otlp-json.ts`（`getOtelAnyValue`/归一汇入点）；OTLP proto trace/v1（id hex 约定）
   - **Recommended Skills**: `verify`（route 接入后起服发包验证）
   - **Acceptance**: 解码单测 PASS（含 id hex 断言）；`curl -X POST /v1/traces -H 'Content-Type: application/x-protobuf' --data-binary @sample.pb` → 200（合法）/400（非法）；同 trace json/protobuf 归一产物 deepEqual
   - **QA Scenario**:
   ```
   Scenario: protobuf 等价性与防护
     Steps: 1.纯配置样本(转 protobuf)上报→200 2.同内容 json 上报→入库比对 3.9MB包/600span包/随机字节流
     Expected: 等价一致; 413/4xx 分批/400, 无部分写入, 无 5xx
     Evidence: .sisyphus/evidence/task-T004-protobuf.txt
   ```

---

- [ ] T005 otlp-json 语义条目扩展 + openclawAdapter.normalizeForStorage 桥接 + golden 用例 - `src/lib/ingest/claude-otel/otlp-json.ts`、`src/lib/ingest/adapters/openclaw.ts`
   - **Delegate Subagent**: YES / coder / Effort: High / Parallelism: T004/T006
   - **What to do**:
     + **TDD/golden 先行**：先写 golden 用例（用 `extractSkillsWithVersionsFromOpenClawSession` 与 `buildAgentCallTree` **原函数**对桥接产物断言，**含 version 断言**）与映射单测（插件/纯配置/降级/infra/无 agent 退化五路径，输入取 T001 样本），再实现。
     + **otlp-json 扩展**（`:155-157`）：新增 `gen_ai.span.kind`(LLM→llm/TOOL→tool/AGENT·ENTRY→agent 边界，记入 attributes 供桥接)；`chat`→llm、`execute_tool`→tool；生命周期 span（`session_start·end`/`gateway_start·stop`/`enter_openclaw_system`）→ infra 跳过；未命中但有效调用 → 保留 + `_degraded`。**仅叠加判定，不改既有 claude/opencode 行为**。
     + **framework 变体归一（W-3）**：在 adapter descriptor 的 `aliases` 登记 T001 证实的变体（如有）；service.name ∉ 已知集合且落 `unknown-service` 的会话由 framework 校验告警（与 attribution 协同丢弃，不静默入库/跳桥接）。
     + **normalizeForStorage 双形状桥接**（`adapters/openclaw.ts`）：嵌套 `tool_calls` → **扁平块 `{type:'toolCall', name, arguments}` 置入 `responseMessage.content[]`**；agent 边界 → opencode 同构标记（`tool_calls[name='task']`/`subagent_type`/`subagent_session_id`/`role`/`agent`）；无 agent 属性 → 单主 Agent 安全退化。**该方法已在 `data-service.ts:1957` 被调用，注册即生效**。
   - **Must NOT do**: **禁止**产出嵌套 `toolCall:{...}` 对象或置于顶层 `content[]`（Phase2 D-004）；不改 interaction-utils/agent-trace/agent-registration/derive/聚合器任何冻结函数；不让建树读 parentSpanId；不臆造 T001 未证实属性键。
   - **Parallelism**: Can Parallel YES（T004/T006）/ Prereq T001/T003 / Blocking T007/T008/T011
   - **Reading List**: `interaction-utils.ts` 的 `extractSkillsWithVersionsFromOpenClawSession`（扁平块容器与 `arguments.version` 读取，右列契约唯一事实）；`openclaw-parser.ts:140-145`（watcher 同款形状）；`agent-trace.ts` buildAgentCallTree（opencode 语义键名）；`claude-otel/otlp-json.ts:155-157`/`traces-aggregator.ts:36-124`（归一与嵌套 tool_calls 产出）；[Phase2 §2.2.2/§4.2](phase2-requirements-design.md)；T003 契约文档
   - **Acceptance**: `npx tsx --test` 相关用例 PASS；golden：原函数抽 invokedSkills 非空含 version；原函数建树结构正确
   - **QA Scenario**:
   ```
   Scenario: 双形状桥接 golden 守护
     Steps: 1.插件形状样本桥接 2.原函数抽 skill(含version)/建树 3.纯配置样本验证退化
     Expected: skill 非空含 version; 树与预期一致; 纯配置无 agent 属性时单主 Agent 不报错
     Evidence: .sisyphus/evidence/task-T005-golden.txt
   ```

---

- [ ] T006 attribution-guard + 双处日志 + 接线 - `src/lib/ingest/claude-otel/attribution-guard.ts` + `src/lib/ingest/otel-consumer/consumer.ts`
   - **Delegate Subagent**: YES / coder / Effort: Medium / Parallelism: T004/T005
   - **What to do**:
     + 谓词纯函数 `guardAttribution({user, taskId, framework, eventCount})` → `{pass} | {drop, reason:'unattributed'}`。**判定（W-2）：`user` 为空 或 `isServiceTraceOwner(user)`（import 自 `data-service.ts:165`，覆盖聚合器 `:145` 兜底的 `'anonymous'` 及 `TRACE_SERVICE_OWNERS`）→ drop**。
     + 接线（W-1/I-2）：在 `otel-consumer/consumer.ts` 的**两处 save 前**（常规 `:202-204` 与 force_judgment 重判 `:225-230`）判定，drop 记结构化日志（会话键/原因/事件数）并**不落库**。建议包成 `saveExecution` 包装器在 `createConsumer` 的 `options.saveExecution`（`:89`）注入处统一拦截，天然覆盖两处。
     + 双处结构化日志：受理侧（route 现有告警增补 `{authResult, contentType, spanTotal, httpCode}`）；处理侧（consumer 记 `{taskId, framework, mappedCount, droppedReason?}`）。
     + 单测：空 user/`anonymous`/服务账号/合法 user 四态；端到端：无 key 上报 → 200 受理但 0 写入 + drop 日志。
   - **Must NOT do**: 不改端点鉴权返回码（强 401 归 spool-consumer 后续轮）；不把 drop 会话写入任何 user（含 anonymous）；不静默丢弃（必须日志）；不漏 force_judgment 重判路径。
   - **Parallelism**: Can Parallel YES（T004/T005）/ Prereq 无（落点已落地）/ Blocking T011
   - **Reading List**: `otel-consumer/consumer.ts:89,202-204,225-230`（save 注入点与两处调用）；`data-service.ts:160-167`（`TRACE_SERVICE_OWNERS`/`isServiceTraceOwner`）；`traces-aggregator.ts:145`（要拦截的 anonymous 兜底）
   - **Acceptance**: 四态单测 PASS；**guard 输入断言取自 `result.record.user`（即 `source.aggregate(sessionId)` 聚合产物，而非端点鉴权期入参），确保对 aggregator `:145` 注入的 `'anonymous'` 字面量端到端拦截**；无 key 端到端 200 + DB 0 新增 + 日志含 `unattributed`；合法 key 归属正确（TC-009 双用户隔离）；force_judgment 路径同样拦截
   - **QA Scenario**:
   ```
   Scenario: 无归属丢弃与隔离
     Steps: 1.无 key 上报 2.用户A/B 各自上报 3.查 DB 与日志(含重判路径)
     Expected: 无 key 0 写入+drop 日志; A/B 互不可见; 无 anonymous 记录
     Evidence: .sisyphus/evidence/task-T006-attribution.txt
   ```

---

### Phase 2: 下游能力打通

**Core Objective**: openclaw OTel 会话获得与 opencode 等价的子 Agent 树/自动注册/skill 全链路/评测承接；watcher 存量零回退。

**Independent Validation Criteria**:
- [ ] 多 Agent 样本入库 → `1+M` 条 Execution、parent/root 链正确、可按 rootExecutionId 聚合
- [ ] watcher 存量回归用例 PASS（解门后行为不变）
- [ ] RegisteredAgent 出现 platform=openclaw 主/子记录且无重复

**Git Commit**: YES — `feat(storage): openclaw 纳入子 Agent 树派生（集合化门限）+ adapter 桥接确认`

---

- [ ] T007 解 :2368 门（集合化）+ sweep 专项用例 + watcher 回归 - `src/lib/storage/data-service.ts:2368`
   - **Delegate Subagent**: YES / coder / Effort: Medium / Parallelism: T008/T009
   - **What to do**:
     + 将 `targetRecord.framework === 'opencode'`（`:2368`）改为 `SUBAGENT_TREE_FRAMEWORKS.has(targetRecord.framework)`（集合常量初值 `{'opencode','openclaw'}`；**若 hermes 线已先集合化，则仅向集合加 `'openclaw'`**——G5，PR 描述声明）。
     + 专项用例①（sweep 副作用）：先入库含子 Agent 的 openclaw 会话 → 再以「缺 agent 标记的同会话全量数据」重聚合 → 断言子 Execution 不被误删（全量聚合语义下树仍可建）；用例②：直接 null 树路径验证 sweep 边界被理解记录。
     + watcher 存量回归：构造 watcher 形状 openclaw 记录过 `saveExecutionRecord` → 断言单 Execution、无子行、无 sweep 误删、行为与解门前一致。
   - **Must NOT do**: 不改 `deriveSubagentExecutions`/`sweepStaleSubagents`/`buildAgentCallTree` 函数体；不改 opencode/claude/hermes 行为；不跳过 watcher 回归。
   - **Parallelism**: Can Parallel YES（T008/T009）/ Prereq T005 / Blocking T011
   - **Reading List**: `data-service.ts:2368,2370,2437,2601`（门限与 sweep 调用链）；[Phase2 §2.2.4/D-004](phase2-requirements-design.md)
   - **Acceptance**: 多 Agent 桥接数据 → 1+M 条 Execution（isSubagent/parent/root 正确）；sweep 专项 + watcher 回归 PASS；`buildAgentCallTree`/`deriveSubagentExecutions` 函数体 git diff 空

---

- [ ] T008 adapters/openclaw.ts extractSkills 双形状确认（registry 已落地，多半零扩展验证） - `src/lib/ingest/adapters/openclaw.ts`
   - **Delegate Subagent**: YES / coder / Effort: Low / Parallelism: T007/T009
   - **What to do**:
     + 确认 `openclawAdapter.extractSkills`（已指向 `extractSkillsWithVersionsFromOpenClawSession`）对 T005 桥接产物**直通**（golden 已证）；`getAdapter('openclaw').extractSkills` 经 `data-service.ts:650-653` dispatcher 自动命中（**无需新增任何分支**）。
     + 若 T005 把桥接逻辑放在 `normalizeForStorage`，本任务确认 `extractSkills` 与 `normalizeForStorage` 在 adapter 内职责清晰、不重复变换；子 Agent 加载的 skill 经桥接 agent 标记归属到对应节点。
   - **Must NOT do**: 不在 dispatcher 新增分支（已无裸分支）；不复制抽取函数（单一实现）；不另建框架清单。
   - **Parallelism**: Can Parallel YES（T007/T009）/ Prereq T005 / Blocking T011
   - **Reading List**: `adapters/openclaw.ts`、`adapters/registry.ts`、`data-service.ts:650-653`；[framework-adapter-registry phase2](../framework-adapter-registry/phase2-requirements-design.md)
   - **Acceptance**: OTel 入库会话 invokedSkills 非空（含子 Agent 加载 skill 与版本）；dispatcher git diff 空（无新增分支）

---

- [ ] T009 agent 自动注册与评测承接验证（验证型） - 无新增代码（`agent-registration.ts` 复用验证）
   - **Delegate Subagent**: YES / tester / Effort: Low / Parallelism: T008（T007 完成后启动）
   - **What to do**:
     + 验证：openclaw OTel 主/子 Agent 首次入库 → RegisteredAgent 出现 platform=openclaw（main/subagent 区分正确）；重复上报无重复（(platform,name,user) 去重）。
     + 验证：入库 Execution（主与子）在「从 Trace」评测入口可检索/选中/发起评测（FR-015/AC-015）。
     + 若注册未生效，**先查 T005 桥接标记**（`agent/subagent_name/role`）而非改注册函数；确需改仅泛化 role 判定并保持框架无关，单独评审。
   - **Must NOT do**: 默认不改 `agent-registration.ts`；不为 openclaw 加专属注册分支。
   - **Parallelism**: Can Parallel 部分（T007 完成后；与 T008 并行）/ Prereq T005/T007 / Blocking T011
   - **Reading List**: `agent-registration.ts` + `data-service.ts`（extractObservedAgentRegistrations 调用与 RegisteredAgent upsert）
   - **Acceptance**: 首次上报后 RegisteredAgent 含 main+subagent；重复上报行数不变；主/子可发起评测

---

### Phase 3: 接入体验与端到端验收

**Core Objective**: 用户可经引导自助完成双模式接入；双路径端到端验收通过。

**Independent Validation Criteria**:
- [ ] 引导输出两种 OTel 配置块 + 互斥声明；watcher 模式保留
- [ ] TC-001/002/003/004/017/018 端到端通过

**Git Commit**: YES — `feat(setup): openclaw 双模式接入引导 + OTel 端到端验收用例`

---

- [ ] T010 setup 双模式引导 + 互斥声明 + 多副本一致性 - `src/app/api/ingest/setup/route.ts`、`setup/auto/route.ts:109+`
   - **Delegate Subagent**: YES / coder / Effort: Medium / Parallelism: 与 Wave 2 并行
   - **What to do**:
     + 交互式 `route.ts` 新增 openclaw 选项（当前缺失）；`auto/route.ts` 在既有 watcher 项（`:109`）基础上增加 otel 模式分支（保留 watcher 下载逻辑不动）。
     + otel 模式输出 T002 规约中的可复制配置块（纯配置 env 块 / 插件安装块），均嵌互斥声明（BR-012）。
     + 配置块抽共享常量/模板，bash+PS × setup+auto 多副本一致性核验（脚本断言或对照测试）。
     + 框架清单：协商 G7 闭环则读 `listFrameworks()` 的 `onboardModes`；未闭环则引导内输出双模式 + `TODO(待 registry descriptor 扩展 onboardModes 后收编)` 标注。
   - **Must NOT do**: 不移除/改动 watcher 模式既有行为；不另建第二份框架清单常量；不输出未含互斥声明的 OTel 配置块。
   - **Parallelism**: Can Parallel YES（Wave 2）/ Prereq T002 / Blocking T011
   - **Reading List**: `setup/auto/route.ts:106-110,185+,244-246`（既有框架枚举与 watcher 下载）；[hermes-otel-adapter phase3](../hermes-otel-adapter/phase3-development-plan.md) T005（同类多副本一致性）
   - **Acceptance**: 交互式与 auto 均出现 openclaw 双模式；配置块与 T002 规约一致含互斥声明；多副本一致性断言通过

---

- [ ] T011 双路径端到端集成验收 - `src/lib/ingest/claude-otel/__tests__/openclaw-e2e.test.ts` + 人工演练记录
   - **Delegate Subagent**: YES / tester / Effort: Medium / Parallelism: 无（收口）
   - **What to do**:
     + 按 [Phase1 §4.2](phase1-requirements-analysis.md) 执行并自动化（可自动化部分）：TC-001（纯配置 protobuf 端到端）、TC-002（插件路径端到端）、TC-003（json/protobuf 等价）、TC-004（分批幂等）、TC-017（归并键回退三组）、TC-018（watcher+OTel 双路单一 framework 口径）。
     + 真实环境演练 TC-016（按 T002 规约冷启动两路径），记录证据。
   - **Must NOT do**: 不跳过 protobuf 路径只测 json；不用构造样本替代 T001 真实样本做 TC-001/002。
   - **Parallelism**: Can Parallel NO / Prereq T004~T010 / Blocking F1-F4
   - **Acceptance**: TC-001/002/003/004/017/018 全 PASS（自动化输出 + 演练记录）

---

## §7 Phase FINAL: Quality Validation & Delivery

**Objective**: 确保所有功能满足需求、代码质量达标、系统可交付。

**Validation Criteria**:
- [ ] Phase1 §4.1 全部 18 条 AC 通过
- [ ] 代码质量检查通过（lint/type/test，WSL + node 22.17.1）
- [ ] 真实场景人工验收通过（含性能基线回填）
- [ ] 用户明确批准交付

---

- [ ] F1 Plan Compliance Audit
   - **Validation Content**: 实现满足 §4.3 覆盖矩阵全部需求；T001~T011 交付物齐备
   - **Output Format**: `Must Have [N/N] / Must NOT Have [N/N] / Requirement Coverage [15 FR + 8 NFR] / Evidence [N/N] / VERDICT`
   - **Parallelism**: Can Parallel YES / Prereq All functional Phases

- [ ] F2 Code Quality Review
   - **Validation Content**: lint / type check / 全部单测与 golden 用例
   - **Output Format**: `Lint / Type / Tests / Code Smells / VERDICT`
   - **Parallelism**: Can Parallel YES / Prereq All functional Phases

- [ ] F3 Real Scenario Manual QA
   - **Validation Content**: Phase1 §2.1 主成功/备选/异常场景全表核验（含 S-017 互斥、S-018 版本矩阵文档性验收）；边界（空 body、9MB 包、600 span、非法 protobuf、无 key、缺 session.id）；**性能基线回填**（端点受理 P99 json/protobuf 各测、解码增量，回填 [Phase2 §7.2](phase2-requirements-design.md)）
   - **Output Format**: `Scenarios [N/N] / Edge Cases [N] / Perf Baseline [P99 json=Nms / protobuf=Nms] / VERDICT`
   - **Parallelism**: Can Parallel YES / Prereq All functional Phases

- [ ] F4 Scope Fidelity Check
   - **Validation Content**: git diff 不超出 §2.3 授权范围；🔴 Protected/⚪ Not Involved 零改动（watcher 链路、冻结函数、聚合器、schema、logs/metrics、opencode/claude/hermes 分支）；`:2368` 改动符合 G5 集合化约定；无遗留 `TODO(待收编)` 残留（G7 闭环则收编）
   - **Output Format**: `Authorized Changes [N/N] / Unauthorized [N] / Scope Creep [CLEAN/N] / VERDICT`
   - **Parallelism**: Can Parallel YES / Prereq All functional Phases

## §8 Appendix

### 8.1 Development Strategies

- **Delegate Tasks**: 任务执行委派 sub-agent，防主 Agent 上下文膨胀。
- **Multi-Agent**: Wave 1 同发 T004/T005/T006；Wave 2 先同发 T007/T008，T007 完成后派 T009。
- **TDD**: 每任务先定义测试清单再写实现；golden 用例（原函数断言，含 version）在桥接实现前先行编写。
- **协商先行**: G5（`:2368` 集合化）在 T007 与 hermes 线对齐；G7（`onboardModes`）异步，回退兜底。

### 8.2 Risk List

| Risk | Impact | Mitigation |
|------|------|----------|
| T001 显示纯配置路径无 agent 身份属性 | Medium（FR-009 主路径退化） | D-005 能力差异口径：引导/规约明示完整能力走插件路径；不阻塞 MVP |
| DC-009 鉴权头假设证伪 | Medium（插件路径受阻） | 兜底链：平台兼容 Basic 头评估 / 自研兜底规约 |
| 解码库 id 输出 base64（选型不当） | High（隐蔽裂会话/重复） | T004 spike 决定性断言 + json/protobuf 等价 golden 双层守护 |
| guard 漏判 `'anonymous'` 字面量（聚合器 :145 兜底） | High（NFR-003 失效） | 复用 `isServiceTraceOwner`（W-2）；四态单测含 anonymous |
| service.name 变体静默跳过桥接 | Medium（数据无 skill/树） | aliases 归一 + framework 校验告警（W-3）；T001 确认实际缺省值 |
| sweep 误删子 Execution | Medium | 按会话全量聚合 + T007 专项用例 |
| `:2368` 与 hermes 共改冲突 | Medium（合并返工） | G5 集合化约定 + PR 描述声明 + F4 核验 |
| watcher 双开重复呈现 | Low（已知限制） | 互斥声明双处输出；不做去重 |

### 8.3 Coding Notes

- **测试环境**：必须在 WSL（Ubuntu-22.04）+ nvm node 22.17.1 下运行测试（Windows 侧 node 因 esbuild 二进制失败）。
- 纯函数模块（decoder/桥接/guard）禁止 DB I/O 与日志副作用（计数走返回值），保证可单测。
- 错误响应确定性（同输入同状态码），4xx 文案含可操作指引（改用编码/分批/检查 key）。
- 新增可选 interaction 字段须旧消费者忽略安全（向后兼容）；禁改既有字段语义。
- `:2368` 改动单独小提交便于与 hermes 线合并。

### 8.4 评审与变更记录

| 版本 | 内容 |
|-|-|
| v0.1 | Phase3 初稿：4 Wave + FINAL、11 任务、G1~G7 缺口分析、需求覆盖矩阵 |
| v0.2 | 评审修订（条件通过 87/100，0 ERROR）：关键路径统一、并行标注修正、锚点更正、TDD/golden 前置 |
| **v0.3** | **基于 v0.2 重生成 + 现状刷新（master 5976cbb）**：①目录迁 `openclaw-adapter`，samples/契约/规约路径更新；②任务按已落地架构重写——T005 落点改 `claude-otel/otlp-json.ts` 扩展 + `adapters/openclaw.ts::normalizeForStorage` 桥接（删 v0.2 的 `src/lib/ingest/otel/` 建骨架）；T006 接线明确到 `otel-consumer/consumer.ts:202-204/225-230` 两处 save + 复用 `isServiceTraceOwner`；T008 降为「registry 已落地的零扩展确认」（删 dispatcher 回退分支）；③删除全部「跨线未落地/回退条款」（spool/registry 已落地）；④解门锚点 `:2155→:2368`、集合化 G5 保留；⑤§8.2 风险表补 W-2/W-3 对应项。**Phase3 评审通过 92/100（0 ERROR），已按 W-A（关键路径补注 T003 前置）、W-B（T006 Acceptance 增 `result.record.user` 输入断言）微调** |
