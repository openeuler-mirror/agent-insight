# 质量监控（Quality Monitoring）模块 — 开发计划（SDD）

版本：1.1
最后更新：2026-06-05

## 导读（内容摘要）

> 本节把这篇开发计划的实质内容浓缩成一页，工程师读完即可掌握"拆成哪些任务、什么顺序、怎么验收"，无需通读全文。

**任务拆解（3 波 + 收尾，共 15 个开发任务 + 4 个验收任务）**：

- **Wave 1 后端引擎与只读接口（T001–T007）**：
  T001 引擎类型与配置常量 → T002 `trace-collector`(圈定 T + join TrajectoryEvalResult + 解析 JSON) → **T003 四维评分/综合分/绝对状态、T004 趋势自适应分桶、T005 问题汇总双源合并**(三者可在 T002 后并行) → T006 编排 `buildQualityReport`(序：collect→problem→score→trend) → T007 三个只读 API。产出：`/api/quality/{agents,report,executions}` 可返回真实数据，`test/quality-monitoring-*.test.ts` 全绿。
- **Wave 2 前端页（T008–T013，依赖 Wave1 接口）**：
  T008 i18n → T009 页重写+配置区(选 Agent/时间/过滤+取数) → T010 汇总条+四卡 → T011 多维趋势图(recharts) → T012 问题汇总面板+执行记录表 → T013 `/fault?executionId` 下钻(加性)。
- **Wave 3 采样异步回填（T014–T015，与 Wave2 并行）**：
  T014 `sampling`(选样+`withBackgroundOpencodeSlot`限流+评测+写回 DB) → T015 后台触发入口 `POST /api/quality/backfill`。
- **Phase FINAL（F1–F4）**：合规审计 / 代码质量 / 人工 QA / 范围保真，四道验收闸。
- **关键路径**：T001→T002→T003→T006→T007→T009→T012→F1–F4。

**MVP 范围** = FR-001~010 全部 P0；过程维细分(FR-011/012/013)、问题汇总语义聚类、置信带、基线快照列为第二阶段。

**每个任务都写明**：目标文件路径、做什么 / **禁止做什么**、依赖与并行关系、参考文件、可执行验收（后端 `npm test` 指定测试文件 / `curl` 接口断言；前端 `next build`+`eslint`+人工 QA 场景）。开发遵循 TDD（先写测试再实现）、任务委托 subagent 执行。

**两条铁律**：①测试/编译必须在 **WSL Ubuntu-22.04 + nvm node 22.17.1** 下跑（Windows 侧 node 因 esbuild 失败）；②🔴 保护模块(storage/evaluation/observability/general-agent)与 `prisma/schema.prisma` **禁改**，`/fault` 仅加性改动。技术栈：Next.js 16.1.4 + React 19.2.3 + TS 5.9.3 + Prisma 5.22.0 + recharts ^3.7.0。

## §1 Project Overview

| Information | Content |
|------|------|
| **Project Name** | Agent 质量监控（Quality Monitoring）模块 |
| **Input Sources** | [需求分析规格 v1.1](./quality-monitoring-requirements.md) + [系统设计规格 v1.0](./quality-monitoring-design.md) |
| **Plan Type** | New Feature Development（复用 `/quality` 路由，深度复用现有引擎） |
| **Estimated Effort** | Medium |
| **Parallel Execution** | YES - 3 Waves（Wave1 后端、Wave2 前端、Wave3 采样回填；Wave3 与 Wave2 可并行） |
| **Critical Path** | T001 → T002 → T003 → T006 → T007 → T009 → (T013 →) T012 → F1–F4（T011 与 T012 并行；T012 的下钻 QA 受 T013 门控） |

## §2 Change Scope

### 2.1 Initial Requirements

以单个 Agent 为对象，通过过滤圈定其特定 trace（Execution），对这批 trace 做：①多维度整体趋势/信息汇总；②结果/过程/成本/错误四维评分 + 绝对综合分与状态（**无同类排名/百分位**）；③统一问题汇总（错误事件 + 评测问题），让开发者看到"哪些问题在拖累 agent 运行"，便于修复。复用 `/quality` 路由与现有评测/诊断引擎。

### 2.2 Key Clarifications

- 交付范围演进：仅需求分析 → 系统设计 → 本开发计划。难度 Medium。
- 删除同类排名/百分位：状态判定改为**纯绝对综合分阈值**，横向比较改为"自身历史趋势 + 绝对阈值"。
- 错误聚类扩展为**统一问题汇总（错误+评测双源）**。
- 验证后核心方案（D-001~D-004）：**请求路径只读已持久化值**；结果/过程维**确定性信号打底**；judge/轨迹类指标**采样异步回填**；MVP **不新增 Prisma 模型**；共享引擎**零修改**，仅 `/fault` 页加 `?executionId` 下钻入口。

### 2.3 Module Change Details

| Status | Module | Change Description | Constraints |
|------|------|----------|------|
| 🟢 New | `src/lib/engine/quality-monitoring/` | 领域引擎：types/trace-collector/dimension-scorer/trend-bucketer/problem-summary/sampling/index | 纯聚合函数为主、可单测；请求路径不触发同步重评测 |
| 🟢 New | `src/app/api/quality/{agents,report,executions}/route.ts` | 三个只读 GET 接口 | `resolveUser` 鉴权；强制 `isSubagent:false` + `{user} OR {user:null}`；`force-dynamic` |
| 🟢 New | `src/components/quality/*` | 配置区/汇总条/四卡/趋势图/问题汇总/执行表 | 复用 `AppTopBar`/`StatusBadge`/`Term` + recharts；不新建设计令牌 |
| 🟡 Modified | `src/app/(main)/quality/page.tsx` | 由 `ComingSoon` 占位重写为真实页 | `'use client'`；切 Agent/窗口/过滤全页重算 |
| 🟡 Modified | `src/app/(main)/fault/page.tsx` | 新增读取 `?executionId=` 自动选中 | **仅加性**，不改既有 `?agent=` 行为 |
| 🟡 Modified | `src/locales/{zh,en}.ts` | 新增质量监控文案键 | 仅新增键 |
| 🔴 Protected | `src/lib/storage/{data-service,prisma,db-interface}.ts` | `readRecords`/`listObservedAgentNames`/`prisma` 复用 | 禁止改签名；时间窗过滤经 `findMany` 的 `timestamp` 条件，不改 `ReadRecordFilters` |
| 🔴 Protected | `src/lib/engine/evaluation/*`、`observability/*`、`general-agent/concurrency-limiter.ts` | `judgeAnswer`/`aggregateTrajectoryScore`/`buildFaultPathSteps`/`buildAgentCallTree`/`withBackgroundOpencodeSlot` 复用 | 零修改 |
| ⚪ Not Involved | `prisma/schema.prisma` | MVP 不新增模型 | `QualitySnapshot` 为第二阶段，禁止本期改 schema |

### 2.4 Functional Impact Details

| Change Type | Functional Node | Change Point | Corresponding Requirement |
|----------|----------|--------|----------|
| Add | 配置与范围圈定 | Agent+时间+次级过滤 → T → 全页 | FR-001 |
| Add | 四维评分与综合分/状态 | 确定性打底 + 绝对状态 | FR-002~007, BR-001/004/005/010 |
| Add | 统一问题汇总 | 错误事件 + 评测问题合并、影响度排序、下钻 | FR-008/009/015, BR-012/013 |
| Add | 多维趋势 | 自适应分桶 + 多维折线 + 样本量柱 | FR-010/014, BR-008/009 |
| Add/Modify | 执行记录表 + 下钻 | 执行成行 + 跳 `/fault?executionId` | FR-016, BR-011 |
| Add | 采样异步回填 | 未评测采样子集后台评测写回 | NFR-001 |

## §3 Technical Design

### 3.1 Tech Stack

**Frontend**: Next.js 16.1.4 (App Router) + React 19.2.3 + TypeScript 5.9.3 + recharts ^3.7.0
**Backend**: Next.js Route Handlers + Prisma 5.22.0（SQLite 默认 / OpenGauss 可切）
**Test**: `node --import tsx --test "test/**/*.test.ts"`（**须在 WSL Ubuntu-22.04 + nvm node 22.17.1 下运行**；Windows 侧 node 因 esbuild 失败）；Lint：`eslint`；Build：`next build`

### 3.2 Core Decisions

#### Decision 1: 请求路径只读 + 确定性打底 + 采样异步回填（D-001）
**Rationale**: `answerScore`/`isAnswerCorrect` 仅在 ingest 命中 ground-truth Config 时写入、过程分落在独立 `TrajectoryEvalResult` 表且实时轨迹评测会拉 opencode 子进程；同步评测会击穿 NFR-003 并放大成本。
**Alternative Solutions**: 请求内同步跑 judge/轨迹（否决：时延不可控、成本高）。

#### Decision 2: MVP 不新增 Prisma 模型，趋势内存分桶（D-002）
**Rationale**: 对齐既有 `dashboard/stats` 内存聚合范式（代码库无 Prisma `groupBy`/分位 SQL）；窗口内 records 足以现算趋势。
**Alternative Solutions**: 新增 `QualitySnapshot` 表（推迟到第二阶段，避免过度设计）。

#### Decision 3: 统一问题汇总=双源合并，结构化错误经 trace 重解析（D-003）
**Rationale**: 持久化 `Execution.failures` 是 LLM 自由文本（无 `errorCode/object`），BR-012 结构化三元组只能由 `buildFaultPathSteps()` 重解析原始交互产出；评测问题来自 `failures/skillIssues/SkillIssue/低分维度`。
**Alternative Solutions**: 仅按持久化 `failures` 文本聚类（否决：丢结构、无法派单）。

### 3.3 Data Model

**MVP 零 schema 变更**，读取既有：`Execution`（逐 trace 指标主源）、`TrajectoryEvalResult`（过程维加成，join `executionId`，1:1）、`SkillIssue`（问题汇总评测来源，N:1 → Evaluation）、`Session.interactions`（结构化错误解析源）、`RegisteredAgent`（Agent 选择器富化）。内存 DTO：`TraceLite`/`QualityReport`/`TrendBucket`/`ProblemItem`/`DimScore`（字段级定义见设计规格 §5.2）。

### 3.4 Interface Contracts

- `GET /api/quality/agents` → `{agents:[{name,platform,ownership,traceCount,lastSeen}]}`
- `GET /api/quality/report?agent&window(1d/1w/1m/custom)&from?&to?&skill?&status?` → `QualityReport`
- `GET /api/quality/executions?agent&from&to&bucket?&skill?&page?&pageSize?` → `{records,total}`
- `GET /fault?executionId=`（页面加性）→ 自动选中该 execution，未命中回退既有行为
- 内部：`buildQualityReport`（调用序 collect→problem→score→trend）、`collectTraces`/`scoreDimensions`/`bucketTrends`/`buildProblemSummary`/`sampleAndBackfill`（见设计规格 §6.2）

## §4 Task Breakdown

### 4.1 Upstream Gap Analysis

- **Gap 1 — 校准参数未定值**（权重/状态阈值/采样率/θ_sample/桶数区间/SLA_refresh）：以设计规格 §6.3 默认值（v3.1 参考值）落地为可配置常量，集中于 `quality-monitoring/config.ts`。Status: **Default Applied**。
- **Gap 2 — 评测覆盖率真实分布未知**：T002/T003 必须随结果返回逐维 `coverage/n`；先以确定性信号给分，judge/轨迹缺口由 T014 回填。Status: **Resolved**（设计 D-001）。
- **Gap 3 — 时间窗过滤不在 `ReadRecordFilters`**：`collectTraces` 直接用 `prisma.execution.findMany({where:{timestamp:{gte,lte}}})`，不改共享过滤契约。Status: **Resolved**（设计 D-002/§2.1.2）。
- **Gap 4 — `/fault` 当前无 `?executionId` 深链**：T013 加性实现，未命中回退既有 `?agent=`。Status: **Resolved**。
- **Gap 5 — 前端无组件级单测框架**：前端任务以 `next build` + `eslint` + 人工 QA（preview）验收；后端引擎以 `node --test` 验收。Status: **Default Applied**。

### 4.2 Task Organization Strategy

**Organization Method**: Hybrid（按架构分层 + 功能耦合分组）

**Rationale**:
- 后端引擎是一切展示的数据源、且可纯函数单测，**先于**前端落地，作为 Wave1（关键路径起点）。
- 前端页面消费已就绪的只读接口，作为 Wave2。
- 采样异步回填与读路径解耦（D-001），只依赖 Wave1 的引擎/契约，可与 Wave2 **并行**为 Wave3。
- 这样最大化并行同时保证依赖正确：引擎契约（T001）一旦冻结，前端与采样可并行推进。

**MVP Scope**:
- **Phase 1 (MVP)**: T001–T007（后端引擎 + 只读接口）+ T008–T013（前端页与下钻）= 需求 FR-001~FR-010 全量 P0。
- **Phase 2-N (Incremental)**: 过程维子指标 FR-011/012/013、问题汇总语义层 FR-015、置信带 FR-018、用户挫败 FR-017、`QualitySnapshot` 基线 NFR-008（见设计 §8.3）。采样回填（T014/T015）MVP 即上但可后置上线。

## §5 Execution Waves

```text
Phase 1: 后端聚合引擎与只读接口 (Wave 1)
Preconditions: 已读 设计规格 §2/§4/§5/§6；WSL node 22.17.1 测试环境就绪
├── T001: 引擎类型与配置常量 [Low]
├── T002: trace-collector 圈定 T + join + 解析 [Medium]
├── T003: dimension-scorer 四维+综合分+绝对状态 [Medium]
├── T004: trend-bucketer 自适应分桶+桶内聚合 [Medium]
├── T005: problem-summary 双源合并+排序 [High]
├── T006: orchestrator buildQualityReport [Low]
└── T007: api/quality 三路由 [Medium]
Deliverables: /api/quality/{agents,report,executions} 可返回真实数据；test/quality-monitoring*.test.ts 全绿

Phase 2: 前端质量监控页 (Wave 2)  — 依赖 Wave1 接口
Preconditions: T007 完成（接口可用）；T001 契约冻结
├── T008: i18n 文案键 [Low]
├── T009: 页面重写 + ConfigBar + 取数 [Medium]
├── T010: SummaryBar + MethodologyCards 四卡 [Medium]
├── T011: QualityTrendChart 多维趋势 [Medium]
├── T012: ProblemSummaryPanel + ExecutionScoreTable [Medium]
└── T013: fault 页 ?executionId 下钻 [Low]
Deliverables: /quality 页可选 Agent+窗口、看四维/趋势/问题汇总、下钻单条 trace

Phase 3: 采样异步回填 (Wave 3)  — 依赖 Wave1，可与 Wave2 并行
Preconditions: T001 契约冻结、T002/T003 可复用
├── T014: sampling 选样+限流+评测+写回 [Medium]
└── T015: 回填触发入口（手动 endpoint/脚本）+ 覆盖率回报 [Low]
Deliverables: 采样回填后 /report 覆盖率上升；不影响读路径时延

Phase FINAL: Quality Validation & Delivery (Wave N)
Preconditions: All functional Phases completed
├── F1: Plan Compliance Audit
├── F2: Code Quality Review
├── F3: Real Scenario Manual QA
└── F4: Scope Fidelity Check
Deliverables: 通过全部验收，待用户确认

Critical Path: T001 → T002 → T003 → T006 → T007 → T009 → (T013 →) T012 → F1–F4
  注：T013 可与 T008–T012 并行开发，但 T012 的"点行跳 /fault?executionId"下钻验收受 T013 完成门控
Maximum Concurrency: Wave1 内 T003/T004/T005 可在 T002 后并行（3）；Wave2 与 Wave3 跨波并行
```

## §6 Task List

### Phase 1: 后端聚合引擎与只读接口

**Core Objective**: 给定 (agent, window, filters) 在 WSL 测试环境产出 `QualityReport`（四维+绝对综合分+趋势+问题汇总+逐维覆盖率），并由三个只读路由暴露。

**Independent Validation Criteria**:
- [ ] `npm test`（WSL）→ `test/quality-monitoring-*.test.ts` PASS
- [ ] `eslint` → 0 error
- [ ] 本地 `next dev` 后 `curl "http://localhost:3000/api/quality/report?agent=<name>&window=1w"` → 200 + 含 `composite/dimensions/trend/problems/coverage`

**Git Commit**: YES — `feat(quality): backend aggregation engine + read APIs`

**Task List**:

---

- [ ] T001 引擎类型与配置常量 - `src/lib/engine/quality-monitoring/types.ts` + `config.ts`

   - **Delegate Subagent**: YES / coder / Low / 可与（无）并行
   - **What to do**:
     + 定义 `TraceLite`/`QualityReport`/`DimScore`/`TrendBucket`/`ProblemItem`/`QualityReportInput`/`ScoringPolicy`（字段照设计 §5.2）。
     + `config.ts` 集中可配置常量：`weights{P0:0.55,P1:0.30,P2:0.15}`、`status{达标:85,关注:70}`、`sample{rate,budget}`、`thetaSample`、`bucket{min:20,max:40}`、`slaRefreshMs`（默认值取设计 §6.3 参考值，标注"待标定"）。
   - **Must NOT do**: 不改 `prisma/schema.prisma`；不在 types 内写业务逻辑。
   - **Parallelism Info**: Can Parallel NO（其他任务的前置）；Prerequisite 无；Blocking T002–T007、T014。
   - **Reading List**:
     + Type/契约：设计规格 §5.2/§6.2
     + Pattern：`src/lib/engine/evaluation/evaluation-types.ts` — 既有契约文件组织风格
   - **Acceptance Criteria**:
     + [ ] `npx tsc --noEmit`（WSL）→ 该文件无类型错误
   - **QA Scenario**:
   ```
   Scenario: 契约编译
     Tool: tsc
     Steps: 1. 引用 types 写一个 fixture 对象 2. tsc --noEmit
     Expected Result: 编译通过
     Evidence: .sisyphus/evidence/task-T001-types.txt
   ```

---

- [ ] T002 trace-collector：圈定 T + join 轨迹 + 解析 JSON - `src/lib/engine/quality-monitoring/trace-collector.ts`

   - **Delegate Subagent**: YES / coder / Medium / 与 T003/T004/T005 串前（其前置）
   - **What to do**:
     + `collectTraces({user,agent,from,to,filters})`：`prisma.execution.findMany({ where:{ agentName:agent, isSubagent:false, timestamp:{gte:from,lte:to}, OR:[{user},{user:null}], ...(skill?{skill}:{}) }, select:<投影> })`。
     + join `TrajectoryEvalResult`（按 `executionId`）取 `trajectoryScore/dimensionScoresJson`；`JSON.parse` `failures`/`skillIssues`（容错空/非法 → `[]`）。
     + 映射为 `TraceLite[]`，缺失字段保持 `undefined` 不臆造。
   - **Must NOT do**: 不调用 `judgeAnswer`/轨迹评测（只读已落库）；不改 `readRecords`/`ReadRecordFilters`。
   - **Parallelism Info**: Can Parallel NO；Prerequisite T001；Blocking T003/T004/T005/T006。
   - **Reading List**:
     + Pattern：`src/app/api/dashboard/stats/route.ts`（`prisma.execution.findMany` + 时间窗 + 投影 + `Promise.all`）
     + API：`src/lib/storage/prisma.ts`（`prisma`/`prismaRaw` 取用），`src/lib/storage/data-service.ts:listObservedAgentNames`（用户作用域写法）
     + Schema：`prisma/schema.prisma` model `Execution`/`TrajectoryEvalResult`
   - **Acceptance Criteria**:
     + [ ] `npm test`（WSL）→ `test/quality-monitoring-collector.test.ts` PASS（含：仅 root、时间窗内、用户作用域、failures 非法 JSON 容错）
   - **QA Scenario**:
   ```
   Scenario: 圈定 T 正确性
     Tool: node --test
     Preconditions: 种子 5 条 Execution（含 1 子 agent、1 越窗、1 他用户、1 failures 非法 JSON）
     Steps: 1. collectTraces(window=1w) 2. 断言只返回 root+窗口内+本用户
     Expected Result: 命中 2 条、failures 容错为 []
     Evidence: .sisyphus/evidence/task-T002-collector.txt
   ```

---

- [ ] T003 dimension-scorer：四维 + 综合分 + 绝对状态 - `src/lib/engine/quality-monitoring/dimension-scorer.ts`

   - **Delegate Subagent**: YES / coder / Medium / 与 T004/T005 并行
   - **What to do**:
     + 逐 trace 指标向量：结果（确定性 `isSuccess(isAnswerCorrect,toolCallErrorCount,failures空?)` 主路径 + `answerScore` 加成 + 安全命中=0）、过程（工具错误率/步数确定性 + `trajectory.dims` 加成）、成本（tokens/cost/latency/steps）。
     + 聚合：占比型**N/A 不入分母**（BR-005）；综合分 `w0*P0均+w1*P1均+w2*P2均`；任一 P0 硬阈值命中 → `capped=true` 封顶降级；**绝对阈值**定 `status`（达标/关注/异常，**无百分位**）；每维返回 `coverage/n`。
   - **Must NOT do**: 不引入任何百分位/cohort；不在此跑 judge。
   - **Parallelism Info**: Can Parallel YES（与 T004/T005）；Prerequisite T002；Blocking T006。
   - **Reading List**:
     + Pattern：`src/app/api/dashboard/stats/route.ts:isSuccess`（确定性成功口径）、`src/lib/skill-analysis/ab-scoring.ts:gradeFor/capabilityScore`（评分/分档风格）
     + Type：`src/lib/engine/evaluation/trajectory-evaluator.ts:aggregateTrajectoryScore`（过程维加成口径，复用不改）
   - **Acceptance Criteria**:
     + [ ] `npm test`（WSL）→ `test/quality-monitoring-scorer.test.ts` PASS
   - **QA Scenario**:
   ```
   Scenario: 蒙对/白忙/安全/空样本
     Tool: node --test
     Steps: 1. 构造蒙对(结果≈1过程低)、白忙(过程高结果0)、PII命中、空T
     Expected Result: 结果/过程分各自如实；PII→安全0且 capped=true 状态异常；空T→coverage=0 不报错
     Evidence: .sisyphus/evidence/task-T003-scorer.txt
   ```

---

- [ ] T004 trend-bucketer：自适应分桶 + 桶内聚合 - `src/lib/engine/quality-monitoring/trend-bucketer.ts`

   - **Delegate Subagent**: YES / coder / Medium / 与 T003/T005 并行
   - **What to do**:
     + `pickGranularity(window)` 使桶数 ∈ `[bucket.min,bucket.max]`（1w→按天=7、1d→按小时=24、custom→自动）。
     + 桶内：二值/分类型算比率(0–100)；连续量算 `p50/p90/p95`；附 `n_traces`；分骤降/错误尖峰 `anomaly=true`。
   - **Must NOT do**: 不直接连线单条 trace；不对空桶臆造数据（保留 n=0）。
   - **Parallelism Info**: Can Parallel YES；Prerequisite T002；Blocking T006。
   - **Reading List**:
     + Pattern：`src/app/api/dashboard/stats/route.ts`（7 日分桶 + 手写 p95）
   - **Acceptance Criteria**:
     + [ ] `npm test`（WSL）→ `test/quality-monitoring-bucketer.test.ts` PASS（1w→7 桶、1d→24 桶、p50/p90/p95 数值、稀疏桶 n 标注）
   - **QA Scenario**:
   ```
   Scenario: 桶粒度自适应与分位
     Tool: node --test
     Steps: 1. 充足样本跑 1w 与 1d
     Expected Result: 恰 7 / 恰 24 桶；连续量含 p50/p90/p95；每桶有 n_traces
     Evidence: .sisyphus/evidence/task-T004-bucketer.txt
   ```

---

- [ ] T005 problem-summary：双源合并 + 影响度排序 - `src/lib/engine/quality-monitoring/problem-summary.ts`

   - **Delegate Subagent**: YES / coder / High / 与 T003/T004 并行
   - **What to do**:
     + 来源A 结构化错误：对每条 trace 取原始 interactions → `buildFaultPathSteps()` 取 `status==='error'` 步 → 键 `(kind/节点 × 错误码 × 对象)` 分组。
     + 来源B 评测问题：`TraceLite.failures/skillIssues` + `SkillIssue` 表（`severity/summary/suggestedFix/category/dimension`）+ 低分/失败维度。
     + 规范化为 `ProblemItem`，跨源去重（dedupKey=类目/节点+规范化摘要），`impact=频次×严重度/受影响维度` 排序，输出帕累托（累计占比）+ 归因标签。
   - **Must NOT do**: 不把 `failures` 自由文本当结构化三元组（结构化只能来自 fault-path）；不重建单条诊断（联动跳转，BR-011）。
   - **Parallelism Info**: Can Parallel YES；Prerequisite T002（+按需取 interactions）；Blocking T006。
   - **Reading List**:
     + API：`src/lib/engine/observability/fault-path.ts:buildFaultPathSteps`、`agent-trace.ts:buildAgentCallTree`（复用不改）
     + Type：`prisma/schema.prisma` model `SkillIssue`；`src/lib/engine/evaluation/judge.ts` `FailureItem`/`SkillImprovementItem`
   - **Acceptance Criteria**:
     + [ ] `npm test`（WSL）→ `test/quality-monitoring-problems.test.ts` PASS（双源合并、同键去重、影响度排序、空源→空清单）
   - **QA Scenario**:
   ```
   Scenario: 双源合并与排序
     Tool: node --test
     Steps: 1. 构造含结构化错误 + skillIssue + 低分维度的 T
     Expected Result: 合并去重、按影响度降序、每项含来源/影响维度/频次/严重度/归因/关联trace
     Evidence: .sisyphus/evidence/task-T005-problems.txt
   ```

---

- [ ] T006 orchestrator：buildQualityReport - `src/lib/engine/quality-monitoring/index.ts`

   - **Delegate Subagent**: YES / coder / Low / 与（无）并行
   - **What to do**:
     + `buildQualityReport(input)` 按序：`collectTraces` → `buildProblemSummary`（先于错误维）→ `scoreDimensions`（消费问题汇总产出错误维）→ `bucketTrends` → 组装 `QualityReport`（含 `coverage`/`meta`）。
     + T 为空 → 返回空状态结构（不抛错）。
   - **Must NOT do**: 不在此触发采样/回填（解耦，T014 独立）。
   - **Parallelism Info**: Can Parallel NO；Prerequisite T002/T003/T004/T005；Blocking T007。
   - **Acceptance Criteria**:
     + [ ] `npm test`（WSL）→ `test/quality-monitoring-report.test.ts` PASS（端到端 report 形状 + 空 T）
   - **QA Scenario**:
   ```
   Scenario: 端到端报告
     Tool: node --test
     Steps: 1. 种子 T 跑 buildQualityReport
     Expected Result: 含 composite/dimensions/trend/problems/coverage/meta；调用序错误维依赖问题汇总成立
     Evidence: .sisyphus/evidence/task-T006-report.txt
   ```

---

- [ ] T007 API 路由：agents / report / executions - `src/app/api/quality/{agents,report,executions}/route.ts`

   - **Delegate Subagent**: YES / coder / Medium / 与（无）并行
   - **What to do**:
     + 三个 `GET` handler：`export const dynamic='force-dynamic'`；`resolveUser(req)` 鉴权；解析 §3.4 参数并校验取值域；`agents` 复用 `listObservedAgentNames` + `RegisteredAgent` 富化；`report` 调 `buildQualityReport`；`executions` 复用 `readRecords`（分页 + 时间窗内存过滤或 bucket 过滤）。
     + 错误返回 `NextResponse.json({error},{status})`。
   - **Must NOT do**: 不在请求内同步跑 judge/轨迹评测；不放宽用户作用域。
   - **Parallelism Info**: Can Parallel NO；Prerequisite T006；Blocking T009。
   - **Reading List**:
     + Pattern：`src/app/api/dashboard/stats/route.ts`（handler 范式、`resolveUser`、`force-dynamic`）
   - **Acceptance Criteria**:
     + [ ] `next dev` 后 `curl ".../api/quality/report?agent=<name>&window=1w"` → 200 + QualityReport
     + [ ] `curl ".../api/quality/agents"` → 200 + `{agents:[…]}`
   - **QA Scenario**:
   ```
   Scenario: 只读接口贯通
     Tool: curl
     Steps: 1. 起 dev 2. 调 /agents /report /executions
     Expected Result: 三接口 200；report 含完整结构；无同步评测导致的长耗时
     Evidence: .sisyphus/evidence/task-T007-api.txt
   ```

---

### Phase 2: 前端质量监控页

**Core Objective**: `/quality` 页可选 Agent + 时间窗 + 次级过滤，呈现汇总条/四卡/多维趋势/统一问题汇总/执行表，并下钻到单条 trace 诊断。

**Independent Validation Criteria**:
- [ ] `next build` → 成功（0 type error）
- [ ] `eslint` → 0 error
- [ ] 人工 QA（Claude Preview / 浏览器）：选 Agent+窗口后四区渲染、切换全页重算、点执行行跳 `/fault?executionId`

**Git Commit**: YES — `feat(quality): quality monitoring page & components`

**Task List**:

---

- [ ] T008 i18n 文案键 - `src/locales/zh.ts` + `src/locales/en.ts`

   - **Delegate Subagent**: YES / coder / Low / 与 T009 并行
   - **What to do**: 新增质量监控页所需键（标题/四维/状态/覆盖率/问题汇总/空状态等），zh/en 对齐；不动既有键。
   - **Must NOT do**: 不重命名既有键。
   - **Parallelism Info**: Can Parallel YES；Prerequisite T001；Blocking T009–T012。
   - **Reading List**: Pattern：`src/locales/zh.ts`（`nav.quality` 既有键位置与风格）
   - **Acceptance Criteria**: [ ] `next build` 无缺键告警；zh/en 键集合一致。

---

- [ ] T009 页面重写 + ConfigBar + 取数 - `src/app/(main)/quality/page.tsx` + `src/components/quality/QualityConfigBar.tsx`

   - **Delegate Subagent**: YES / coder / Medium / 与 T008 并行；前置 T007
   - **What to do**:
     + 移除 `ComingSoon`，`'use client'` 重写：`AppTopBar` + 滚动容器；`QualityConfigBar`（Agent 选择 via `/api/quality/agents`、时间过滤 1d/1w/1m/custom、次级 Skill/状态）。
     + `apiFetch('/api/quality/report?...')` 取数；切 Agent/窗口/过滤 → 重新拉取（全页重算）；loading/空状态（S-011）。
   - **Must NOT do**: 不绕过 `apiFetch`；不在前端重算分数（只渲染后端结果）。
   - **Parallelism Info**: Can Parallel NO（其余 Wave2 组件挂载点）；Prerequisite T007/T008；Blocking T010/T011/T012。
   - **Reading List**: Pattern：`src/app/(main)/fault/page.tsx`（取数+过滤+空态）、`src/app/(main)/dashboard/page.tsx`（FilterSelect/Section）、`src/lib/client/api.ts:apiFetch`
   - **Acceptance Criteria**: [ ] `next build` 通过；[ ] 人工：选 Agent+窗口触发请求并渲染骨架。

---

- [ ] T010 SummaryBar + 四卡 - `src/components/quality/QualitySummaryBar.tsx` + `MethodologyCards.tsx`

   - **Delegate Subagent**: YES / coder / Medium / 与 T011/T012 并行；前置 T009
   - **What to do**: 汇总条（综合分+状态徽章+P0/P1/P2 条+评估次数/达标率/报错数）；四卡（结果/过程/成本/错误，分数+一句诊断+锚点"查看明细"，点锚点滚动/跳到对应区）；复用 `StatusBadge`/`Term`。
   - **Must NOT do**: 不出现任何"排名/百分位/优于xx%"文案。
   - **Parallelism Info**: Can Parallel YES；Prerequisite T009；Blocking F1–F4。
   - **Reading List**: Pattern：`src/components/feedback/StatusBadge.tsx`、`dashboard/page.tsx`（HealthCard/Section）
   - **Acceptance Criteria**: [ ] 人工：四卡分数/诊断/锚点齐全，锚点跳转生效；状态色与设计令牌一致。
   - **QA Scenario**:
   ```
   Scenario: 汇总条与四卡
     Tool: Claude Preview / 浏览器
     Preconditions: 选定有数据的 Agent + 1w
     Steps: 1. 看汇总条(综合分/状态/P0P1P2/计数) 2. 依次点结果/过程/成本/错误四卡锚点
     Expected Result: 综合分与状态徽章渲染；点锚点分别滚动/跳到 执行表/过程区/趋势/问题汇总；无任何"排名/百分位"文案
     Evidence: .sisyphus/evidence/task-T010-cards.txt
   ```

---

- [ ] T011 多维趋势图 - `src/components/quality/QualityTrendChart.tsx`

   - **Delegate Subagent**: YES / coder / Medium / 与 T010/T012 并行；前置 T009
   - **What to do**: recharts 折线（综合/结果/过程/成本可单选或叠加）+ 每桶样本量柱（双轴）；连续量显示分位带；hover tooltip（桶时间·各维·n）；异常桶 marker；**点击桶 → 经 `/api/quality/executions?bucket=` 展开该桶执行记录**。
   - **Must NOT do**: 不连线单桶噪声而不标 n；桶数受 `[min,max]` 约束。
   - **Parallelism Info**: Can Parallel YES；Prerequisite T009；Blocking F1–F4。
   - **Reading List**: Pattern：`src/components/eval/SkillEvaluation.tsx`（recharts LineChart 用法）
   - **Acceptance Criteria**: [ ] 人工：1w→7 点、1d→24 点；维度切换/叠加正常；点桶展开记录。
   - **QA Scenario**:
   ```
   Scenario: 趋势分桶与下钻
     Tool: Claude Preview / 浏览器
     Preconditions: 有充足样本的 Agent
     Steps: 1. 选 1w 看折线点数 2. 切 1d 看点数 3. 单选/叠加维度 4. 点某桶
     Expected Result: 恰 7 / 恰 24 点；每桶有样本量柱；连续量含分位带；点桶经 /executions?bucket= 展开该桶记录
     Evidence: .sisyphus/evidence/task-T011-trend.txt
   ```

---

- [ ] T012 问题汇总面板 + 执行记录表 - `src/components/quality/ProblemSummaryPanel.tsx` + `ExecutionScoreTable.tsx`

   - **Delegate Subagent**: YES / coder / Medium / 与 T010/T011 并行；前置 T009/T013
   - **What to do**: 问题汇总（按影响度排序的列表，含来源/影响维度/频次/严重度/归因/关联trace，帕累托可视化；问题项 ↔ 维度短板互跳）；执行记录表（每次执行成行：综合评分+维度信号+状态+时间，分页 via `/api/quality/executions`），点击行 → `router.push('/fault?executionId='+id)`。
   - **Must NOT do**: 不在面板内重建单条诊断（仅跳转，BR-011）。
   - **Parallelism Info**: Can Parallel YES；Prerequisite T009/T013；Blocking F1–F4。
   - **Reading List**: Pattern：`src/app/(main)/fault/page.tsx`（表格 + 行点击）
   - **Acceptance Criteria**: [ ] 人工：问题清单排序正确、点项下钻；执行表分页 + 点行跳转 fault 并选中。
   - **QA Scenario**:
   ```
   Scenario: 问题汇总排序 + 执行表下钻（受 T013 门控）
     Tool: Claude Preview / 浏览器
     Preconditions: T013 已完成；选定含错误+评测问题的 Agent
     Steps: 1. 看问题清单按影响度降序 2. 点某问题项查看关联 trace 3. 执行表翻页 4. 点某行
     Expected Result: 每项含来源/影响维度/频次/严重度/归因；点项↔维度短板互跳；点行跳 /fault?executionId=ID 并自动选中
     Evidence: .sisyphus/evidence/task-T012-problems-table.txt
   ```

---

- [ ] T013 fault 页 `?executionId` 下钻入口 - `src/app/(main)/fault/page.tsx`

   - **Delegate Subagent**: YES / coder / Low / 与 T008–T012 并行；前置（独立）
   - **What to do**: 页面读取 `searchParams.executionId`，命中则自动选中该 execution 并触发既有诊断流；未命中回退既有 `?agent=`/默认列表并提示。**仅加性**。
   - **Must NOT do**: 不改既有 `?agent=` 行为；不改诊断引擎。
   - **Parallelism Info**: Can Parallel YES；Prerequisite 无；Blocking T012（下钻目标）。
   - **Reading List**: 现有 `fault/page.tsx`（`?agent=` 解析与选中逻辑）
   - **Acceptance Criteria**: [ ] 人工：带 `?executionId=<id>` 打开 `/fault` 自动选中并展示该 trace 诊断；非法 id 回退。

---

### Phase 3: 采样异步回填（与 Wave2 并行）

**Core Objective**: 对未评测的采样子集后台跑 judge/轨迹评测并写回 DB，提升 `/report` 覆盖率，且**不影响只读路径时延**。

**Independent Validation Criteria**:
- [ ] `npm test`（WSL）→ `test/quality-monitoring-sampling.test.ts` PASS（选样/限流/写回，judge mock）
- [ ] 回填后再查 `/report` → 对应维 `coverage` 上升

**Git Commit**: YES — `feat(quality): sampled async evaluation backfill`

**Task List**:

---

- [ ] T014 sampling：选样 + 限流 + 评测 + 写回 - `src/lib/engine/quality-monitoring/sampling.ts`

   - **Delegate Subagent**: YES / coder / Medium / 与 Wave2 并行；前置 T001/T002
   - **What to do**: `sampleAndBackfill({agent,from,to,budget})`：选未评测子集（按 `sample.rate/budget`）→ `withBackgroundOpencodeSlot` 限流 → 调 `judgeAnswer`/轨迹评测 → 写回 `Execution`(answerScore/failures…) 与 `TrajectoryEvalResult`；失败隔离、支持 `AbortSignal`。
   - **Must NOT do**: 不被 `/report` 请求路径同步调用；不改限流器/评测器实现。
   - **Parallelism Info**: Can Parallel YES；Prerequisite T001/T002；Blocking T015。
   - **Reading List**: API：`src/lib/engine/general-agent/concurrency-limiter.ts:withBackgroundOpencodeSlot`、`evaluation/judge.ts:judgeAnswer`
   - **Acceptance Criteria**: [ ] `npm test`（WSL）→ sampling 测试 PASS（judge mock，断言选样数≤预算、写回路径、失败不抛出到调用方）。

---

- [ ] T015 回填触发入口 + 覆盖率回报 - `src/app/api/quality/backfill/route.ts`（POST）

   - **Delegate Subagent**: YES / coder / Low / 前置 T014
   - **What to do**: `POST /api/quality/backfill`（`resolveUser` 鉴权）触发 `sampleAndBackfill`（后台、立即返回任务受理 + 预计覆盖增量）；可选页面"提升覆盖率"按钮调用。
   - **Must NOT do**: 不在 GET `/report` 内触发；不阻塞返回直到评测完成。
   - **Parallelism Info**: Can Parallel NO；Prerequisite T014。
   - **Acceptance Criteria**: [ ] `curl -X POST .../api/quality/backfill?agent=<name>&window=1w` → 202/200 + `{accepted,coverageDelta?}`；随后 `/report` 覆盖率上升。

---

## §7 Phase FINAL: Quality Validation & Delivery

**Objective**: 确保满足需求、代码质量达标、可交付。

**Validation Criteria**:
- [ ] 全部 P0 需求验收（FR-001~010 / AC-001~014）通过
- [ ] `eslint` + `next build` + `npm test`（WSL）通过
- [ ] 真实场景人工测试通过
- [ ] 用户明确同意交付

**Task List**:

---

- [ ] F1 Plan Compliance Audit
   - **Validation Content**: 实现满足全部 P0 需求（对照 §2.4 与设计 §8.1 追溯）
   - **Output Format**:
   ```
   Must Have [N/N Pass]
   Must NOT Have（无排名/百分位、读路径不跑同步评测、schema 未改）[N/N Pass]
   Requirement Coverage [FR-001~010 N/N Implemented]
   Evidence Files [N/N Exist]
   VERDICT: APPROVE / REJECT
   ```
   - **Parallelism Info**: Can Parallel YES；Prerequisite All functional Phases

---

- [ ] F2 Code Quality Review
   - **Output Format**:
   ```
   Lint(eslint): PASS / FAIL
   Type Check(next build / tsc): PASS / FAIL
   Tests(npm test, WSL): N pass / N fail
   Code Smells: N issues
   VERDICT: APPROVE / REJECT
   ```
   - **Parallelism Info**: Can Parallel YES；Prerequisite All functional Phases

---

- [ ] F3 Real Scenario Manual QA
   - **Validation Content**: 主成功场景（选 Agent+窗口→四区→下钻）；边界（空 T、低样本置灰、安全命中降级、1d/1w 桶数）；问题汇总双源排序
   - **Output Format**:
   ```
   Scenarios [N/N pass]
   Edge Cases [空T/低样本/安全命中/桶粒度 N tested]
   Integration(下钻 /fault?executionId) [N/N pass]
   VERDICT: APPROVE / REJECT
   ```
   - **Parallelism Info**: Can Parallel YES；Prerequisite All functional Phases

---

- [ ] F4 Scope Fidelity Check
   - **Validation Content**: `git diff` 是否越界；对照 §2.3；保护模块（storage/evaluation/observability/general-agent）与 `prisma/schema.prisma` 未被改；`/fault` 仅加性
   - **Output Format**:
   ```
   Authorized Changes [N/N files]
   Unauthorized Changes [N files - list paths]
   Protected Untouched (schema/共享引擎) [PASS / FAIL]
   Scope Creep [CLEAN / N issues]
   VERDICT: APPROVE / REJECT
   ```
   - **Parallelism Info**: Can Parallel YES；Prerequisite All functional Phases

## §8 Appendix

### 8.1 Development Strategies

- **Delegate Tasks**: 每个 T 任务委托 subagent 执行，避免主 Agent 上下文膨胀。
- **Multi-Agent**: Wave1 内 T003/T004/T005 在 T002 后并行；Wave2 与 Wave3 跨波并行；一次性派发可并行任务。
- **TDD**: 后端任务先写 `test/quality-monitoring-*.test.ts` 再实现；前端以 `next build`+人工 QA 验收。
- **测试环境**: 所有 `npm test`/`tsc` **必须在 WSL Ubuntu-22.04 + nvm node 22.17.1** 下运行（Windows 侧 node 因 esbuild 失败）。

### 8.2 Risk List

| Risk | Impact | Mitigation Measures |
|------|------|----------|
| 评测覆盖率过低导致结果/过程维空泛 | High | 确定性信号打底 + 逐维覆盖率显式 + T014 采样回填提升 |
| 实时评测误入请求路径击穿 SLA | High | 架构层禁止：`/report` 只读；评测仅在 T014 后台路径；F4 审计 |
| 大 |T| 聚合/解析耗时 | Medium | 投影 select + 并行查询 + 桶数封顶 + 问题解析仅 Top-K 簇 + 超大 T 采样并 log 标注 |
| recharts 多维叠加性能 | Low | 桶数 [min,max] 约束；维度按需渲染 |
| 改 `/fault` 影响既有诊断 | Medium | 仅加性读取 `?executionId`；F4 范围审计；回退既有行为 |

### 8.3 Coding Notes

- 代码风格、目录与命名遵循 `docs/developer-guide/07-conventions-and-extension.md`；UI 用既有设计令牌（`08-design-system.md`/`design-tokens.json`），背景白。
- 边界：空 T → 空状态；样本 < θ_sample → 置灰标置信度；安全命中 → 该 trace 安全=0 且综合分封顶降级标红。
- 权限：所有 `/api/quality/*` 经 `resolveUser` 且查询 `{user} OR {user:null}` 作用域、强制 `isSubagent:false`。
- 异常：`JSON.parse(failures/skillIssues)` 容错；prisma 查询 try/catch → `{error}` + 状态码。
- 严禁：任何"同类排名/百分位/优于xx%"语义；改共享引擎签名；改 `prisma/schema.prisma`。

### 8.4 文档变更

- **v1.1（文档可读性）**：新增「导读（内容摘要）」，将任务拆解(3 波/15+4 任务)、关键路径、MVP 范围、任务要素与两条铁律浓缩成一页；任务内容无变更。
- **v1.0**：依据需求 v1.1 + 设计 v1.0 生成开发计划，经独立 reviewer 评审 Pass 并补充关键路径标注与前端 QA 场景。
