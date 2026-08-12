# 标签化版本管理与版本分析 — 需求设计

> 文档类型：Phase2 需求设计 ｜ 关联 Phase1：[phase1-requirements-analysis.md](phase1-requirements-analysis.md)
> 创建时间：2026-07-06
> 状态：设计讨论稿，已根据需求对齐意见更新

## 导读

本设计把“标签定义”和“Trace 绑定”拆开建模：

- `Tag` 保存用户可维护的标签定义，区分 `version` 与 `business`。
- `ExecutionTag` 保存 Trace 与用户标签的多对多绑定。
- 系统标签不入库为 `Tag`，由 Trace 数据派生后只读展示。

高保真里提到 `Execution.testTags(JSON)`，但当前 `Execution` 模型没有该字段。考虑到筛选、聚合、删除清理、用户隔离和性能，本设计默认采用关系表作为主存储；API 可以返回 `testTags` 数组形状给前端使用。

## §1 设计决策

| 编号 | 决策 | 原因 / 代价 |
|-|-|-|
| D-001 | 用户标签定义使用独立 `Tag` 表 | 标签需要 CRUD、颜色、描述、类型和使用次数统计，独立表比塞进 `Execution` JSON 更清晰 |
| D-002 | Trace ↔ 用户标签绑定使用 `ExecutionTag` 关系表 | 用户标签筛选和版本聚合是核心路径，需要可索引查询；JSON 扫描会拖慢列表和聚合 |
| D-003 | 暂不新增 `Execution.testTags` 作为主存储 | 当前 schema 无此字段；若后续需要兼容外部导出，可做只读计算字段或冗余快照 |
| D-004 | 系统标签由读路径派生，不纳入 `Tag` 表 | 系统标签是事实，不应被用户编辑，也不参与版本分析 |
| D-005 | 版本分析只消费 `kind='version'` 的标签 | 防止业务筛选维度污染版本横轴 |
| D-006 | 标签和绑定均按 `user` 隔离 | 与现有 `Execution.user` 口径一致，避免跨用户看到或复用标签 |
| D-007 | 版本分析只统计 root Execution | 当前主列表也以 root Trace 为主要对象；MVP 固定使用 `isSubagent=false` 口径 |
| D-008 | 一条 Trace 允许绑定多个用户标签和多个版本标签 | 关系表天然支持多对多；同一 Trace 会进入其绑定的每个版本标签聚合 |
| D-009 | 删除标签采用硬删除 | `Tag` 删除时级联删除绑定关系；Trace 本体保留 |
| D-010 | 版本分析 MVP 不支持业务标签二次过滤 | 先保持版本横轴纯净；“只看某业务标签内的版本对比”作为未来潜在优化点 |
| D-011 | 单问题下钻按归一化后的 `Execution.query` 分组 | 当前没有统一 dataset item id；query 是现阶段最直接稳定的口径 |
| D-012 | 成功率不是现有存储字段 | 版本分析不新增 `successRate` 存储；若展示，只能从 Trace 状态派生“运行成功率” |

## §2 数据模型

### 2.1 Prisma 模型草案

```prisma
model Tag {
  id          String   @id @default(cuid())
  name        String
  description String?
  kind        String   // "version" | "business"
  color       String
  createdBy   String?
  user        String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  executionTags ExecutionTag[]

  @@unique([user, kind, name])
  @@index([user, kind, createdAt])
}

model ExecutionTag {
  id          String    @id @default(cuid())
  executionId String
  execution   Execution @relation(fields: [executionId], references: [id], onDelete: Cascade)
  tagId       String
  tag         Tag       @relation(fields: [tagId], references: [id], onDelete: Cascade)
  user        String?
  createdBy   String?
  createdAt   DateTime  @default(now())

  @@unique([executionId, tagId])
  @@index([tagId, createdAt])
  @@index([executionId])
  @@index([user, tagId])
}
```

`Execution` 需要增加反向关系：

```prisma
executionTags ExecutionTag[]
```

### 2.2 与现有字段的关系

| 现有字段 | 处理方式 |
|-|-|
| `Execution.label` | 保留旧语义，不迁移为新标签体系的主存储 |
| `Execution.skillVersion` / `SkillVersion` | 与本需求无直接关系；这是 Skill 自身版本，不是运行 cohort 版本 |
| `Execution.answerScore` | 版本分析准确率的数据源 |
| `Execution.tokens/inputTokens/outputTokens` | 版本分析 Token 指标的数据源 |
| `Execution.latency` | 版本分析时延指标的数据源 |
| `Execution.cost` | 版本分析成本指标的数据源 |
| `Execution.isSubagent/rootExecutionId` | 默认过滤 `isSubagent=false`，保持 root Trace 口径 |

## §3 API 设计

### 3.1 标签 CRUD

建议路径：

| 方法 | 路径 | 说明 |
|-|-|-|
| GET | `/api/tags?kind=version|business` | 列出当前用户的标签；返回 usage count 与必要聚合摘要 |
| POST | `/api/tags` | 创建标签 |
| PUT | `/api/tags/[id]` | 更新名称、描述、颜色、类型 |
| DELETE | `/api/tags/[id]` | 删除标签，并级联删除绑定 |

请求字段：

```ts
type TagPayload = {
  name: string;
  description?: string;
  kind: 'version' | 'business';
  color: string;
};
```

响应字段：

```ts
type TagDto = {
  id: string;
  name: string;
  description: string | null;
  kind: 'version' | 'business';
  color: string;
  createdBy: string | null;
  createdAt: string;
  usageCount: number;
};
```

### 3.2 Trace 标签绑定

建议路径优先贴合现有 observe API：

| 方法 | 路径 | 说明 |
|-|-|-|
| GET | `/api/observe/executions/[executionId]/tags` | 获取某条 Trace 的用户标签 |
| PUT | `/api/observe/executions/[executionId]/tags` | 用完整 tagId 列表替换绑定 |
| POST | `/api/observe/executions/[executionId]/tags` | 增量添加一个或多个标签 |
| DELETE | `/api/observe/executions/[executionId]/tags?tagId=...` | 移除单个标签 |

高保真里的 `/api/trace/{id}/tags` 可作为语义参考；实际实现建议挂在现有 `/api/observe/executions` 下，避免新增第二套 Trace 命名。

### 3.3 链路追踪查询扩展

现有 `/api/observe/data` 支持筛选、轻量字段和 facet。新增能力建议复用该入口：

| 参数 / 过滤列 | 说明 |
|-|-|
| `tagIds=<id,...>` | 按最多 20 个版本/业务标签筛选；多个标签采用 AND 语义 |
| `bizTag=<tagId,...>` | 兼容旧业务标签 OR 筛选；与 `tagIds` 同时存在时忽略 |
| `filters=[...]` 中新增 `businessTag` | 统一过滤器形态，和现有筛选栏一致 |
| `includeTags=1` | 返回每条 Trace 的用户标签和系统标签 |
| `facet=tags&kind=business|version` | 按类型返回用户标签及使用次数；Trace 页也可通过 `/api/tags` 一次读取两类标签 |

返回给前端的 Trace 行可增加：

```ts
type TraceTagView = {
  systemTags: Array<{ key: string; label: string; source: 'derived' }>;
  userTags: Array<{ id: string; name: string; kind: 'version' | 'business'; color: string }>;
};
```

### 3.4 版本分析 API

为避免与 Skill 版本接口混淆，建议使用 observe 语义命名：

| 方法 | 路径 | 说明 |
|-|-|-|
| GET | `/api/observe/version-analysis/compare` | 返回版本对比数据 |
| GET | `/api/observe/version-analysis/tags/[tagId]/traces` | 返回某版本标签下 Trace 明细 |

`compare` 参数：

```ts
type VersionCompareQuery = {
  user: string;
  agent?: string;
  framework?: string;
  from?: string;
  to?: string;
  questionKey?: string; // 仅用于版本对比区单问题下钻；顶部总览仍按全局时间窗口/Agent/框架统计
};
```

`compare` 返回：

```ts
type VersionCompareResponse = {
  summary: {
    versionTagCount: number;
    traceCount: number; // de-duplicated root Trace count under user/agent/framework/time-window
    answerScoreAvg: number | null;
    answerScoreCoverage: number;
    runSuccessRate: number | null;
    avgTokens: number | null;
    p95LatencySec: number | null;
    avgCost: number | null;
  };
  versions: Array<{
    tag: TagDto;
    traceCount: number;
    answerScoreAvg: number | null;
    answerScoreCoverage: number;
    runSuccessRate: number | null; // derived from trace status; optional/P1 metric, not a stored field
    avgTokens: number | null;
    p95LatencySec: number | null;
    avgCost: number | null;
  }>;
  questions: Array<{
    key: string;
    label: string;
    category?: string;
    traceCount: number;
  }>;
};
```

## §4 页面设计

### 4.1 版本管理

位置：配置组新增“版本管理”。

模块：

- 顶部主按钮“新建标签”。
- “版本标签”分区：卡片展示名称、描述、颜色、Trace 数、准确率、平均 Token 等摘要。
- “业务标签”分区：卡片展示名称、描述、颜色、Trace 数、创建信息。
- 新建/编辑弹窗：标签类型、名称、描述、颜色。
- 删除确认：提示删除会移除所有 Trace 绑定。

### 4.2 链路追踪

改造点：

- 用户标签列默认展示，包含版本标签和业务标签。
- 系统标签列可开启，默认隐藏。
- 列配置菜单支持 Trace ID、Agent、状态、系统标签、用户标签、问题、Token、时间等列显隐。
- 标签添加控件分组展示版本标签和业务标签。
- 用户标签筛选同时展示版本标签和业务标签；先按类型分区，再按名称前缀聚类，支持最多 20 个标签混选并以 AND 语义筛选。
- 标签删除在 chip 上直接操作，但需要避免误触，可采用 hover 后显示删除按钮。

系统标签派生规则建议：

| 系统标签 | 派生来源 |
|-|-|
| Multi-Agent | `observedAgents` 多于一个，或存在 sub-agent 关系 |
| Skills | `ExecutionSkill` / `invokedSkills` 非空 |
| SUB | `isSubagent=true` 或当前行代表 sub-agent |
| 框架名 | `Execution.framework` 标准化后的显示名 |

### 4.3 版本分析

位置：观测组新增或改造“版本分析”。

顶部上下文：

- Agent / 框架筛选。
- 时间窗口：近 1 小时、近 1 天、近 7 天、近 30 天。
- 导出当前数据。
- MVP 不提供业务标签过滤；后续可增加“在某业务标签集合内做版本对比”。

Tab 1：版本对比

- 左侧对比对象：全部问题聚合 + 单问题列表。
- 主图：横轴是版本标签，按 `Tag.name` 字符串排序。
- 指标切换：准确率、Token、时延、成本。
- 明细表：版本标签、说明、Trace 数、准确率、平均 Token、p95 时延、单次成本；运行成功率如保留，需标注其由 Trace 状态派生。

Tab 2：版本详情

- 选择一个版本标签。
- KPI：Trace 数、准确率、平均 Token、p95 时延、单次成本；运行成功率作为 P1 派生指标处理。
- 趋势图：横轴为该版本内每条 Trace，按时间排序；红点标失败 Trace，虚线为均值。
- 覆盖问题：按准确率排序，只读展示；版本详情页不提供单问题点击过滤，单问题下钻只在版本对比页进行。
- Trace 明细：点击跳转链路追踪详情。

## §5 聚合算法

### 5.1 查询范围

版本分析基础 where 条件：

- `Execution.user = currentUser`
- `Execution.isSubagent = false`
- 命中 `ExecutionTag.tag.kind = 'version'`
- 命中页面的 Agent / framework / 时间窗口过滤

业务标签不参与版本分析。MVP 不提供“只看某业务标签内的版本对比”；该能力记录为未来潜在优化点，后续如实现也只能作为额外过滤器，不能作为版本横轴。

### 5.2 版本排序

版本横轴按 `Tag.name.localeCompare` 字符串排序，而不是按创建时间或语义版本排序。这样符合高保真要求，也避免猜测 `v1.10` 与 `v1.9` 的业务含义。

### 5.3 指标计算

| 指标 | 计算 |
|-|-|
| `traceCount` | 版本标签下命中的 root Trace 数 |
| `answerScoreAvg` | 非空 `answerScore` 均值 |
| `answerScoreCoverage` | 有 `answerScore` 的 Trace 数 / 总 Trace 数 |
| `runSuccessRate` | 可选/P1：成功终态 Trace 数 / 终态 Trace 数，成功判定复用 Trace 列表状态口径；当前没有独立 `successRate` 存储字段 |
| `avgTokens` | `tokens` 均值；缺失时可由 `inputTokens + outputTokens` 兜底 |
| `p95LatencySec` | `latency` p95 |
| `avgCost` | `cost` 均值 |

### 5.4 单问题下钻

MVP 默认以归一化后的 `Execution.query` 作为问题 key：

- trim 空白；
- 多空格合一；
- 保留原文作为显示 label。

风险：同义改写或同一数据集题目不同表达会被拆成多个问题。后续如果接入评测数据集，应优先使用 dataset item id 或 evaluation run case id。

## §6 风险与缓解

| 风险 | 影响 | 缓解 |
|-|-|-|
| 一条 Trace 被打多个版本标签 | 同一 Trace 会进入多个版本聚合，可能误读 | 这是已确认允许的行为；UI 需要在打标或分析页提示聚合口径 |
| JSON 存储导致筛选慢 | Trace 列表和版本分析性能差 | 采用 `ExecutionTag` 关系表和索引 |
| 历史 Trace 无标签 | 版本分析初期为空 | 版本分析空态引导用户先去 Trace 列表打标签 |
| `answerScore` 覆盖不足 | 准确率波动或不可比 | 展示覆盖率；低覆盖时降级提示 |
| Trace 失败状态口径不稳定 | 派生运行成功率可能被误读为质量成功率 | MVP 可不展示成功率；如展示必须命名为“运行成功率”并说明来自 Trace 状态 |
| 与 Skill 版本概念混淆 | 用户以为这是 SkillVersion | 页面文案强调“版本标签是 Trace 分组，不是 Skill 文件版本” |
| 删除标签影响历史分析 | 聚合横轴消失 | 删除确认明确影响；可后续增加归档状态替代硬删 |

## §7 文档影响

后续实现如果改变用户可见流程，需要更新：

- `docs/user-guide/observability/view-traces.md`
- `docs/user-guide/observability/index.md`
- 可能新增或更新版本分析/版本管理相关用户指南

如果新增 Prisma schema、API 和数据流，需要更新：

- `docs/developer-guide/04-api-and-contracts.md`
- `docs/developer-guide/05-data-and-control-flow.md`
- `docs/developer-guide/06-frontend.md`
- 如涉及设计系统 token，再更新 `08-design-system.md` 与 `design-tokens.json`

## 变更记录

### v0.1（2026-07-06）

- 根据 Phase1 与高保真整理数据模型、API、页面交互、聚合口径和风险。
