# Agent-insight 项目文档

> Agent 全生命周期的可观测、评估、归因与优化平台。本文档介绍整体架构、各模块功能与全部 API 接口。

---

## 目录

- [一、项目概述](#一项目概述)
- [二、架构总览](#二架构总览)
- [三、目录结构](#三目录结构)
- [四、数据模型](#四数据模型)
- [五、前端模块](#五前端模块)
  - [5.1 页面路由](#51-页面路由)
  - [5.2 公共组件](#52-公共组件)
  - [5.3 工具库 (`src/lib/`)](#53-工具库-srclib)
- [六、API 接口参考](#六api-接口参考)
  - [6.1 `/api/auth/*` — 认证与授权](#61-apiauth--认证与授权)
  - [6.2 `/api/guide` — 用户引导状态](#62-apiguide--用户引导状态)
  - [6.3 `/api/ingest/*` — 数据采集层](#63-apiingest--数据采集层-l1)
  - [6.4 `/api/observe/*` — 观测引擎](#64-apiobserve--观测引擎-l3)
  - [6.5 `/api/eval/*` — 评测引擎](#65-apieval--评测引擎-l3)
  - [6.6 `/api/agent-datasets*` — 评测集](#66-apiagent-datasets--评测集)
  - [6.7 `/api/skill-eval/trigger/*` — Skill 触发评价集](#67-apiskill-evaltrigger--skill-触发评价集)
  - [6.8 `/api/skills/*` — Skills 服务](#68-apiskills--skills-服务-l3)
    - [6.8.5 优化点（SkillIssue）](#685-优化点skillissue)
- [七、数据采集端](#七数据采集端)
- [八、通用 Agent 框架（基于 OpenCode）](#八通用-agent-框架基于-opencode)
  - [8.1 概览与设计动机](#81-概览与设计动机)
  - [8.2 快速开始](#82-快速开始)
  - [8.3 核心 API：`runGeneralAgent`](#83-核心-apirungeneralagent)
  - [8.4 系统 Agent 注册（接入 trace 归属）](#84-系统-agent-注册接入-trace-归属)
  - [8.5 三种调用模式](#85-三种调用模式)
  - [8.6 多用户隔离](#86-多用户隔离)
  - [8.7 文件式 Skill 注入](#87-文件式-skill-注入)
  - [8.8 模型解析优先级](#88-模型解析优先级)
  - [8.9 已知限制与排查](#89-已知限制与排查)
- [九、配置说明](#九配置说明)
- [十、开发与部署](#十开发与部署)
- [十一、相关文档索引](#十一相关文档索引)

---

## 一、项目概述

**Agent-insight**（前身 Skill-insight）是面向 LLM Agent 全生命周期的洞察平台。它对应 AgentOS 内的"运行质量保障"层，要回答三个问题：

1. **Agent 运行得怎么样？**（可观测）
2. **哪里出了问题？**（可诊断）
3. **怎么变得更好？**（可优化）

### 核心能力（四层架构）

| 层 | 目标 | 关键能力 |
|---|---|---|
| **可观测 Observability** | 看得见 | 多 Agent trace 采集（基于 OTel）、调用关系树、Token / 延迟 / 错误率指标 |
| **评估 Evaluation** | 评得准 | 任务完成度、工具调用准确率、Skill 召回率、LLM-as-Judge、回归基线 |
| **归因 Attribution** | 找得到 | 失败用例聚合、流程偏离对比、Skill 缺陷定位 |
| **优化 Optimization** | 改得动 | si-optimizer 自动改写 Skill、benchmark 自动生成、版本对比 |

### 演进路径
- **v1（Skill-insight）**：聚焦 Skill 的生成-评测-优化闭环
- **v2（Agent-insight）**：扩展到 Agent 与多 Agent 协同观测，整体 IA 重构

---

## 二、架构总览

### 数据流

```
┌─────────────────┐    ┌──────────────────┐    ┌───────────────────┐
│ Agent 框架       │───▶│ 采集端 (Plugins)  │───▶│ ingestion API     │
│ • OpenCode      │    │ • opencode_plugin │    │ • /api/upload     │
│ • Claude Code   │    │ • claude_watcher  │    │ • /api/otel/v1/*  │
│ • OpenClaw      │    │ • openclaw_watcher│    │                   │
└─────────────────┘    └──────────────────┘    └─────────┬─────────┘
                                                          │
                                                          ▼
                                         ┌────────────────────────────────┐
                                         │ data-service / judge / parser  │
                                         │ • normalizeInteractions        │
                                         │ • extractSkillsFromSession     │
                                         │ • LLM-as-Judge (judgeAnswer)   │
                                         │ • analyzeFailures              │
                                         └────────────────┬───────────────┘
                                                          │
                                                          ▼
                                                  ┌──────────────┐
                                                  │ Prisma + DB  │
                                                  │ (SQLite /    │
                                                  │  OpenGauss)  │
                                                  └──────┬───────┘
                                                          │
                                                          ▼
                                              ┌────────────────────┐
                                              │ Web UI (Next.js)   │
                                              │ • 链路观测 / 故障  │
                                              │ • 评测 / Skills    │
                                              └────────────────────┘
```

### 技术栈
- **Web**：Next.js 16 + React 19 + TypeScript（App Router）
- **DB**：Prisma 5.22 + SQLite（默认）/ OpenGauss（可选）
- **图表**：Recharts；流程图：Mermaid
- **LLM 调用**：OpenAI SDK（兼容 Claude / DeepSeek 等）
- **采集**：OpenCode 原生 Plugin / Claude Code 日志旁路 / OTel GenAI

---

## 三、目录结构

代码按 [Agent Insight 设计文档](./Agent_Insight_Design_Document.md) §3.1 的 4 层架构分层组织：**采集 → 存储 → 引擎 → UI**。

```
witty-skill-insight/
├── src/
│   ├── app/                         # Next.js App Router
│   │   ├── (main)/                  # 一级路由 + layout（带左侧栏）
│   │   │   ├── modelconfig/{registry,keys,defaults}/
│   │   │   ├── accessconfig/{install,channels,webhooks,health}/
│   │   │   └── ... （trace, eval, metrics, skill-debug, skills, dataset, dataset/[id], ...）
│   │   ├── api/                     # API 路由（auth/guide/ingest/observe/eval/**agent-datasets**/skills）
│   │   ├── details/                 # 旧版执行详情页（仍保留）
│   │   ├── login/
│   │   ├── skill-detail/
│   │   ├── layout.tsx
│   │   └── page.tsx                 # / → /trace 重定向
│   │
│   ├── components/                  # UI 层（按业务模块分组），见 src/components/README.md
│   │   ├── shell/                   # AppSidebar / AppTopBar / providers
│   │   ├── observe/                 # 模块一 链路观测 UI
│   │   ├── eval/                    # 模块二 评测 UI（Dashboard / SingleExecutionMetrics / ...）
│   │   ├── skills/                  # 模块四 Skills UI
│   │   ├── config/                  # 平台配置 UI (ModelConfigManager)
│   │   ├── onboarding/              # 用户引导（首登弹窗）
│   │   └── primitives/              # 通用基础（ComingSoon / LanguageSwitch）
│   │
│   ├── lib/                         # 后端 + 跨层逻辑（按设计文档分层），见 src/lib/README.md
│   │   ├── ingest/                  # 数据采集层（claude/openclaw watcher、proxy、签名路由、上传节流）
│   │   ├── storage/                 # 数据存储层（Prisma、DB 适配、execution 服务、服务端配置）
│   │   ├── engine/
│   │   │   ├── observability/       # 观测引擎（trace/flow 解析、Agent 调用树、衍生指标）
│   │   │   ├── evaluation/          # 评测引擎（LLM-as-Judge、评分项解析、Dataset/Target 配置）
│   │   │   └── skills/              # Skills 服务（注册、版本同步、benchmark 生成）
│   │   ├── auth/                    # 服务端 auth + 客户端 Auth Context
│   │   ├── client/                  # 浏览器辅助（fetch 封装、locale/theme context、引导 hook）
│   │   └── shared/                  # 跨层 pure util / 类型（model-config、interaction-utils）
│   │
│   ├── locales/                     # 中英文 i18n
│   └── prompts/                     # LLM 提示词（被 engine/evaluation 用）
├── prisma/
│   └── schema.prisma                # 10 个表定义
├── scripts/                         # 安装、采集端脚本、数据库迁移
│   ├── opencode_plugin.ts           # OpenCode 原生采集插件
│   ├── opencode_plugin_otel.ts      # OpenCode OTel 模式采集
│   ├── claude_watcher_client.ts     # Claude Code 日志旁路
│   ├── openclaw_watcher_client.ts   # OpenClaw 日志旁路
│   ├── opencode_uploader_client.js  # 本地 JSONL → 平台上传
│   ├── otel_receiver.py             # 本地 OTel 接收器（dev 用）
│   ├── restart.sh / restart_dev.sh  # 服务启停
│   └── init_opengauss.py            # OpenGauss 初始化
├── skills/                          # 内置 Skill 工坊（生成器 / 优化器 / sync）
├── tools/
│   └── otel-local-collector.mjs     # 本地 OTel collector
├── docs/                            # 文档
│   ├── guide/                       # 用户指南（中文 7 篇）
│   ├── plans/                       # 设计与实施记录
│   └── PROJECT.md                   # 本文档
├── public/                          # 静态资源
├── data/                            # SQLite DB / sessions / storage（已 gitignore）
└── tests/ , test/                   # 测试
```

---

## 四、数据模型

Prisma schema 定义了 **27 张表**（`prisma/schema.prisma`）。下表只列与本节业务高度相关的核心表，其余（`PlaygroundSession/Message`、`SkillOptSession/Message/Iteration`、`CustomEvaluatorList`、`DebugHistory`、`BatchEvalTask`、`GrayscaleTask`、`DebugJobResult`、`TrajectoryEvalResult`、`RegisteredAgent`、`FaultDiagnosisSession/Message`）按所属模块单独维护。

| 表 | 用途 | 关键字段 |
|---|---|---|
| `Skill` | Skill 主体 | id, name, category, visibility, activeVersion, isUploaded |
| `SkillVersion` | Skill 版本 | skillId, version, content, changeLog, semanticVersion, enterpriseSkillId |
| `User` | 用户 | username, apiKey |
| `Execution` | 单次 Agent 执行（trace 本体）| taskId, query, framework, model, tokens, latency, cost, isAnswerCorrect, answerScore, failures (JSON), skillIssues (JSON, deprecated), invokedSkills (JSON), skillRecallRate |
| `Session` | OpenCode/Claude 会话 | taskId (unique), label, query, **interactions (JSON)**, model |
| `Config` | **评测用例配置**（LLM-as-Judge / 路由 & outcome） | query, datasetType (combined/routing/outcome), routingIntent, routingAnchors, expectedSkills (JSON), standardAnswer, rootCauses, keyActions, parseStatus（与 Dashboard「config」、`/api/eval/config` 对应） |
| `AgentEvalDataset` | **评测集**（列表 + 数据项） | id, user, name, description, targetAgent, **targetSkill**（服务于哪个 skill，空 = 通用 agent eval；用于行为评测集挂在 skill 上）, **tagsJson**, **casesJson**（每条 case 含 optional `source: 'user' \| 'skill-gen-draft'`）, datasetKind (ideal_output/trajectory), createdAt, updatedAt；由 `/api/agent-datasets*` 与 `src/server/agent_datasets_storage.ts` 读写（**Prisma/SQLite**；非 Prisma 适配器时回退 `data/agent_datasets.json`） |
| `GrayscaleTask` | **A/B 测试任务** | id, user, **skillId**, **skillName**, **skillVersion**, **skillVersionId**（任务强绑定 Skill + B 实验版本，同用户下 skillName + skillVersion 唯一）, taskName, configJson（版本、数据集、评估器等运行配置；其中 skillId/versionBId 必须等于任务绑定对象）, caseStatesJson |
| `SkillTriggerEvalSet` | **触发评价集**（"召回分析"卡数据源） | id, user, skillName（跨版本共享，按 name 挂）, description, **itemsJson**（`[{id, query, shouldTrigger, rationale?, source}]`），draftedFromSkillHash（起草基于的 SKILL.md 内容 hash，便于检测是否需要重新起草）, status (drafting/ready)；唯一约束 (user, skillName)；由 `/api/skill-eval/trigger/*` 与 `src/server/skill_trigger_eval_storage.ts` 读写 |
| `SkillTriggerEvalRun` | **触发评测结果**（每次评测一行） | id, user, skillName, skillVersion, triggerSetId, **resultsJson**（`[{itemId, query, shouldTrigger, runsTriggered, runsTotal, triggerRate, pass, latencyMsAvg, competingSkill?}]`，competingSkill 字段用于"兄弟 skill 抢路由"诊断）, passRate, truePositiveRate, falsePositiveRate, runsPerQuery, triggerThreshold, timeoutMs, durationMs, modelId, workspaceRoot, status (running/done/failed), errorMessage |
| `Evaluation` | **评估事件**（静态/动态统一）| type ('static'\|'dynamic'), skillId, version, executionId (dynamic), contentHash (static), generator, ranAt, status |
| `SkillIssue` | **优化点**（每行一条）| evaluationId (FK), source (denorm), skillId, version, dedupKey, severity (high\|medium\|low), summary, evidence, reasoning, suggestedFix, ruleId |
| `UserSettings` | 用户设置 (评测模型等) | user, settingsJson |
| `ParsedFlow` | Skill 流程解析缓存 | skillId+version, flowJson, mermaidCode |
| `ExecutionMatch` | 执行 vs 静态流程匹配 | executionId, mode, matchJson（含完整 trace 展示用 matches / skippedExpectedSteps / alignment）, staticMermaid, dynamicMermaid, analysisText |
| `UserGuideState` | 用户引导状态 | user, currentStep, completedSteps (JSON), skippedSteps |

`Execution.interactions` 存了多 Agent trace 原始数据，关键字段：`role`, `agent`, `subagent_name`, `subagent_session_id`, `tool_calls[]`, `usage`, `timeInfo`。

### 4.1 Skill 优化点子系统（Evaluation + SkillIssue）

skill-opt 页面的「可优化点列表」由 `Evaluation` + `SkillIssue` 两张表驱动。设计文档：[`docs/plans/2026-05-08-skill-opt-issues-api-design.md`](plans/2026-05-08-skill-opt-issues-api-design.md)。

**两条核心 invariant**：
1. **静态评估和动态评估统一到 `/evaluation/<evaluation_id>`** —— 一张 `Evaluation` 表承载两种类型，`type ∈ {'static', 'dynamic'}` 区分。前端跳转 URL 不分类型。
2. **SkillIssue 通过 FK 链接到 evaluation_id** —— 一张 `SkillIssue` 表，每行 = 一个独立优化点；`evaluationId` 字段 FK 指向产生它的 Evaluation；OptIssue.id = SkillIssue.id（真主键）。

**数据架构图**：

```
                    ┌─────────────────────┐
                    │       Skill         │
                    │  id (PK)            │
                    │  name               │
                    │  user               │
                    └──────────┬──────────┘
                               │ 1:N
                               ▼
                    ┌─────────────────────┐
                    │     SkillVersion    │
                    │  id (PK)            │
                    │  skillId (FK)       │
                    │  version            │
                    │  content            │
                    └──────────┬──────────┘
                               │
              ┌────────────────┴────────────────┐
              │ 1:N                         1:N │ 静态评估（重评懒删除）
              ▼                                 ▼
    ┌─────────────────────┐         ┌──────────────────────────┐
    │    Execution        │  1:N    │       Evaluation         │
    │    (trace 轨迹)      │ ◀─────  │       (评估结果)          │
    │                     │ 动态评估  │                          │
    │  id (PK)            │重评懒删除 │  id (PK)                 │
    │  skill (name)       │多个评估器 │  type ['static'|'dynamic']│
    │  skillVersion       │         │  skillId (FK)            │
    │  user               │         │  version                 │
    │  skillIssues        │         │  executionId (FK) ───────┼─┐ dynamic 时回指
    │  (deprecated)       │         │  contentHash             │ │ Execution
    └─────────────────────┘         │  l2ScoresJson            │◀┘
                                    │  ranAt, status, ...      │
                                    └──────────┬───────────────┘
                                               │ 1:N
                                               ▼
                                    ┌──────────────────────────┐
                                    │       SkillIssue         │
                                    │       (单个优化点)         │
                                    │                          │
                                    │  id (PK)                 │
                                    │  evaluationId (FK)       │
                                    │  source                  │
                                    │   ['static'|'dynamic'|   │
                                    │    'feedback']           │
                                    │  skillId, version        │
                                    │  user                    │
                                    │  dedupKey ←跨 eval       │
                                    │   分组键                  │
                                    │  severity                │
                                    │   [high|medium|low]      │
                                    │  summary                 │
                                    │  evidence                │
                                    │  reasoning               │
                                    │  suggestedFix            │
                                    │  ruleId (static)         │
                                    └─────────────────────────┘
```

**概念分层**：

| 层 | 实体 | 含义 | 示例 |
|---|---|---|---|
| 现象 | `Execution` (现有表) | agent 跑出来的 trace 本体 | `exec_xxx` |
| 判断 | `Evaluation` (新表) | 对某 SkillVersion 的一次评估事件 | `eval_xxx` |
| 优化点 | `SkillIssue` (新表) | 一个独立的待优化项；**也是 API 直接返回的类型** | `iss_xxx` |

**关键关系**：
- `Execution` 是"原始 trace"，**不是评估**
- 动态评估 = `Evaluation(type='dynamic', executionId=Execution.id)` 评估这条 trace（**1 trace : N evaluations**，重评懒删除）
- 静态评估 = `Evaluation(type='static', contentHash=hash(SkillVersion.content))` 评估 SKILL.md 内容（**1 version : N evaluations**，重评懒删除）
- 两种评估**都**产出多个 `SkillIssue`（FK 指回 Evaluation）
- API 返回类型 = `SkillIssue` 直接出，外加一个派生字段 `prevalenceCount`（同 dedupKey 在响应范围内被检出几次）

**Evaluation 表关键字段**：
- `type`：`'static' | 'dynamic'`，区分两种评估
- `executionId`：dynamic 时指向被评估的 trace；static 时为 null
- `contentHash`：static 的 SKILL.md 内容 hash，作"快速查最近一次同 content 评估"的索引线索；**不是 unique 约束**，允许多次重评
- `generator`：评估器自标识（如 `static-linter@0.1` / `judge.ts@1.2` / `mock-seed@2026-05-08`），便于审计与 seed 数据清理
- `l2ScoresJson`：V2 接 LLM 5D 评估时填，形如 `{Role:1-5, Structure:1-5, ...}`

**SkillIssue 表关键字段**：
- `evaluationId`：FK → Evaluation.id；onDelete: Cascade
- `source`：denormalize 自 `Evaluation.type`，避免热路径 join
- `dedupKey`：跨 evaluation 聚合"同一 issue"的语义键
  - static: `ruleId`（如 `frontmatter_missing_name`）
  - dynamic: `hash6(content + explanation)`
- `severity`：`'high' | 'medium' | 'low'`，**与前端 UI 语言一致**，DB 直接用，不引入 Critical/Major/Minor 内部 jargon
- `ruleId` / `dimension`：静态专用元数据，前端可忽略

**API 路径**：

```
GET   /api/skills/by-name/:name/optimization-points?version=N&user=...&includeResolved=1
PATCH /api/skills/by-name/:name/optimization-points/resolve   { user, ids[], threadId? }
POST  /api/skills/by-name/:name/analysis-diagnosis           { user, snapshot }
```

GET 返回 `OptIssue[]`（前端 `_mock.ts` 同构）：内部用 `aggregateSkillIssues()` 聚合 `SkillIssue + Evaluation`，按 severity 排序、按 `prevalenceCount` 在 ≥3/5/10 三档抬升一级 severity（详见 `src/lib/engine/skill-issues/prevalence.ts`）。  
PATCH 把指定 SkillIssue 列表的 `resolvedAt = now` + `resolvedRunId = threadId`，skill-opt 完成一次优化后回调，避免下次列表里再出现同一 issue。

完整接口字段、错误码请参考 [§6.7.5](#675-优化点skillissue)。

**写入侧分工**：
- **静态评估器**（评估器开发者实现）：扫 `SkillVersion.content` → 创建 `Evaluation(type='static')` + N 条 `SkillIssue(source='static')`
- **动态评估器**（`src/lib/engine/evaluation/derive-skill-opt-points.ts`）：trajectory + 任务完成度评测产出之后，按 case 涉及的每个 skill 各起一行 `Evaluation(type='dynamic', executionId=Execution.id, runId=evaluatorRunId, generator='trajectory-evaluator@1.0')`，下挂 N 条 `SkillIssue(source='dynamic')`；hook 点在 `src/app/api/eval/trajectory/run/route.ts`（result-only 与 full-trace 两条路径都触发）
- **本仓库 issues API**（已实现）：聚合层在 `src/lib/engine/skill-issues/index.ts`，单 query 拉所有 SkillIssue + Evaluation 元数据，JS 层按 dedupKey 分组算 prevalence；映射成 `OptIssue` 由 route.ts 中的 `toOptIssue()` 完成

**动态评估优化点的来源（4 大类）**：

| category 来源 | 抽取自 | 关键过滤逻辑 |
|---|---|---|
| `路径偏离` 等 | `deviation_steps[]`（轨迹评估输出） | `is_skill_attributable=false` 跳过；low severity 跳过 |
| `关键动作缺失` 等 | `key_point_findings[]`（任务完成度评估输出，仅 `covered=false`） | 同上 |
| `工具选择问题` | `tool_choice_findings[]` | 同上 |
| `格式偏差` / `多余内容` / `表达问题` / `事实错误` / `结果问题` | `result_issues[]`（任务完成度子评估器输出，按 `kind` 分类） | 同上 |

`kind → category` 映射在 `derive-skill-opt-points.ts` 的 `RESULT_ISSUE_KIND_TO_CATEGORY` 中：`format` / `extra_content` / `verbosity` / `incorrect_fact` / `other` 五种。

**评估器输出 schema 增量字段（snake_case 与 camelCase 兼容）**：
- `is_skill_attributable: boolean` —— 评估器自判：该问题是否可归因到 SKILL.md 修改可解决；`false` 时该条不会写入 SkillIssue（例如「模型本身能力不足」「query 本身不可解」）
- `improvement_suggestion: string` —— 评估器给出的具体改进建议；落库到 `SkillIssue.suggestedFix`，再由 skill-opt agent prompt 拼装成「改进建议（评估器给出，优先按此执行）」字段

**Mock 数据**（dev 启动用）：
- `npm run seed:skill-opt`：注入 3 个 skill（pdf-extractor / doc-summarizer / chart-gen）+ 5 条 issue + 2 条 Evaluation，全部 `source='static'`，归属 `user='skill-insight@huawei.com'`
- `npm run clean:skill-opt`：清掉所有 mock 数据，cascade 带走 SkillVersion / Evaluation / SkillIssue
- `node /tmp/seed-full-loop.mjs`：端到端联调脚本，覆盖 trajectory + key_point + tool_choice + result_issues 四类来源（含 `is_skill_attributable=false` / low severity 过滤的反例）

---

## 五、前端模块

### 5.1 页面路由

按 hifi v5(1) 的 IA，左侧栏分 3 个一级分组、12 个一级页面（部分含子树）：

#### Agent Workspace 分组（一级折叠分组）

| 路由 | 文件 | 功能 |
|---|---|---|
| `/agents` | `app/(main)/agents/page.tsx` | **Agent 管理**（占位）—— Agent 注册、版本、关联 Skill |
| `/skills` | `app/(main)/skills/page.tsx` | **Skills 管理** —— 资产卡片、版本切换（包装 Dashboard `initialTab=skill`） |
| `/skill-history?name=` | `app/(main)/skill-history/page.tsx` | **Skill 执行历史** —— 单个 Skill 的所有执行记录 |
| `/playground` | `app/(main)/playground/page.tsx` | **Playground**（占位）—— 在线编辑/运行 Skill |
| `/skill-debug` | `app/(main)/skill-debug/page.tsx` | **调测分析** —— 带 `?taskId=xxx` 时显示该执行的 Skill 诊断（调用的 Skill / 扣分项 / 评分项与 Skill 关联）；不带参数时显示空态 + 跳转入口（trace / skills） |
| `/skill-debug/grayscale` | `app/(main)/skill-debug/grayscale/page.tsx` | **A/B测试** —— 新建 `GrayscaleTask` 时强绑定一个 Skill + B 实验版本（同用户同 Skill 名称 + 版本号唯一，已保存任务不可改绑），选择 A/B Skill 版本（A 可为无 Skill）、数据集样本、重复轮次、Agent 最大并发数与评估器；后台按“样本 × A/B × 轮次”调度 `runGeneralAgent`，执行阶段受 `agentMaxConcurrency` 限流，全部执行记录完成后再用同一并发上限触发 trajectory 评估器，全部评估完成后再聚合耗时、token、Skill 触发、工具调用、准确率与平均评分 |
| `/skill-release` | `app/(main)/skill-release/page.tsx` | **发布管理**（占位）—— 审批 / 灰度 / 回滚 |
| `/trace` | `app/(main)/trace/page.tsx` | **链路观测** —— 4 个指标卡 + 执行记录表（带筛选/分页）+ 点击行打开右侧 Drawer 查看多 Agent 调用树；行内提供「指标」「调测」一键跳转 |
| `/fault` | `app/(main)/fault/page.tsx` | **故障定位** —— 失败用例列表（按状态/类型筛选）+ 跳转到 details 页查看流程偏离 |
| `/dataset` | `app/(main)/dataset/page.tsx` | **评测集** —— 列表（`AgentDatasetCenter`）：搜索、新建、行内「详情 / 录入数据 / 删除」；**点击行**进入 `/dataset/[id]` |
| `/dataset/[id]` | `app/(main)/dataset/[id]/page.tsx` | **数据项录入** —— `DatasetItemsPage`：维护该评测集下 cases（与 `AgentEvalDataset.casesJson` 同步） |
| `/metrics` | `app/(main)/metrics/page.tsx` | **评估器 / 指标** —— 默认 `EvaluatorsCenter`（评估器与观测数据联动）；带 `?taskId=xxx` 时为单次执行 `SingleExecutionMetrics` |
| `/eval` | `app/(main)/eval/page.tsx` | **评测任务** —— `AgentEvalCenter`（评测任务工作台，对接 `/api/observe/data` + `/api/eval/config`） |
| `/memory` | `app/(main)/memory/page.tsx` | **记忆评估**（占位）—— 工作/语义/情节/个性化记忆 |
| `/quality` | `app/(main)/quality/page.tsx` | **质量监控**（占位）—— 跨版本对比、Quality Gate |
| `/security` | `app/(main)/security/page.tsx` | **安全设计**（占位）—— PII / Prompt 注入 / 策略 |

#### 平台配置（可展开分组，含真实功能）

| 路由 | 文件 | 功能 |
|---|---|---|
| `/modelconfig` | `app/(main)/modelconfig/page.tsx` | **模型配置** 父路由 → 重定向至 `/modelconfig/registry` |
| `/modelconfig/registry` | `app/(main)/modelconfig/registry/page.tsx` | **模型注册** —— 全功能 CRUD：新增/编辑/激活/删除模型配置（沿用 `/api/eval/settings` + `/api/eval/settings/test`） |
| `/modelconfig/keys` | `app/(main)/modelconfig/keys/page.tsx` | **API Key 管理** —— 同一份配置以 Key 视角展示，掩码 + 显示/隐藏 + 复制 |
| `/modelconfig/defaults` | `app/(main)/modelconfig/defaults/page.tsx` | **默认模型设置** —— 单选切换默认（评测/优化）模型 |
| `/accessconfig` | `app/(main)/accessconfig/page.tsx` | **接入配置** 父路由 → 重定向至 `/accessconfig/install` |
| `/accessconfig/install` | `app/(main)/accessconfig/install/page.tsx` | **安装指导** —— 客户端安装命令（Linux/macOS + Windows）+ API Key 一键复制；从首登 UserGuide 抽出 |
| `/accessconfig/channels` | `app/(main)/accessconfig/channels/page.tsx` | **渠道注册**（占位）—— 钉钉 / 企业微信 / Slack / IM / API |
| `/accessconfig/webhooks` | `app/(main)/accessconfig/webhooks/page.tsx` | **Webhook 路由**（占位）—— 签名校验、路由规则、重试限流 |
| `/accessconfig/health` | `app/(main)/accessconfig/health/page.tsx` | **健康检查**（占位）—— 连通性探测、延迟、可用性历史 |

> 模型配置三个子页共享 `src/components/ModelConfigManager.tsx`（`mode='full'|'keys'|'defaults'`），UI 全部使用 v2 设计 token，与 `AppTopBar` / `AppSidebar` 风格一致。

#### 其他独立路由

| 路由 | 用途 |
|---|---|
| `/details?expandTaskId=` | 单次执行的完整详情（含 Agent Trace 段、原始 JSON、流程对比、失败用例） |
| `/skill-detail?id=` | Skill 详情（SkillLink 跳转目标，旧版浏览器） |
| `/login` | 登录 |
| `/optapi` | 自优化 API（v1 留存路由，不在主 IA 中） |

### 5.2 公共组件 (`src/components/`)

按业务模块分组（详见 [src/components/README.md](../src/components/README.md)）。

#### `shell/` — 应用外壳
- **`AppSidebar.tsx`** — 左侧 3 层嵌套树菜单（含分组折叠、自动展开激活路径）
- **`AppTopBar.tsx`** — 页面顶部条（面包屑 + 标题 + 右侧 actions）
- **`providers.tsx`** — 主题 / 语言 / 认证 Provider 嵌套

#### `observe/` — 模块一 链路观测 UI
- **`AgentTraceView.tsx`** — 多 Agent 调用关系树（左树+右详情，事件着色）
- **`TraceDrawer.tsx`** — 右侧滑出抽屉，懒加载 session 并渲染 AgentTraceView

#### `eval/` — 模块二 评测 UI
- **`Dashboard.tsx`** — v1 Dashboard 三 tab（dashboard/config/skill）承载组件；以 `embedded` prop 内嵌（仍用于 skills 等内嵌场景）
- **`SingleExecutionMetrics.tsx`** — 单次执行的指标分解视图（质量/性能 KPI + 评分项）
- **`SkillEvaluation.tsx`** — 评测可视化（独立模态）
- **`ExecutionFlowComparison.tsx`** — 执行流程 vs Skill 静态流程对比（Mermaid 双图）

#### 评测集 / 评估器（根目录组件）
- **`AgentDatasetCenter.tsx`** — 评测集列表与详情弹窗（对接 `/api/agent-datasets`）
- **`DatasetItemsPage.tsx`** — 单评测集数据项编辑（对接 `/api/agent-datasets`、`PATCH` cases）
- **`AgentEvalCenter.tsx`** — 评测任务页主体
- **`EvaluatorsCenter.tsx`** — 评估器页主体（默认 `/metrics`）

#### `skills/` — 模块四 Skills UI
- **`SkillRegistry.tsx`** — Skill 卡片库（上传、版本管理、删除）
- **`SkillDiagnosis.tsx`** — 单次执行的 Skill 诊断（调用 / 扣分项 / 评分关联）
- **`SkillLink.tsx`** — Skill 名跳转链接（路由到 `/skill-detail`）

#### `config/` — 平台配置 UI
- **`ModelConfigManager.tsx`** — 模型配置 CRUD（驱动 `/modelconfig/*` 三个子页）

#### `onboarding/` — 用户引导
- **`UserGuide.tsx`** — 新手引导步骤展示（首登弹窗）

#### `primitives/` — 通用基础
- **`ComingSoon.tsx`** — 占位页统一外观（标题 + tagline + roadmap 卡片）
- **`LanguageSwitch.tsx`** — 中英文切换

### 5.3 后端 / 跨层逻辑 (`src/lib/`)

按 4 层架构分目录（详见 [src/lib/README.md](../src/lib/README.md)）。

#### `ingest/` — 数据采集层 (Layer 1)
- **`claude-watcher.ts`** + **`openclaw-watcher.ts`** — Claude Code / OpenClaw 日志旁路
- **`proxy-config.ts`** + **`proxy-store.ts`** — 代理会话状态
- **`routing-signature.ts`** — 路由意图签名生成
- **`upload-throttle.ts`** + **`upload-analysis-debouncer.ts`** — 上传节流去抖

#### `storage/` — 数据存储层 (Layer 2)
- **`prisma.ts`** — Prisma client + DB 抽象切换（SQLite / OpenGauss）
- **`db-interface.ts`** — DB 操作接口
- **`data-service.ts`** — 执行记录核心 CRUD：`readRecords()`, `saveExecutionRecord()`, `findExecutionById()` 等
- **`server-config.ts`** — 服务端配置加载

#### `server/` — 与 Prisma 并行的服务端模块
- **`agent_datasets_storage.ts`** — 评测集持久化：`AgentEvalDataset` 表（Prisma）或 legacy `data/agent_datasets.json`（非 Prisma `getClient()` 时）

#### `engine/observability/` — 观测引擎 (模块一)
- **`agent-trace.ts`** — interaction 序列 → 多 Agent 调用树（与 OTel GenAI 概念对齐）
- **`flow-parser.ts`** — Skill 内容 → 流程图 JSON / Mermaid
- **`claude-parser.ts`** / **`openclaw-parser.ts`** — 各采集端 session 解析
- **`opencode-derived-metrics.ts`** — 从 OpenCode session 派生 token / latency / cache 等
- **`session-interactions-merge.ts`** — 多源 interaction 合并去重
- **`subagent-inference.ts`** — 从 task tool call 推断 subagent_name / subagent_session_id

#### `engine/evaluation/` — 评测引擎 (模块二)
- **`judge.ts`** — LLM-as-Judge 主流程：`judgeAnswer()`, `analyzeFailures()`, `extractSkillsFromClaudeSession()`, `normalizeInteractions()`
- **`evaluation-types.ts`** — 评测结果类型
- **`evaluation-parser.ts`** — `judgment_reason` → RC/KA 评分项解析
- **`config-dataset.ts`** + **`config-target.ts`** — 数据集 / 路由签名规则
- **`label-skill-binding.ts`** + **`label-utils.ts`** — 标签绑定工具

#### `engine/skills/` — Skills 服务 (模块四)
- **`skill-service.ts`** — Skill / SkillVersion 增删改查
- **`skill-sync-service.ts`** + **`skill-sync-types.ts`** — 企业 Skill 同步（双向）
- **`skill-benchmark-generator.ts`** — 自动生成 benchmark 用例
- **`skill-types.ts`** — Skill 相关类型定义

#### `auth/` — 鉴权（跨层）
- **`auth.ts`** — 服务端 auth helper（API key 校验等）
- **`auth-context.tsx`** — 客户端 React Auth Context

#### `client/` — 浏览器辅助 (UI 层)
- **`api.ts`** — 前端统一 fetch wrapper（追加 base path / API key）
- **`locale-context.tsx`** / **`theme-context.tsx`** — 语言 / 主题上下文
- **`use-user-guide.ts`** + **`guide-config.ts`** — 用户引导状态机

#### 根目录类型（与 UI/存储对齐）
- **`agent-dataset-model.ts`** — 评测集前端/接口共用类型、`schemaColumnTags`、默认列说明（数据落库见 `AgentEvalDataset`）

#### `shared/` — 跨层共享 pure util / 类型
- **`model-config.ts`** + **`default-model-config.ts`** — 评测/优化用 LLM 配置
- **`interaction-utils.ts`** — interaction 通用工具（前后端共享）

---

## 六、API 接口参考

> 全部接口按 URL 分层组织（与 [Agent Insight 设计文档](./Agent_Insight_Design_Document.md) §3.1 对应；含 `/api/agent-datasets` 等增量）。
> 请求/响应使用 JSON（除注明 multipart/form-data）。路径模式 `[name]` 表示 Next.js 动态路由参数。

| URL 前缀 | 对应层 / 模块 | 包含 |
|---|---|---|
| `/api/auth/*` | 认证 | apikey、organization |
| `/api/guide` | UI helper | 用户引导状态 |
| `/api/ingest/*` | **数据采集层 (L1)** | otel、proxy、upload、setup、sync、parse-document、v1（SDK 透传） |
| `/api/observe/*` | **观测引擎 (L3)** | data、session、executions、task-stats |
| `/api/eval/*` | **评测引擎 (L3)** | settings、rejudge、evaluation、config |
| `/api/agent-datasets` | **评测集** | 列表 / 创建 / 更新 / 单条查询 / 删除（落库 `AgentEvalDataset`） |
| `/api/debug/grayscale-tasks*` | **A/B测试** | `GrayscaleTask` 的创建、配置持久化、后台执行调度、任务轮询与手动评测触发；创建必须传 `skillId` 与 B 实验版本 `versionBId`，接口维护 `user + skillName + skillVersion` 唯一强绑定 |
| `/api/skills/*` | **Skills 服务 (L3)** | 注册、版本、benchmark 生成、同步 |

**向后兼容**：旧的扁平路径（`/api/data`、`/api/session`、`/api/settings`、`/api/setup`…）通过 `next.config.ts` rewrites 自动映射到新路径，外部客户端（OpenCode 插件 / watchers / OTel collectors）无需改动。前端代码已统一使用新路径。


### 6.1 `/api/auth/*` — 认证与授权

#### `POST /api/auth/apikey`
**功能**：为用户生成或获取 API Key  
**输入** body：`{ username: string }`  
**输出 200**：`{ apiKey, username }`  
**错误**：400 缺参 / 邮箱格式无效；500 内部错误

#### `GET /api/auth/organization`
**功能**：从企业系统转发并解析用户信息（企业模式）  
**输入** header：`Cookie`  
**输出 200**：`{ username, displayName, apiKey }`  
**错误**：400 / 500 企业认证失败

---

### 6.2 `/api/guide` — 用户引导状态

#### `GET /api/guide`
**功能**：取用户的引导进度  
**输入** header：`x-user-id` (必填)  
**输出 200**：`{ guideDisabled, currentStep, completedSteps[], skippedSteps[] }`

#### `POST /api/guide`
**功能**：更新引导进度  
**输入** header：`x-user-id`；body：`{ guideDisabled?, currentStep?, completedSteps[]?, skippedSteps[]? }`  
**输出 200**：更新后的状态

---

### 6.3 `/api/ingest/*` — 数据采集层 (L1)

#### 6.3.1 OTel 接收端

#### `POST /api/ingest/otel/v1/traces`
**功能**：OTLP traces 接收端  
**输入** header：`x-witty-api-key?`；body：OTLP traces JSON  
**输出 200**：`{ status: 'success' }`

#### `POST /api/ingest/otel/v1/logs`
**功能**：OTLP logs 接收端  
**输入** header：`x-witty-api-key?`；body：OTLP logs JSON  
**输出 200**：`{ status: 'success' }`

#### `POST /api/ingest/otel/v1/metrics`
**功能**：OTLP metrics 接收端  
**输入** body：OTLP metrics JSON  
**输出 200**：`{ status: 'success' }`

#### 6.3.2 执行数据上传 / 文档解析

#### `POST /api/ingest/upload`
**功能**：执行数据上传（**主要 ingestion 入口**，由 plugin / watcher 调用）  
**输入** header：`x-witty-api-key?`；body：`{ task_id, framework, query, final_result, interactions[], skills[], skill?, skill_version?, tokens, latency, timestamp, user, ... }`  
**输出 200**：`{ success: true, record }`；400 JSON 无效

#### `POST /api/ingest/parse-document`
**功能**：解析 PDF / 文本上传的内容  
**输入** multipart：`document: File`  
**输出 200**：`{ content: string }`；400 / 500

#### 6.3.3 Proxy / SDK 透传

#### `POST /api/ingest/proxy/[taskId]/start`
**功能**：启动代理会话（v1 浏览器内任务模式）  
**输入** path：`taskId`；body：`{ user?, model?, query?, apiKey?, label? }`  
**输出 200**：`{ status: 'ok', task_id, message }`

#### `POST /api/ingest/proxy/[taskId]/end`
**功能**：结束代理会话，自动评估并落库  
**输入** path：`taskId`；body：`{ ... }`  
**输出 200**：`{ status: 'ok', summary, upload_result }`；404 / 500

#### `POST /api/ingest/proxy/[taskId]/[...path]`
**功能**：把 Agent 的 LLM 调用通过此代理转发到上游模型（Claude / DeepSeek 等）以便采集  
**输入** path：`taskId, path[]`；body：原始 LLM 请求  
**输出 200**：上游响应

#### `POST /api/ingest/v1/[...path]`
**功能**：v1 通用代理（向后兼容；现已被 native plugin 替代）  
**输入** path：`path[]`；body：任意 JSON  
**输出**：上游响应；502 代理失败

#### 6.3.4 同步与清单

#### `GET /api/ingest/sync/manifest`
**功能**：导出已上传 Skill 的清单（installer 用）  
**输入** query：`user`  
**输出 200**：`{ skills: [{ id, name, version, downloadUrl }] }`

#### `POST /api/ingest/sync/opencode`
**功能**：把 Skill 同步到本地 OpenCode `~/.opencode/skills/`  
**输入** body：`{ skillId, version, user? }`  
**输出 200**：`{ success: true, targetDir }`

#### 6.3.5 安装脚本分发

`/api/ingest/setup/*` 这一组接口主要是给 installer 与 plugin 拉取脚本文件。

| 路径 | 功能 | 输出 |
|---|---|---|
| `GET /api/ingest/setup/auto?apiKey=&host=` | 生成自动安装脚本（按 UA 选 bash 或 PowerShell） | shell script |
| `GET /api/ingest/setup` | 入口脚本 | shell script |
| `GET /api/ingest/setup/claude-watcher` | 拉取 Claude Code watcher 客户端 | TypeScript |
| `GET /api/ingest/setup/claude` | 拉取 Claude Hook capture 脚本 | JavaScript |
| `GET /api/ingest/setup/openclaw-watcher` | 拉取 OpenClaw watcher 客户端 | TypeScript |
| `GET /api/ingest/setup/opencode` | 拉取 OpenCode plugin（v1 原生模式） | TypeScript |
| `GET /api/ingest/setup/opencode-tui` | 拉取 OpenCode TUI 插件（含 Skill Insight 卡片） | TSX |
| `GET /api/ingest/setup/opencode-uploader` | 拉取 OpenCode 本地 JSONL → 平台上传客户端 | JavaScript |
| `GET /api/ingest/setup/opencode-commands/si-optimizer` | 拉取 si-optimizer 命令文档 | Markdown |

---

### 6.4 `/api/observe/*` — 观测引擎 (L3)

#### 6.4.1 执行记录

#### `GET /api/observe/data`
**功能**：查询执行记录（支持多维过滤）  
**输入** query：`user?`, `query?`, `taskId?`, `framework?`, `skill?`, `skillVersion?`  
**输出 200**：`Execution[]`（含派生 `is_evaluating` 字段）

#### `DELETE /api/observe/data`
**功能**：删除执行记录  
**输入** body：`{ upload_id }` 或 `{ task_id }` 或 `{ timestamp, framework, query }`  
**输出 200**：`{ success: true, count }`

#### `PATCH /api/observe/data`
**功能**：更新单条执行记录的 query / 标签 / 用户反馈 / 最终结果  
**输入** body：`{ task_id?|upload_id?, user_feedback?, label?, query?, final_result? }`  
**输出 200**：`{ success, record, message }`

#### `GET /api/observe/task-stats`
**功能**：获取单个任务的统计快照  
**输入** query：`taskId` (必填)，`framework?`  
**输出 200**：`{ found: true, framework, model, tokens, latency, cost, ... }`；404 `{ found: false }`

#### 6.4.2 会话与 Trace

#### `GET /api/observe/session`
**功能**：取单个会话的全部 interaction 数据（多 Agent trace 的来源）  
**输入** query：`taskId` (必填)  
**输出 200**：`{ taskId, label, query, user, startTime, interactions[] }`；404

#### 6.4.3 执行 vs Skill 流程匹配

#### `POST /api/observe/executions/[executionId]/analyze-match`
**功能**：分析单次执行 vs Skill 静态流程匹配  
**输入** path：`executionId`；body：`{ user?, mode: 'compare'|'dynamic' }`  
**输出 200**：`{ success, mode, match, staticMermaid, dynamicMermaid, flowJson, extractedSteps, interactionCount }`；主 Skill 只来自 root / top-level agent 的直接 `skill` 或 `load_skill` 调用，不再用 `Execution.skill` 兜底；外层主 Agent 没有加载 Skill 时返回 400，不做主 Skill 流程对齐。`extractedSteps` 保留原始 trace 提取出的完整实际步骤，并带有 UI 步骤序号 `uiStepIndex`；流程匹配时后端会将子 Skill 区间折叠为主 Skill 视角的委派摘要发送给 LLM，LLM 只返回稳定的 `evaluationStepId`，后端再映射回完整时间线（actualSteps / mappings / skillSpans / violations）。子 Skill 内部步骤标为 delegated，仅展示来源，不按主 Skill 标准逐条匹配；400 / 404

#### `GET /api/observe/executions/[executionId]/analyze-match`
**功能**：取已分析过的匹配结果（缓存）  
**输入** path：`executionId`  
**输出 200**：`{ analyzed: true|false, mode, matchJson, staticMermaid, dynamicMermaid, analysisText, flowJson, extractedSteps }`；旧缓存可能只有 matches / skippedExpectedSteps，前端需兼容回退

---

### 6.5 `/api/eval/*` — 评测引擎 (L3)

#### 6.5.1 模型配置

#### `GET /api/eval/settings`
**功能**：取用户的评测/优化 LLM 配置  
**输入** query：`user`  
**输出 200**：`{ apiKey, baseUrl, model, provider }`

#### `POST /api/eval/settings`
**功能**：保存用户的 LLM 配置  
**输入** body：`{ settings, user }`  
**输出 200**：保存的配置

#### `POST /api/eval/settings/test`
**功能**：测试 LLM 连接  
**输入** body：`{ apiKey?, baseUrl?, model?, provider? }`  
**输出 200**：`{ success: true, message }` 或 500 `{ success: false, error }`

#### 6.5.2 数据集 / 配置

#### `GET /api/eval/config`
**功能**：获取数据集配置列表  
**输入** query：`user?`  
**输出 200**：`Config[]`

#### `POST /api/eval/config`
**功能**：批量保存数据集  
**输入** body：`{ configs: Config[], user }`  
**输出 200**：`{ success: true }`；400 数据格式无效

#### `POST /api/eval/config/create`
**功能**：创建单条数据集（支持 PDF/Markdown 文档自动解析）  
**输入** multipart 或 JSON：`{ query, skill, skillVersion, datasetType, standardAnswer, document?, expectedSkills? }`  
**输出 200**：`{ id, query, dataset_type, skill, routing_intent, parse_status }`；400 验证失败；409 重复

#### `POST /api/eval/config/reparse`
**功能**：重新解析已有数据集（重跑 LLM 抽取）  
**输入** body：`{ id, user }`  
**输出 200**：`{ success: true, message }`；404 不存在

#### `POST /api/eval/config/backfill-routing`
**功能**：批量为路由型数据集补语义路由签名  
**输入** body：`{ user, limit?, concurrency?, includeCompleted?, allUsers? }`  
**输出 200**：`{ success, processed, updated, failed, results[] }`

#### `GET /api/eval/config/status`
**功能**：查询单个配置的解析状态 / 平台是否企业模式  
**输入** query：`id` 或 `check_org=true`  
**输出 200**：`{ id, query, dataset_type, routing_intent, standard_answer, key_actions[], parse_status }` 或 `{ org_mode, org_login_redirect_url }`

#### 6.5.3 评测执行

#### `POST /api/eval/evaluation`
**功能**：保存独立评测结果（K-V 形式存到 `data/evaluation_result.json`）  
**输入** body：`Record<string, number|string>`  
**输出 200**：`{ success: true, count }`

#### `POST /api/eval/rejudge`
**功能**：基于已有 session 重新跑 judge 流程（重新调 LLM）  
**输入** body：`{ task_id?|upload_id?, currentUser }`  
**输出 200**：`{ success: true, record }`；400 无评估配置；404 记录或会话不存在

---

### 6.6 `/api/agent-datasets*` — 评测集

与 **`Config`**（路由/outcome 用例、LLM 抽取）并列的另一套数据：**按用户隔离的评测集定义 + 数据项（cases）**，落库表 **`AgentEvalDataset`**（或见数据模型一节）。

#### `GET /api/agent-datasets`
**功能**：列出当前用户的评测集  
**输入** query：`user`（必填）  
**输出 200**：`AgentDatasetRecord[]`（含 `id`, `name`, `tags`, `cases`, `datasetKind`, `createdAt`, `updatedAt` 等）

#### `POST /api/agent-datasets`
**功能**：新建评测集  
**输入** body：`{ user, name, description?, targetAgent?, tags?, datasetKind?, cases? }`  
**输出 200**：`{ success: true, dataset }`

#### `PATCH /api/agent-datasets`
**功能**：更新评测集（元数据或整表 cases）  
**输入** body：`{ user, id, name?, description?, targetAgent?, tags?, datasetKind?, cases? }`  
**输出 200**：`{ success: true, dataset }`；404 无此条

#### `GET /api/agent-datasets/[id]`
**功能**：取单条评测集  
**输入** query：`user`（必填）；path：`id`  
**输出 200**：单对象；404

#### `DELETE /api/agent-datasets/[id]`
**功能**：删除评测集  
**输入** query：`user`（必填）；path：`id`  
**输出 200**：`{ success: true }`；404

> **触发评价集（RecallTestSet）**：行为评测集复用 `AgentEvalDataset`（`targetSkill` 字段定位到具体 skill），但**触发评价集**走独立模型 `SkillTriggerEvalSet`——case 是 `{query, shouldTrigger}` 跟 `{input, expectedOutput}` 形态完全不同，强塞同表会让 `datasetKind` 变杂物间。接口在下一节 6.7。

---

### 6.7 `/api/skill-eval/trigger/*` — Skill 触发评价集

服务 skill 分析页"召回分析"卡：评测 skill 的 description 在 opencode session 下能否被正确触发（opencode-live 模式 —— 真起 opencode session、监听 tool 调用、命中即 abort 省 token，方法论照搬 anthropic skill-creator `run_eval.py` 同款）。

**几条关键设计约束**：
- 评测**对象是 (skill, opencode 项目配置) 二元组**：opencode 的 agent / memory / skills 列表都锁死在项目实际配置上，不被请求 override。要换 agent 行为请在 opencode 里改 agent 配置，改完再跑评测。
- **物化 user skills**：评测开始时把该 user 在 DB 里的所有 skill（`SkillVersion.content`）写到 `<workspaceRoot>/.opencode/skills/<name>/SKILL.md`，opencode 才能通过它的标准发现路径找到。`.opencode/` 已 gitignored，纯本地 staging。
- **Read-only 评测**：通过 `permission` deny 列表禁用 `bash` / `edit` / `write` / `task` / `webfetch` / `question`——评测语义是"会不会触发 skill"不是"会不会把任务跑完"。
- **多模型注册**：opencode server 启动时把 user 注册的**所有**同 provider 模型一并注册（不仅 active config），让 evaluation 时可以选不同模型而不重启 opencode。

#### `GET /api/skill-eval/trigger/[skillName]`
**功能**：拉 user × skill 的触发评价集；不存在返回 200 + `{ set: null }`（前端区分"未配置"vs 错误）  
**输入** query：`user`（必填）；path：`skillName`  
**输出 200**：`{ set: SkillTriggerEvalSetRecord | null }`

#### `POST /api/skill-eval/trigger/[skillName]`
**功能**：upsert 触发评价集（用户在编辑器里保存调这个）。**不会**重新起草，重新起草走 `/draft` 子路由。  
**输入** body：`{ user, description?, items: TriggerItem[] }`，每条 item 形态 `{id, query, shouldTrigger, rationale?, source}`  
**输出 200**：`{ success: true, set }`

#### `DELETE /api/skill-eval/trigger/[skillName]`
**功能**：删除整个评价集  
**输入** query：`user`（必填）；path：`skillName`  
**输出 200**：`{ success: true }`；404 不存在

#### `POST /api/skill-eval/trigger/[skillName]/draft`
**功能**：触发 LLM 起草 ~18 条草稿（9 正例 + 9 near-miss 反例），实测耗时 5-15s。默认保留用户编辑过的条目，只覆盖现有 LLM-draft 部分。  
**输入** body：`{ user, modelConfigId?, replaceUserEdited? }`
  - `modelConfigId`：`/modelconfig` 注册的 ModelConfig.id；不传则用 active config，仍没有就退环境变量兜底。  
  - `replaceUserEdited`（默认 false）：true 时抹掉所有现有 item 重起。  

**输出 200**：`{ success: true, set }`

#### `POST /api/skill-eval/trigger/[skillName]/run`
**功能**：跑 opencode-live 评测。同步等评测完成才返回 200（典型 30-90s，由 query 数 × runsPerQuery × concurrency 决定）。  
**输入** body：`{ user, modelConfigId?, runsPerQuery?, triggerThreshold?, timeoutMs?, concurrency? }`
  - `modelConfigId`：透传给 opencode 的 model 字段（providerID + modelID + apiKey + baseURL）
  - `runsPerQuery`（默认 1）：每条 query 跑几次，多次跑里 ≥ `triggerThreshold` 比例算"触发"
  - `triggerThreshold`（默认 0.5）/ `timeoutMs`（默认 30000）/ `concurrency`（默认 5）  

**校验**：触发集必须 ≥1 条 item，否则 400  
**输出 200**：`{ success: true, run: SkillTriggerEvalRunRecord }`，含 `passRate` / `truePositiveRate` / `falsePositiveRate` 与 per-item `results`

#### `GET /api/skill-eval/trigger/[skillName]/runs`
**功能**：列 run 历史 / 拿最新一条 done 状态的 run  
**输入** query：`user`（必填）、`skillVersion?`、`limit?`（默认 50）、`latestOnly=true`（只返回最新一条 done）；path：`skillName`  
**输出 200**：
  - `latestOnly=true` → `{ run: SkillTriggerEvalRunRecord | null }`（给分析页"召回分析"卡显示分数用）
  - 否则 → `{ runs: SkillTriggerEvalRunRecord[] }`

---

### 6.8 `/api/skills/*` — Skills 服务 (L3)

#### 6.8.1 Skill 列表与单体

#### `GET /api/skills`
**功能**：列出 Skill（按用户隔离）  
**输入** query：`query?`, `category?`, `user?`  
**输出 200**：`Skill[]`，每个含 `versions[]`、`activeVersion`、`isUploaded`

#### `DELETE /api/skills`
**功能**：删除 Skill（含远端企业同步）  
**输入** query：`id`, `user`  
**输出 200**：`{ success: true }`

#### `GET /api/skills/by-name`
**功能**：按 name 取单个 Skill  
**输入** query：`name`, `user`  
**输出 200**：`{ id, name, description, activeVersion }`；404

#### `GET /api/skills/logs`
**功能**：取 Skill 的执行日志  
**输入** query：`skill` (必填), `skill_version?`, `limit?`, `user?`  
**输出 200**：`{ task_id, query, answer_score, failures[] }[]`

#### 6.8.2 版本管理

#### `GET /api/skills/[id]/versions`
**功能**：列出 Skill 的所有版本  
**输入** path：`id`  
**输出 200**：`SkillVersion[]`

#### `POST /api/skills/[id]/versions`
**功能**：新建版本  
**输入** path：`id`；body：`{ content, changeLog?, user? }`  
**输出 200**：新版本对象

#### `GET /api/skills/[id]/versions/[version]`
**功能**：单版本详情  
**输入** path：`id, version`  
**输出 200**：`{ version, content, changeLog, createdAt }`

#### `DELETE /api/skills/[id]/versions/[version]`
**功能**：删除版本（不可删最后一个）  
**输入** path：`id, version`  
**输出 200**：`{ success: true }`

#### `GET /api/skills/[id]/versions/[version]/download`
**功能**：以 ZIP 下载某版本（含 SKILL.md + scripts/）  
**输入** path：`id, version`  
**输出 200**：`application/zip` 流；404

#### `POST /api/skills/[id]/versions/[version]/parse-flow`
**功能**：解析此版本的 Skill 流程图，缓存到 ParsedFlow  
**输入** path：`id, version`；body：`{ user? }`  
**输出 200**：`{ success: true, flow, mermaidCode }`

#### `POST /api/skills/[id]/activate`
**功能**：把指定版本设为 activeVersion  
**输入** path：`id`；body：`{ version, user? }`  
**输出 200**：更新后的 Skill

#### `POST /api/skills/[id]/toggle`
**功能**：切换 isUploaded 标志（控制是否 sync 到 OpenCode）  
**输入** path：`id`；body：`{ isUploaded: boolean, user? }`  
**输出 200**：`{ success: true, skill }`

#### 6.8.3 Benchmark / 上传 / 自动化

#### `POST /api/skills/[id]/benchmark-generate`
**功能**：基于该 Skill 自动生成 benchmark 数据集  
**输入** path：`id`；body：`{ user?, version?, includeRouting?, includeOutcome?, routingCount? }`  
**输出 200**：`{ routing_configs[], outcome_configs[] }`；400 无评测模型

#### `POST /api/skills/upload`
**功能**：上传 Skill 文件（新建或新增版本）  
**输入** multipart：`files[]`, `paths[]`, `targetSkillId?`, `user?`  
**输出 200**：`{ success: true, skill }`；400 SKILL.md 缺失；403 无权限

#### `POST /api/skills/automation/import`
**功能**：从本地路径导入一个 Skill（dev 用）  
**输入** body：`{ path, user? }`  
**输出 200**：`{ success: true, skill }`；400 SKILL.md 不存在

#### `POST /api/skills/automation/push`
**功能**：把 Skill 推到 OpenCode 本地目录  
**输入** body：`{ name, version, user }`  
**输出 200**：`{ success: true, activeVersion, isUploaded }`

#### 6.8.4 企业同步

#### `GET /api/skills/sync-enterprise`
**功能**：查询企业同步状态  
**输出 200**：`{ isSyncing, lastResult, startTime }`

#### `POST /api/skills/sync-enterprise`
**功能**：触发企业 Skill 库同步  
**输入** header：企业 Cookie  
**输出 200**：同步结果；400 企业模式未启用；409 已在同步

#### 6.8.5 优化点（SkillIssue）

> 概念与表结构见 [§4.1](#41-skill-优化点子系统evaluation--skillissue)。这两个接口是 skill-opt 页面（`/skill-opt/[name]/[version]`）拉取与回写「待优化点」的入口。

#### `GET /api/skills/by-name/[name]/optimization-points`
**功能**：按 skill 名取该 skill 的所有可优化点（聚合 static + dynamic 两类 Evaluation 下的 SkillIssue），用于 skill-opt 入口右栏 / skill-opt agent prompt 注入。  
**路径**：`name` —— **decode 后的 skill name**（`/api/skills/[id]` 已占用 `[id]` 段，所以单独走 `by-name`）。  
**输入** query：
- `user`（必填）—— 多租户隔离；与 `resolveUser(request, userParam)` 一致，匿名时按 owner-null / public 兜底
- `version`（可选）—— 整数；不传则跨版本聚合该 skill 的所有 issue
- `includeResolved`（可选，`=1` 启用）—— 默认仅返回 `resolvedAt=null`；启用后含已 resolve

**输出 200**：
```jsonc
{
  "skill": "vmcore-analysis",
  "version": 3,
  "generatedAt": "2026-05-08T10:30:00.000Z",
  "generator": "skill-issues@0.1.0",
  "issues": [
    {
      "id": "iss_xxx",                       // = SkillIssue.id
      "severity": "high",                    // 'high'|'medium'|'low'，已被 prevalence 抬升
      "category": "路径偏离",                 // 来自 SkillIssue.category；缺省由 source 兜底
      "summary": "未按 SKILL.md 第 3 步执行...",
      "evidence": "trace 第 5 步调用了 ...",  // 可选
      "improvementSuggestion": "在 SKILL.md ...", // = SkillIssue.suggestedFix
      "source": {
        "kind": "trace",                     // 'trace'|'static'|'fault'|'log'
        "label": "task_a1b2…f3e4",           // dynamic 时为 short taskId；static 时为「静态评估」
        "url": "/trace?taskId=..."           // 跳转链接（dynamic→trace；static→/evaluation/<id>）
      },
      "occurrence": 3,                       // = prevalenceCount，跨 Evaluation 同 dedupKey 计数
      "createdAt": "2026-05-07T08:11:23.000Z"
    }
  ],
  "stats": { /* aggregator 内部统计，UI 不强依赖 */ }
}
```
**错误**：`400 version must be an integer`、`403 Unauthorized`（`canAccessSkill` 拒绝）、`404 Skill not found`、`500`。

#### `PATCH /api/skills/by-name/[name]/optimization-points/resolve`
**功能**：把一组 SkillIssue 标记为「已解决」（resolvedAt = now，resolvedRunId = threadId）。skill-opt agent 完成一轮优化后由前端回调，避免下次列表里再出现已修复项。  
**输入** path：`name`（skill name，与 GET 一致）；body：
```ts
{ user: string; ids: string[]; threadId?: string }
```
- 双保险：`user` 必须与 SkillIssue 的 user 匹配；同时校验路径上的 skill name 必须等于 SkillIssue 关联 Skill 的 name（防止跨 skill 误改）  
- 仅会更新当前 `resolvedAt=null` 的行；已解决的 id 自动跳过  

**输出 200**：`{ resolvedCount: number }`  
**错误**：`400 skill name required` / `400 invalid json` / `400 user required` / `400 ids required`。

**前端调用点**：
- 列表入口：`src/app/(main)/skill-opt/page.tsx` —— 切换 skill / version 时拉 GET
- 详情页：`src/app/(main)/skill-opt/[name]/[version]/page.tsx` —— 进入页面时 GET，agent 完成时把 `optimizedIssueIds` 回 PATCH `/resolve`

#### `POST /api/skills/by-name/[name]/analysis-diagnosis`
**功能**：为 Skill 分析页 Hero 区生成“一句话诊断”的 `problem` / `suggestion`。前端先汇总 A/B、用例分析、召回分析、静态合规 4 维快照，再由服务端调用当前 active 评测模型生成文案；若模型未配置、调用失败或响应不可解析，则回退为规则生成的基础诊断。  
**输入** path：`name`（skill name）；body：
```ts
{
  user: string;
  snapshot: SkillDiagnosisSnapshot;
}
```

`snapshot` 只包含当前页已汇总好的结构化摘要，不回传原始 trace / 全量 run 明细。核心字段：
- `overall.weightedScore` / `coveredCount` / `missingDimensions`
- `ab.scoreA` / `scoreB` / `delta` / `pValue`
- `trace.score` / `fullyEvaluatedCount` / `highDeviationCount`
- `recall.passRate` / `truePositiveRate` / `falsePositiveRate`
- `static.score` / `issueCount`

**输出 200**：
```jsonc
{
  "diagnosis": {
    "problem": "当前仅有 3/4 个维度完成评测，数据覆盖仍不完整。",
    "suggestion": "建议先补齐可运行维度，再判断是否需要进入 Skill 优化。",
    "mode": "llm",            // or "fallback"
    "modelLabel": "My DeepSeek",
    "errorMessage": null
  }
}
```

**行为约束**：
- `mode='llm'`：表示由当前 active 评测模型生成
- `mode='fallback'`：表示服务端使用规则兜底，不把模型错误直接暴露为主结论
- 只有请求体非法时返回 4xx；LLM 失败仍返回 200 + `fallback`

**前端调用点**：
- `src/app/(main)/skill-eval/page.tsx` —— 页面初次加载、skill/version 切换、以及“一键测试”完成后刷新 Hero 诊断

## 七、数据采集端

`scripts/` 目录下的采集端实现。三种 Agent 框架各有独立采集路径：

| 框架 | 采集方式 | 主文件 |
|---|---|---|
| **OpenCode** | 原生 Plugin | `opencode_plugin.ts`（v1 原生格式）<br>`opencode_plugin_otel.ts`（OTel GenAI 格式） |
| **Claude Code** | 日志旁路 watcher | `claude_watcher_client.ts`（监听 `~/.claude/projects/`） |
| **OpenClaw** | 日志旁路 watcher | `openclaw_watcher_client.ts` |

### OpenCode OTel 模式（推荐）
1. **Plugin** (`opencode_plugin_otel.ts`) 在 OpenCode 内部 hook，按 OTel GenAI semconv 输出 Span / Metrics / Events 到本地 JSONL（`scripts/otel_data/opencode/<timestamp>/...`）
2. **Schema** (`opencode_otel_schema.ts`) 定义 invoke_agent / execute_tool / load_skill 等 Span 的字段
3. **Uploader** (`opencode_uploader_client.js`) 增量读取 JSONL 上传到平台 `/api/ingest/upload`
4. **Local OTel collector** (`tools/otel-local-collector.mjs`) 选用，用于在本地接收 Span（开发用）

### Skill 工坊（`skills/`）
- `skill-generator/` —— 一句话生成 Skill
- `skill-optimizer/` —— 基于评测记录优化 Skill
- `iterative-optimizer/` —— 迭代优化
- `outcome-benchmark-generator/` —— 基于 Skill 生成 benchmark
- `routing-benchmark-generator/` —— 路由 benchmark 生成
- `skill-benchmark-generator/` —— 通用 benchmark 生成
- `skill-sync/` —— 企业 Skill 双向同步

---

## 八、通用 Agent 框架（基于 OpenCode）

> 本节面向**服务内开发者**——当你想要在 agent-insight 服务内部跑一个 Agent
> （比如 playground 的 skill 生成、未来的 skill 优化器、轨迹评估器、自动诊断器等），
> 不要自己 spawn 子进程或自己接 LLM SDK。**统一用 `runGeneralAgent`**。
>
> 全部源码：[`src/lib/engine/general-agent/`](../src/lib/engine/general-agent/)

### 8.1 概览与设计动机

#### 解决什么问题

服务里经常有多个内部 Agent 需要 LLM + 工具能力：playground、skill 优化、轨迹评估、自动诊断……
直接用模型 SDK 写：每个模块自己拼工具集 + prompt + 流式 + 错误处理 → 重复 + 不一致 + 难追踪。

通用 Agent 框架把**底层 OpenCode runtime** 包成一个稳定 API，模块只关心：
- "我要让 agent 做什么"（system prompt / skill / query）
- "我是谁"（systemAgentName，影响 trace 归属）

下面这些事**框架替你做了**：

| 关注点 | 框架做的事 |
|---|---|
| OpenCode 子进程生命周期 | 单例 spawn + 健康检查 + 优雅关闭，全局共享 |
| 多用户隔离 | 按 user 切 workspace 目录、permission 白名单 |
| 多任务隔离 | workspaceTag 机制，同一 user 不同 task 文件互不污染 |
| 多轮对话 | sessionId 复用，对话历史在 OpenCode 内部维持 |
| Trace 归属 | `internal-agent-tag` 让 plugin 上报的 trace 自动打上正确的 agentName/agentId/skill |
| 模型选择 | 优先用户 active config → env → 默认 |
| 工具交互 | 三种策略：自动允许 / 自动拒绝 / 手动 callback（HITL） |
| 流式事件 | onText/onTool/onReasoning/onFileEdited 等回调，对前端透明 |

#### 架构概览

```
caller（playground / 评估器 / 优化器 / ...）
   │
   ▼
runGeneralAgent({ user, query, skill?, system?, systemAgentName?, ... })
   │
   ├── 模型解析（loadServerModelForUser → env 兜底）
   ├── workspace 隔离（按 user + workspaceTag 创建独立目录）
   ├── permission 白名单（只允许 workspace + /tmp/*）
   ├── OpenCode session 创建/复用
   ├── tag session 让 plugin trace 正确归属
   └── chat() — 流式驱动 + 翻译事件给 caller handler
        │
        ▼
   OpenCode subprocess（项目内 node_modules/.bin/opencode）
```

### 8.2 快速开始

最小例子：让 agent 在隔离环境中执行一段任务，拿到结果。

```ts
import { runGeneralAgent } from '@/lib/engine/general-agent';

const result = await runGeneralAgent({
  user: 'alice@example.com',                  // 必填，多租户隔离 key
  query: '总结一下 README.md 这个项目是干什么的',
  // 不传 system / skill 就用 OpenCode 默认行为（通用 coding agent）
});

console.log(result.output);          // agent 最终文本
console.log(result.sessionId);       // 多轮可复用
console.log(result.workspaceDir);    // 这次任务的隔离目录
console.log(result.stats);           // tokens / tool 调用数 等
```

### 8.3 核心 API：`runGeneralAgent`

源码：[`src/lib/engine/general-agent/runner.ts`](../src/lib/engine/general-agent/runner.ts)

#### 输入参数

```ts
interface RunGeneralAgentInput {
  // ── 必填 ─────────────────────────────────────────
  user: string;                  // 多租户隔离 key（也用于查 user 的模型配置 / skill 库）
  query: string;                 // 用户的输入文本

  // ── Skill / System Prompt ──────────────────────
  skill?: string;                // 从 DB 取该名 skill 的 SKILL.md 当 system prompt
  skillVersion?: number;         // 指定版本，默认 activeVersion / 最新
  system?: string;               // 自定义 system prompt。组合规则见下方。

  // ── 多轮 / 隔离 ────────────────────────────────
  sessionId?: string;            // 复用已有 OpenCode session（多轮对话）
  workspaceTag?: string;         // workspace 目录稳定标签；多轮务必传一个稳定值（如 threadId）
  sessionTitle?: string;         // 仅用于 OpenCode 内部展示

  // ── Trace 归属（接入观测体系） ──────────────────
  systemAgentName?: string;      // SYSTEM_AGENTS 里登记的名字，下文 §8.4 详解

  // ── 模型 ───────────────────────────────────────
  model?: Partial<ModelConfig>;  // 覆盖默认 model（providerID / modelID / apiKey / baseURL）
  modelOptions?: Record<string, unknown>; // 温度等 LLM 参数

  // ── 行为 ───────────────────────────────────────
  agent?: string;                // OpenCode agent 类型：'build' | 'plan' | ...，默认 'build'
  interactionPolicy?: 'auto-allow' | 'auto-deny' | 'manual';  // §8.5 三种模式
  handlers?: ChatHandlers;       // 流式事件回调（onText / onTool / ...）
  chatOptions?: ChatOptions;     // streamTimeoutMs / idleTimeoutMs / signal
  timeoutMs?: number;            // 整体超时，默认 5 分钟
}
```

#### `skill` × `system` 组合规则

| 传参 | 实际 system prompt |
|---|---|
| 只传 `skill` | skill 的 SKILL.md 全文 |
| 只传 `system` | 你传的字符串 |
| 同时传 `skill` + `system` | `<skill SKILL.md>\n\n[System Instructions]:\n<你传的 system>` |
| 都不传 | OpenCode 默认（通用 coding agent） |

**典型用法**：用 `skill` 装载领域 prompt（来自 DB，多版本可控），用 `system` 加**运行期约束**——
比如"答完不要再调 question 工具"、"产物只写到当前 workspace"、"不要联网下载未审核内容"。
两者互补不互斥。这条路已经在 playground / fault-diagnosis / skill-debug-executor /
skill-optimizer 等内置 Agent 上跑通，每条 Agent 都按需在自己的入口拼自己那份约束。

> 想给所有内置 Agent 加**通用约束**？目前还没有 runner 层的 baseline 注入机制，每个
> caller 自己拼。需要的话考虑在 `SystemAgentDefinition` 加 `extraSystemPrompt` 字段，
> 让 runner 看到 `systemAgentName` 时自动追加——避免散在多处复制粘贴。

#### 输出

```ts
interface RunGeneralAgentResult {
  sessionId: string;                    // OpenCode sessionId（多轮可复用）
  workspaceDir: string;                 // 这次任务的隔离目录（绝对路径）
  skillResolved: boolean;               // 是否成功从 DB 解出 skill
  skillMeta: { name, version, semanticVersion, source } | null;
  output: string;                       // agent 最终文本输出
  interactions: InteractionRecord[];    // 这次执行触发过的 permission/question 事件审计
  stats: {
    eventCount, textDeltaCount, toolCallCount, subagentCount,
    eventTypeCounter: Record<string, number>,
  };
}
```

### 8.4 系统 Agent 注册（接入 trace 归属）

如果你的内部 Agent 想出现在**Agent 管理页**和**trace 列表**里（让用户能看到调用次数、最近执行时间、关联的执行记录），必须做两件事：

#### Step 1：在 `SYSTEM_AGENTS` 里登记

[`src/lib/system-agents.ts`](../src/lib/system-agents.ts) 的 `SYSTEM_AGENTS` 数组：

```ts
export const SYSTEM_AGENTS: SystemAgentDefinition[] = [
  {
    platform: 'opencode',                    // 框架类别
    name: 'playground-skill-generator',      // 唯一名（同 platform 下唯一）
    description: '...',                      // UI 展示用
    agentType: 'main',                       // 'main' | 'subagent'
    traceSkill: 'skill-generator',           // 可选：trace 上的 skill 标签
  },
  // ── 想加新的就在这里加，server 重启即生效 ──
  {
    platform: 'opencode',
    name: 'skill-optimizer',
    description: '基于历史 trace 自动优化 skill 内容',
    agentType: 'main',
    traceSkill: 'skill-optimizer',
  },
];
```

`src/instrumentation.ts` 在服务启动时自动 `ensureAllSystemAgents()`——把这些条目 upsert 到
`RegisteredAgent` 表，新部署 / 全新 DB 立即可见。

#### Step 2：调用时传 `systemAgentName`

```ts
runGeneralAgent({
  user,
  query,
  systemAgentName: 'skill-optimizer',     // ← 关键
  ...
});
```

发生的事：
1. 创建 OpenCode session 后，runner 把 `(opencodeSessionId → {agentName, agentId, skill, displayQuery})`
   塞进 [`internal-agent-tag.ts`](../src/lib/internal-agent-tag.ts) 的进程内注册表
2. 用户机器上的 OpenCode plugin（`~/.opencode/plugins/Witty-Skill-Insight.ts`）异步把整个会话
   上报到 `/api/ingest/upload`
3. upload 路由查表，命中 tag 就用我们的字段**覆盖** plugin 默认填的 `agentName/agentId/skill/query`
4. trace 写到 `Execution` 表，`agentName=skill-optimizer / agentId=<RegisteredAgent.id> / skill=skill-optimizer`

→ Agent 管理页能看到这条 Agent + 今日调用数 + 最近执行时间；trace 列表点进去能看到对应的执行记录。

> 注意：`runGeneralAgent` 自己**不写** `Execution` 表——避免与 plugin 双重消费。trace 数据
> 完全走"plugin → spool → uploader → /api/ingest/upload → Execution"这条统一管道。

### 8.5 三种调用模式

由 `interactionPolicy` 选择。

#### 模式 A — 同步无交互（评测、批跑、后台任务）

```ts
const r = await runGeneralAgent({
  user, query,
  interactionPolicy: 'auto-allow',     // 权限自动允许；问题自动拒绝（默认）
  // 或 'auto-deny'                    // 全部拒绝，最保守，纯生成场景
});
console.log(r.output);
```

适合：评估器、自动化脚本、跑批任务。**不需要 UI**。

`r.interactions` 会记录这次执行触发过的 permission/question 事件 + 应答内容，便于审计。

#### 模式 B — 同进程 callback（自定义 UI）

```ts
import { runGeneralAgent, type ChatHandlers } from '@/lib/engine/general-agent';

await runGeneralAgent({
  user, query,
  interactionPolicy: 'manual',         // 必须自己提供 handlers
  handlers: {
    onText:      (e) => myUI.appendToken(e.delta),
    onTool:      (e) => myUI.showToolStep(e),
    onReasoning: (e) => myUI.showThinking(e.delta),
    onFileEdited:(e) => myUI.refreshFile(e.path),
    onPermission: async (e) => myUI.askPermission(e),    // 'once' | 'always' | 'reject'
    onQuestion:   async (e) => myUI.askQuestion(e),      // any[] | null
  },
});
```

适合：服务端某个组件想用 agent + 自己定义 UI（比如 playground、skill 调试器等）。

#### 模式 C — 流式 SSE（浏览器前端）

服务里已经实现了三个通用端点：

| 端点 | 作用 |
|---|---|
| `POST /api/agent/run` | 同步版（模式 A）—— 一次性返回结果，body 是 JSON |
| `POST /api/agent/stream` | SSE 流式 + manual 交互 —— 每条事件作为 `data: {...}` 推 |
| `POST /api/agent/respond` | 浏览器把 permission/question 答复打回来 |

前端流程：
1. POST `/api/agent/stream` 拿到 SSE 流
2. 循环读 chunks，按事件类型渲染（`text` / `tool` / `permission` / `question` / `done` / ...）
3. 命中 `permission` / `question` 事件时弹 UI，用户答完后 POST `/api/agent/respond`
4. 服务端 `awaitInteraction` 解开 promise，agent 继续执行

详见 [`src/app/api/agent/stream/route.ts`](../src/app/api/agent/stream/route.ts)。

> **playground 是模式 B 的实现**：自己定义 SSE 协议（`text/thinking/tool_call/tool_result/vfs_patch/download/done`），
> 在 [`src/lib/playground-opencode-bridge.ts`](../src/lib/playground-opencode-bridge.ts) 把 OpenCode 事件
> 翻译到这套协议。可以参考。

### 8.6 多用户隔离

| 维度 | 实现 |
|---|---|
| **用户级目录** | `~/.agent_insight/agent_workspaces/<userhash>_<sanitized-user>/` |
| **任务级目录** | `<userdir>/<workspaceTag>/`，多任务文件互不污染 |
| **路径穿越防御** | `sanitizeUserSlug()` 把非 `[A-Za-z0-9._-]` 替成 `_` + 加 hash 前缀 |
| **OpenCode permission** | 默认只允许 workspace + `/tmp/*`（在 `interactionPolicy='auto-allow'` 时也只一次性允许） |
| **OpenCode session** | session 由 sessionId 隔离；不同 user 的 session id 不会撞 |
| **Skill 库** | `resolveSkill(name, user)` 优先用户私有 skill，未命中再回退全局 |

源码：[`workspace.ts`](../src/lib/engine/general-agent/workspace.ts)

### 8.7 文件式 Skill 注入

除了 DB 里的 skill，框架还支持**直接读 `skills/<name>/`** 当 system prompt——
适合"系统内置、随仓库一起更新、不需要版本管理"的 skill。

[`src/lib/engine/general-agent/skills-fs-loader.ts`](../src/lib/engine/general-agent/skills-fs-loader.ts) 提供：

| 函数 | 用途 |
|---|---|
| `fileBasedSkillExists('xxx')` | 判断 `skills/xxx/SKILL.md` 是否存在 |
| `loadFileBasedSkillPrompt('xxx')` | 读 SKILL.md，**带 mtime 缓存**——文件改了下次调用立即生效 |
| `mountFileBasedSkillResources('xxx', workspaceDir)` | 把 `skills/xxx/{references,scripts,templates}` symlink 到 `<workspaceDir>/.xxx/`，让 agent 能 progressive disclosure 加载辅助资源 |

playground 是这种用法的范例（[`playground-opencode-bridge.ts`](../src/lib/playground-opencode-bridge.ts) 的 `preparePlaygroundSystemPrompt`）：
1. 读 `skills/skill-generator/SKILL.md` 当 system prompt
2. mount 整个 `skills/skill-generator/` 到 workspace 的 `.skill-generator/`
3. 给 agent 加一段 meta：`参考资源在 ./.skill-generator/，最终输出写到 cwd 根`

### 8.8 模型解析优先级

`runGeneralAgent` 决定用哪个模型的优先级（从高到低）：

| # | 来源 | 何时使用 |
|---|---|---|
| 1 | caller 显式传 `input.model.{providerID,modelID,apiKey,baseURL}` | 永远最优先（细粒度覆盖） |
| 2 | 用户 settings 里选中的 active config | 通过 `loadServerModelForUser(user)` 自动读，覆盖默认调用方场景 |
| 3 | `GENERAL_AGENT_*` 环境变量 | 部署兜底 |
| 4 | `OPENCODE_*` / `DEEPSEEK_API_KEY` 环境变量 | 兼容旧 CLI demo |

服务端 `ModelConfig` (`{apiKey, baseUrl, model}`) → OpenCode `ModelConfig` 字段映射（[`server-model-config.ts`](../src/lib/engine/general-agent/server-model-config.ts)）：

| 服务端 | OpenCode | 备注 |
|---|---|---|
| `apiKey` | `apiKey` | 直传 |
| `baseUrl` | `baseURL` | 直传 |
| `model` | `modelID` | 直传 |
| `provider`（仅 default 配置有）| `providerID` | 用户自建配置无此字段，从 `baseUrl` 推断（deepseek/openai/anthropic/google/qwen/moonshot） |

### 8.9 已知限制与排查

#### 已知限制
- **OpenCode 子进程是单实例所有用户共享**——server 崩溃时所有正在跑的 Agent 一起失败（runner 有兜底重建 session 逻辑）
- **进程内 Map 状态不跨进程**：`internal-agent-tag` / `threadInflight` 等都是 globalThis 单例，多实例部署需要换 Redis
- **deepseek-chat 的 reasoning 不会显示**——`thinking` 块只对 R1 / o1 / qwq 等 thinking 模型有效
- **opencode plugin 仍然在跑**：服务自身 spawn 的 OpenCode 也走 plugin → spool → uploader 链路，trace 由 plugin 上报；bridge 通过 `internal-agent-tag` 让字段被覆盖正确，但 spool 文件仍然写盘

#### 调试技巧

| 现象 | 排查路径 |
|---|---|
| 完全无响应 / curl 240s 卡住 | 1. `ps -ef \| grep opencode` 看是否多个孤儿子进程；用 `bash scripts/stop.sh` 清理后 `bash scripts/restart_dev.sh`<br>2. 看 `server.log` 有无 `chat.stream.heartbeat_only_fallback` 警告——SSE 订阅可能没收到 message 事件 |
| 文件没生成 | 1. agent 是否真调了 write 工具？看 `result.stats.toolCallCount`<br>2. workspace 下是否有 `.skill-generator/`（mount 失败的话 SKILL.md 引用的 references 读不到）|
| trace 归属错误 / agentName 是 null | `getInternalAgentTag` 找不到 tag——确认 `systemAgentName` 已传，且该名在 `SYSTEM_AGENTS` 里有定义 |
| `model.apiKey missing` 报错 | 用户在 settings 没选 model，且 env 也没设——让用户先去 `/modelconfig` 配模型，或者部署侧设 `GENERAL_AGENT_API_KEY` |
| 多轮对话第二轮"忘了"上一轮 | 1. `playgroundSession.opencodeSessionId` 是否持久化下来了<br>2. OpenCode server 重启会让 sessionId 失效，runner 检测到 `/session/i` 错误会自动重建 session（agent 内对话历史丢，但磁盘文件保留）|

#### 进程清理

服务端 OpenCode 子进程的清理脚本：

```bash
bash scripts/stop.sh           # 停服务 + 清本项目内 OpenCode 子进程
bash scripts/restart_dev.sh    # dev 模式（含清理逻辑）
bash scripts/restart.sh        # 生产模式（含清理逻辑）
```

只杀 `<project>/node_modules/opencode-ai/bin/.opencode` 路径下 spawn 的进程，**不影响**用户机器上其它 OpenCode 实例（全局装的、TUI 单独跑的、其它项目的）。

---

## 九、配置说明

### `.env`（运行时配置）
```bash
# 数据库 — SQLite（默认）
DATABASE_URL="file:../data/witty_insight.db"

# 或 OpenGauss（可选，配置后自动切换）
# DB_HOST=
# DB_PORT=
# DB_NAME=postgres
# DB_USER=
# DB_PASSWORD=

# 企业模式
# ORG_MODE=true
# ORG_USERINFO_URL=
# ORG_LOGIN_REDIRECT_URL=

# 可选反代前缀（部署到子路径时）
# NEXT_PUBLIC_URL_PREFIX=/agent-insight
```

### `custom-models.json`（评测模型自定义）
参考 `custom-models.example.json`：定义 provider / API key / baseUrl / 默认模型，被 `lib/model-config.ts` 加载。

### `prisma/schema.prisma`
DB schema，10 张表（见上文 §四）。变更后需要 `npx prisma db push` + `npx prisma generate`。

### `data/`（运行时数据，已 gitignore）
- `witty_insight.db` —— 主 SQLite 库
- `storage/` —— Skill 文件资产（按 SkillVersion 存）
- `sessions/` —— Claude session 原始 JSON
- `evaluation_result.json` —— `/api/eval/evaluation` 写入的累积结果
- `flow_debug.jsonl`、`model_debug.jsonl` —— LLM 调试日志（dev）

---

## 十、开发与部署

### 启动 Dev Server
```bash
bash scripts/restart_dev.sh
# 默认端口 3000，访问 http://localhost:3000 → 自动跳转到 /trace
# 脚本会自动：
# - 创建 .env / data/ 目录
# - 释放占用的 3000 端口
# - 清掉 .next 缓存
# - 跑 prisma db push + generate
# - 启动 npm run dev (nohup)
# 日志输出到 server.log
```

### 启动 Prod Server
```bash
bash scripts/restart.sh
# 同上，但跑 npm run build + npm run start
```

### 数据库迁移
```bash
# 修改 prisma/schema.prisma 后
npx prisma db push          # 应用到 SQLite/OpenGauss
npx prisma generate          # 重新生成 client
```

### 构建 NPM 包发布
```bash
node scripts/publish-npm.js
```

### 数据导出 / 备份
- 主备份对象：`data/witty_insight.db`（SQLite）+ `data/storage/`
- 一致性快照：`sqlite3 data/witty_insight.db ".backup data/_export.db"`
- 见 `docs/PROJECT.md` § 八 关于 data/ 文件清单

### 切换分支查看 v1
```bash
# 请切换到历史分支查看 v1 源码
```

---

## 十一、相关文档索引

| 文档 | 内容 |
|---|---|
| `docs/PROJECT.md` | 本文档（项目总览） |
| `docs/guide/1-认识Skill-insight.md` | 项目愿景与定位（v1 视角） |
| `docs/guide/2-环境配置与安装.md` | 安装步骤 |
| `docs/guide/3-Skill生成.md` | 用 skill-generator 一键生成 Skill |
| `docs/guide/4-Skill评测.md` | 评测数据集与判断流程 |
| `docs/guide/5-Skill优化.md` | si-optimizer 自动优化 |
| `docs/guide/6-附录-FAQ.md` | 常见问题 |
| `docs/guide/7-附录-命令参考.md` | 全部 CLI / 终端命令清单 |
| `docs/auto-iterative-optimization.md` | iterative-optimizer 设计 |
| `docs/optimization-tech.md` | 优化技术细节 |
| `docs/plans/2026-04-28-opencode-otel-capture-design.md` | OpenCode OTel 采集设计 |
| `docs/plans/2026-04-28-opencode-otel-capture-implementation.md` | OTel 采集实现记录 |
| `exclude/design/skill-insight2agent-insight.md` | v2 战略文档（Skill-insight → Agent-insight） |
| `README.md` / `README_en.md` | 用户视角 README |

---

**最后更新**：2026-04-29  
**项目主页**：<https://gitcode.com/openeuler/witty-skill-insight>  
**反馈/Issue**：<https://atomgit.com/openeuler/witty-skill-insight/issues>
