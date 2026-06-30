# 链路追踪搜索/过滤改造 —— 对齐 langfuse 的 operator 模型

> 状态:设计中(分支 `feat/langfuse-style-search`)
> 范围:`/trace` 链路追踪列表的搜索与过滤能力
> 目标读者:agent / 维护者

---

## 1. 背景与目标

agent-insight 的「链路追踪」(`/trace`)目前只有 7 个**精确匹配的下拉选择器**,没有任何文本搜索框,无法「按名称搜索目标 agent/skill」,也没有数值/时间区间过滤。除 skill 外的过滤全部在**前端内存**完成(先一次性拉全量轻量记录,再 filter/sort/分页)。

langfuse 在同类「trace 列表」上提供了一套成熟的**按字段类型驱动操作符(type → operator)**的过滤模型:低基数字符串字段给模糊搜索(`contains`/`starts with`/`ends with`),数值/时间字段给区间(`>=`…`<=`),枚举/数组字段给多选(`any of`/`none of`/`all of`),大字段(input/output)给令牌级全文搜索(`matches`)。

**本设计目标**:把 agent-insight 的链路追踪过滤从「一堆手写的精确下拉 + 前端内存过滤」升级为「**统一的 operator 模型 + 后端下推(Prisma where)+ 服务端分页**」,首先补齐最缺的**名称模糊搜索**与**数值/时间区间**。

**非目标**(本期不做):自然语言过滤、保存的过滤预设、跨 input/output 大字段的全文索引(agent-insight 用 SQLite,无 ClickHouse FTS 等价物;留作后期)。

---

## 2. 参照:langfuse 的搜索能力(现状速记)

langfuse 的「搜索」= **全文搜索** + **结构化过滤器**两层,外加一层自然语言入口。核心是结构化过滤器按 filter type 决定可用操作符(源:`langfuse/packages/shared/src/interfaces/filters.ts`):

| Filter type | 操作符 | 语义 |
|---|---|---|
| `string` | `=`, `contains`, `does not contain`, `starts with`, `ends with` | 模糊(子串/前后缀) |
| `stringObject`(如 metadata.key) | 同 string + `matches` | 模糊 + 令牌 |
| `number` | `=`, `>`, `<`, `>=`, `<=` | 区间 |
| `numberObject` | `=`, `>`, `<`, `>=`, `<=` | 区间(对象数值) |
| `datetime` | `>`, `<`, `>=`, `<=` | 时间区间 |
| `stringOptions` | `any of`, `none of` | 枚举多选 |
| `categoryOptions` | `any of`, `none of` | 分类多选 |
| `arrayOptions`(如 tags) | `any of`, `none of`, `all of` | 数组包含 |
| `boolean` | `=`, `<>` | 布尔 |
| `null` | `is null`, `is not null` | 空值判定 |

补充:
- **全文搜索(2026-05,ClickHouse fast mode)**覆盖 input/output/string-metadata,新增 `matches`(令牌级、走文本索引、大小写不敏感);在 input/output 上**拒绝** `contains`/`starts with`/`ends with`(全量扫描太慢,返回 400),只能用 `matches`。
- **自然语言过滤(Cloud beta)**把英文描述经 AWS Bedrock 翻译成上面的结构化过滤器,只是入口糖,底座仍是 type→operator。
- 过滤器之间 **AND** 组合,JSON 结构 `{ type, column, key?, operator, value }`。

来源:
- https://langfuse.com/changelog/2026-05-27-clickhouse-full-text-search-fast-mode
- https://langfuse.com/changelog/2025-11-03-advanced-filtering-traces-and-observations-api
- https://langfuse.com/changelog/2025-09-30-natural-language-filters
- https://github.com/langfuse/langfuse/blob/main/packages/shared/src/interfaces/filters.ts

---

## 2.5 langfuse 实际实现剖析（源码级 ground truth）

> 读 langfuse 源码 `web/src/features/search-bar/`（~11k LOC，README 即设计规范）+ `packages/shared/src/interfaces/filters.ts`。这一节是后面方案的依据——**我们要抄的是它的架构,不是它的 UI 控件**。

### 2.5.1 架构主旨：一个 FilterState，两个编辑器

那个带 `field:value` 自动补全的搜索框，本质是一个**文法驱动的 query 编辑器**，它**不替代** facet 侧栏。两者都是对**同一份 `FilterState`（URL 上的单一真实源）**的 controlled editor，互相自动同步：

```
URL filter state (FilterState + searchQuery/searchType)   ← 单一真实源
   │  filterStateToQueryText（纯函数，导出）
   ▼
committedText ──resetTo──▶ draft ──(输入/选/删)──▶ draft
   ▲                                               │ planCommit（纯：validate+lower）
   └──────── setFilterState ◀── commit() ◀─────────┘
```

committed text 永远**从源导出、不另存**；唯一持久本地态是 draft；**唯一一个 effect**（committed 变了就 resetTo），不回写，故不会环。

### 2.5.2 front half / back half 分离（最关键的可借鉴点）

langfuse 有 ~15 个可过滤视图，**全部**跑同一条管线：

```
ColumnDefinition[]   →   flat FilterState (singleFilter)   →   createFilterFromFilterState → ClickHouse
  ↑ 每视图（front half）       ↑ 全视图共享（back half：lowering / URL 契约 / facet 侧栏）
```

搜索栏的 adapter **吐的就是同一份 `FilterState`**（README:312「adapter 绝不吐 sidebar 产不出的 filter 形状」）。所以**每加一个视图只 fork front half（field 注册表 + 文法 + 值校验）**，back half 全免费复用。

**→ 对 agent-insight 的直接含义**:我们**没有这个 back half**（现在是手写散过滤）。所以 langfuse 那个炫的搜索栏对我们不是「先做 UI」——**必须先把 back half 建起来**（列注册表 → 统一 FilterState/Clause → 统一 lowering 到 Prisma）。这正是本文 §5 的 operator 模型。搜索栏是后续叠在上面的 front half。

### 2.5.3 文法规范（AST CompareOp = `= | exact | ~ | ^ | $ | > | < | >= | <=`）

| 语法 | 含义 |
|---|---|
| `level:(ERROR OR WARNING)` | any-of |
| `-env:dev` | none-of（否定） |
| `tags:(a AND b)` | 数组 all-of |
| `latency:>2`、`startTime:>2026-06-01` | 区间比较 |
| `name:*chat*` / `chat*` / `*chat` / `chat`(bare) / `:=chat` | contains / starts / ends / contains 默认 / exact |
| `metadata.region:eu`、`scores.accuracy:>0.8` | dot-path 动态字段 |
| `has:endTime` / `-has:endTime` | null 判定 |
| 裸文本 `refund policy` | 全文检索（id + content 双 lane） |

### 2.5.4 field 注册表 entry 形状（`lib/fields.ts`，我们的列注册表对标这个）

```ts
interface FieldDef {
  id: string;            // canonical 列名（latency / level / name）
  aliases: string[];     // 小写别名（env→environment, ttft…）
  kind: 'text' | 'number' | 'datetime' | 'boolean';
  syncMode: 'textSearch'   // 裸值 = contains 搜索（name/id/input/output）
          | 'exactOption'  // 裸值 = 精确 any-of（level/type）
          | 'arrayOption'; // 数组 any-of/all-of（tags）
  unit?: string;         // 数值建议的单位标签（latency 's' / cost '$'）
  nullable?: boolean;    // 是否支持 has: / -has:
  suggestObservedValues?: boolean; // textSearch 上仍给观测值下拉
}
// 动态：metadata.<key> / scores.<name> / traceScores.<name> 经 resolveField() 解析
```

### 2.5.5 operator 妥当性表（kind × op，决定 UI 给哪些操作符 + commit 校验）

| 字段 kind | `=`(bare) | `exact` | `~`contains | `^`starts | `$`ends | `> < >= <=` |
|---|---|---|---|---|---|---|
| text/textSearch | ✓ contains | ✓ exact | ✓ | ✓ | ✓ | ✗ |
| text/exactOption | ✓ any-of | ✓ any-of | ✗ | ✗ | ✗ | ✗ |
| text/arrayOption | ✓ any-of(+AND) | ✓ any-of | ✗ | ✗ | ✗ | ✗ |
| number | ✓ `=` | ✓ `=` | ✗ | ✗ | ✗ | ✓ |
| datetime | ✗ 用 `>`/`<` | ✗ | ✗ | ✗ | ✗ | ✓ only |
| boolean | ✓ true/false | ✓ | ✗ | ✗ | ✗ | ✗ |
| metadata(stringObject) | ✓ exact | ✗ | ✓ | ✓ | ✓ | ✗ |
| scores 数值(numberObject) | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ |
| scores 分类(categoryOptions) | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |

### 2.5.6 AST → FilterState lowering（`lib/adapter.ts`）摘要

- text/textSearch:`=` 单值→`string contains`；多值→`stringOptions any of`；`exact` 单值→`string =`；`~`→`string contains`；`^`/`$`→`starts/ends with`。
- text/exactOption:`=`/`exact`→`stringOptions any of`，**否定→`none of`**。
- text/arrayOption:`=`→`arrayOptions any of`；`(a AND b)`→`arrayOptions all of`。
- number:`=`→`number =`；`>`→`number >`，**否定 `-x:>2` 折叠成 `<=`**（反向表）。
- datetime:仅 `>/</>=/<=`，否定反向。
- metadata:`stringObject` 带 `key`；scores:按观测 score 类型路由 `numberObject(scores_avg)` 或 `categoryOptions(score_categories)`。
- `has:field`→`null is not null`；`-has:field`→`null is null`。
- **否定不是 primitive**:lower 到逆 operator（`none of`/`does not contain`/`is null`/翻比较）；无原生逆的→commit 阻断诊断（backend 无通用 NOT）。

### 2.5.7 自动补全 & facet 件数（那个 `36961` 的出处）

- **FIELDS 列表**:`fieldOptions()` 从 `FIELDS` 注册表生成 + 虚拟字段（`metadata.`/`scores.`/`has`）。
- **SUGGESTIONS（带件数）**:来自 tRPC `filterOptions` payload → `observed-options.ts` 映射成 `Record<column, {value, count}[]>`。即**每列的观测值 + 出现次数**（score 列还拆 name × per-name 值）。**agent-insight 已有同型 seam**:`/api/observe/data?facet=skills`（`listObservedSkills`）就是这个的雏形,扩成「每列 facet 计数」即可。

### 2.5.8 invariants（移植时别破坏）

1. **无无言 drop/rewrite**:每个 filter 要么渲染、要么 `skippedFilters` 原样保全、要么 commit 阻断诊断。
2. **validate ↔ lower 同步**:红态门与 commit 门必须同一套 lower 逻辑（否则 Enter 静默无效）。
3. **否定靠逆 operator**，非 primitive。
4. **FilterState ⇄ text round-trip property test**:fields × operators × 对抗值的确定性矩阵（几乎所有正确性 bug 都落在这个边界）。

来源（源码）:`web/src/features/search-bar/{README.md, lib/{ast,fields,adapter,completions,observed-options,filter-state-to-query,langQ}.ts}`。

---

## 3. agent-insight 链路追踪现状

### 3.1 关键文件

| 作用 | 文件 | 关键位置 |
|---|---|---|
| 列表 UI(`TracePageContent`)+ 详情(`TraceDetailView`) | `src/app/(main)/trace/page.tsx` | 列表 329-771;前端内存过滤 `useMemo` ~447-500 |
| 后端 API(GET/DELETE/PATCH) | `src/app/api/observe/data/route.ts` | GET handler 283-492 |
| 数据服务(过滤构建)| `src/lib/storage/data-service.ts` | `ReadRecordFilters` 1111-1126;`readRecordsInternal` ~1597-1725 |
| Execution(trace)模型 | `prisma/schema.prisma` | 59-123 |
| ExecutionSkill 反查索引 | `prisma/schema.prisma` | 158-171 |

### 3.2 当前过滤能力(7 个下拉,全精确匹配)

| 维度 | 类型 | 操作符 | 在哪过滤 |
|---|---|---|---|
| Ownership(user/system/all)| 枚举 | `=` | 后端 |
| Agent | 枚举 | `=` | 前端内存(从 `observedAgents` JSON 还原) |
| Skill | 枚举 | `=`(+version)| **后端**(ExecutionSkill `(skillName, skillVersion)` 反查) |
| Status(running/success/failed)| 枚举 | `=` | 前端(由 session.endTime 推) |
| Time Range | 固定窗口 | `1h/3h/24h/7d/30d/all` | 前端 |
| Framework | 枚举 | `=` | 前端 |
| Scope(root/subagent/all)| 枚举 | `=` | 后端(`isSubagent`) |

### 3.3 三个事实(已核对源码)

1. **没有任何搜索输入框**:`page.tsx` 内无 `<input>`/search 组件;名称只能下拉枚举精确选。
2. **后端 `query` 是精确匹配**:`data-service.ts:1667` `where.query = filters.query`(非 `contains`)。该参数已存在但未接 UI——是天然的接入点。
3. **「拉全量 + 前端内存过滤/分页」**:`fields=light` 返回所有匹配记录,前端再 filter/sort/slice。无服务端分页、无 `count`。

### 3.4 可被搜索/过滤的字段(Execution 模型,已核对 `schema.prisma:59-123`)

- **字符串(可模糊)**:`query`、`agentName`、`subagentName`、`model`、`label`、`framework`
- **数值(可区间)**:`tokens`、`inputTokens`、`outputTokens`、`cost`、`latency`、`toolCallCount`、`toolCallErrorCount`、`llmCallCount`、`answerScore`、`skillScore`、`skillTriggerRate`
- **时间(可区间)**:`timestamp`(已建索引 `@@index([isSubagent, timestamp])`)
- **布尔**:`isAnswerCorrect`、`isSkillCorrect`、`isSubagent`
- **数组/多选**:`skills`/`invokedSkills`(JSON;真正可索引的是 `ExecutionSkill` 表)、`observedAgents`(JSON,agent 多选)、`label`(可当 tag)
- **枚举**:`framework`、`subagentType`、计算字段 `agentOwnership`、`trace_status`

---

## 4. 差距小结

| langfuse | agent-insight | 缺口 |
|---|---|---|
| 全文搜索框 | 无搜索框 | **名称/文本模糊搜索完全缺失** |
| string `contains`/前后缀 | 下拉 `=` | 模糊搜索缺失 |
| number `>=`…`<=` | 无 | 数值区间缺失(字段都在) |
| datetime 任意区间 | 仅固定窗口 | 自定义起止缺失 |
| array `any of`/`all of` | 无 | 标签/多 agent 多选缺失 |
| type→operator 抽象 | 每个 filter 手写 | 无统一模型,加一种过滤=改前后端多处 |
| 服务端分页 | 前端内存分页 | 过滤越丰富越拖垮(数据量) |

---

## 5. 改造方案

整体思路:**先立模型(type→operator),再立翻译层(filter → Prisma where),最后改数据流(下推 + 服务端分页),UI 用一个数据驱动的通用 FilterBar 承载。**

### 5.1 operator 模型(精简自 langfuse)

新增共享类型(建议 `src/lib/filters/types.ts`),只保留 agent-insight 当下需要的子集:

```ts
export type FilterType =
  | 'string'        // = | contains | does not contain | starts with | ends with
  | 'number'        // = | > | < | >= | <=
  | 'datetime'      // > | < | >= | <=
  | 'stringOptions' // any of | none of            (单字段枚举多选)
  | 'arrayOptions'  // any of | none of | all of    (JSON 数组 / 关联表)
  | 'boolean';      // =

export type Operator =
  | '=' | 'contains' | 'does not contain' | 'starts with' | 'ends with'
  | '>' | '<' | '>=' | '<='
  | 'any of' | 'none of' | 'all of';

export const OPERATORS_BY_TYPE: Record<FilterType, Operator[]> = {
  string:        ['=', 'contains', 'does not contain', 'starts with', 'ends with'],
  number:        ['=', '>', '<', '>=', '<='],
  datetime:      ['>', '<', '>=', '<='],
  stringOptions: ['any of', 'none of'],
  arrayOptions:  ['any of', 'none of', 'all of'],
  boolean:       ['='],
};

export interface FilterClause {
  type: FilterType;
  column: string;        // 逻辑列名(见 5.2 列注册表)
  operator: Operator;
  value: string | number | boolean | string[]; // any of/all of 用数组
}
// 多个 clause 之间 AND 组合(本期不做 OR,够用)。
```

**列注册表**(单一事实源,前后端共用):把每个可过滤列声明为 `{ column, type, label, source }`,前端据此渲染操作符下拉与输入控件,后端据此校验 + 翻译。例:

```ts
export const TRACE_FILTER_COLUMNS = [
  { column: 'query',      type: 'string',        label: '查询内容' },
  { column: 'agentName',  type: 'string',        label: 'Agent 名' },
  { column: 'framework',  type: 'stringOptions', label: '框架' },
  { column: 'timestamp',  type: 'datetime',      label: '时间' },
  { column: 'latency',    type: 'number',        label: '耗时(ms)' },
  { column: 'tokens',     type: 'number',        label: 'Tokens' },
  { column: 'cost',       type: 'number',        label: '成本' },
  { column: 'answerScore',type: 'number',        label: '答案分' },
  { column: 'status',     type: 'stringOptions', label: '状态', source: 'computed' },
  { column: 'ownership',  type: 'stringOptions', label: '归属', source: 'computed' },
  { column: 'skill',      type: 'arrayOptions',  label: 'Skill', source: 'executionSkill' },
  { column: 'agents',     type: 'arrayOptions',  label: 'Agent(多选)', source: 'observedAgents' },
  // boolean: isAnswerCorrect / isSkillCorrect / isSubagent ...
] as const;
```

> **对齐 langfuse FieldDef**:`FilterClause` ≈ langfuse 的 `singleFilter`，列注册表 ≈ `FIELDS`。为了将来 Phase 4 文法栏便宜，列注册表从一开始就多带两个字段：`syncMode`（`textSearch` 裸值=contains / `exactOption` 裸值=精确 any-of / `arrayOption`）和 `nullable`（是否支持 `has:`）。Phase 1 的下拉/区间 UI 暂时用不到它们，但它们是 front half 的输入——别等到 Phase 4 再回填。string 类型实际要拆出 `~`contains/`^`starts/`$`ends/`exact` 四个细操作符（见 §2.5.5 妥当性表），Phase 1 先实现 `contains`+`=` 两个够用，其余在 Phase 3/4 补齐。

### 5.2 后端:filter → Prisma `where` 翻译层

新增 `buildPrismaWhere(clauses, ctx)`(建议 `src/lib/filters/to-prisma.ts`),把 `FilterClause[]` 翻成 Prisma `where`,**取代** `readRecordsInternal` 里现在零散的 if 串(`data-service.ts:1631-1669` 那段)。映射规则:

| type / operator | Prisma 片段 |
|---|---|
| string `contains` | `{ [col]: { contains: v } }` |
| string `does not contain` | `{ NOT: { [col]: { contains: v } } }` |
| string `starts with` / `ends with` | `{ [col]: { startsWith / endsWith: v } }` |
| string `=` | `{ [col]: v }` |
| number/datetime `>=`/`<=`/`>`/`<`/`=` | `{ [col]: { gte/lte/gt/lt/equals: v } }` |
| stringOptions `any of` / `none of` | `{ [col]: { in: v[] } }` / `{ [col]: { notIn: v[] } }` |
| boolean `=` | `{ [col]: { equals: v } }` |
| arrayOptions(skill)| 沿用现有 `ExecutionSkill` 反查 → `where.id = { in: [...] }`(已是这套,见 `data-service.ts:1671-1679`) |
| arrayOptions(agents,JSON)| SQLite 无 JSON 数组关系查询 → `observedAgents: { contains: '"name"' }`(降级子串)或后续建 `ExecutionAgent` 反查表 |

**计算列**(`status`、`ownership`)不在 Execution 表里:翻译层把它们映射成等价的真实列条件(如 status=success → 由 session.endTime 推导的等价表达,沿用现有推导逻辑),或保留在前端二次过滤——本期可先让计算列仍走前端,真实列全部下推。

### 5.3 数据流:服务端分页 + count

把 `readRecordsInternal` 从「返回全部」改为接收 `{ where, orderBy, skip, take }` 并同时返回 `count`(`prisma.execution.count({ where })`)。API `GET /api/observe/data` 增加 `page`/`pageSize`/`filters`(JSON)/`sort`/`dir`,前端不再内存 slice。**排序**(timestamp/agent/status/latency/tokens/cost)同步下推为 Prisma `orderBy`(agent/status 这类计算/JSON 列暂留前端或后续 denorm)。

> 兼容:`fields=light` 保留;旧的 `skill`/`framework`/`onlySubagents` 等单参数入口保留一段时间(内部转成 `FilterClause`),避免一次性破坏现有调用方。

### 5.4 前端:通用 FilterBar + 快捷搜索框

- **快捷搜索框**(最高优先,见 6 期 Phase 0):列表顶部一个输入框 → 生成 `{type:'string', column:'query', operator:'contains', value}`(可同时 OR 到 `agentName`,本期先只打 `query` 保持 AND 语义简单),下推后端。对标 langfuse 顶部 quick search。
- **通用 FilterBar**:数据驱动——选列(来自 `TRACE_FILTER_COLUMNS`)→ 选操作符(来自 `OPERATORS_BY_TYPE[type]`)→ 按 type 渲染值控件(string=文本框、number=数字框/双框区间、datetime=日期范围、Options=多选下拉)。现有 7 个下拉迁移成该模型的预置 clause。
- 过滤状态继续用 `nuqs` URL 持久化(把 `FilterClause[]` 序列化进 query string)。

### 5.5 SQLite / Prisma 注意点

- **大小写**:Prisma 在 **SQLite 上不支持 `mode:'insensitive'`**;但 SQLite `LIKE`(即 Prisma `contains`)对 **ASCII** 默认大小写不敏感,中文无大小写概念,故名称/中文查询天然 OK,纯英文 agent 名也 OK。不要写 `mode:'insensitive'`(SQLite 会报错)。
- **JSON 字段**:`observedAgents`/`skills` 是 JSON 字符串,SQLite + Prisma 无法做数组成员关系查询;agents 多选本期用 `contains '"name"'` 子串降级,或参照 `ExecutionSkill` 建一张 `ExecutionAgent` 反查表(更干净,二期)。
- **索引**:`timestamp` 已索引;若数值区间过滤成为热点,给 `latency`/`tokens`/`cost` 视情况补索引。`query`/`agentName` 的 `contains` 是 `LIKE '%v%'` 走不了 B-tree 索引,数据量大时为已知慢点(SQLite 无 FTS 接入前的可接受代价;真要快需 FTS5 虚拟表,列为后期)。

---

## 6. 分期落地

| 期 | 内容 | 价值 / 验证 |
|---|---|---|
| **Phase 0(最小切口)✅ 已落地+验证** | 顶部加**文本搜索框**(debounce 300ms→URL `q`);后端 `query` 从 `=` 改 `contains`,对 **input(`query`)+ output(`finalResult`)** 两列 OR 下推 Prisma(对齐 Langfuse input/output 搜索语义) | 立刻能「按内容模糊搜索」;改动面小,已验证下推链路。**验证**:直连 home DB(128 root,`system`→4)+ 真实 API 路由(user 作用域 60→`system` 1 / `SYSTEM` 1 大小写不敏感 / 乱码→0);tsc 净、`/trace` 编译 200 |
| **Phase 1（back half · 模型）** | 落 `FilterType`/`Operator`/`OPERATORS_BY_TYPE`（对标 langfuse FieldDef.kind + operator 妥当性表）+ `TRACE_FILTER_COLUMNS` 列注册表（对标 `FIELDS`）+ `buildPrismaWhere` 翻译层（对标 adapter→FilterState→SQL）;现有 7 下拉接进模型(真实列下推、计算列暂留前端) | **这是 langfuse 的「back half」**:统一抽象;加一种过滤=注册一列。后续 front half 全靠它 |
| **Phase 2（数据流）** | `readRecordsInternal` 服务端分页 + `count`;排序下推;API 增 `page/pageSize/filters/sort` | 解决「数据量越大越拖垮」;去掉前端内存分页 |
| **Phase 3（结构化过滤 UI + facet）🟡 v1 已落地** | click 驱动过滤栏 `TraceFilterBar`(点「+过滤」→选字段→选操作符/值→chip);**facet 计数端点已建**(`facet=values&column=`→观测值+count,白名单 framework/agentName/model/subagentType);后端收 `filters=<JSON FilterClause[]>` 经 `buildPrismaWhere` 下推。**待补**:数值/时间区间双值控件、agents 多选(`ExecutionAgent` 反查表对称 `ExecutionSkill`)、现有 7 下拉收编进栏 | 对齐 langfuse 区间/多选 + 那个带件数的下拉。**验证**:facet(framework opencode34/direct-llm19/jiuwen7=60)+ clause 下推(any of/none of/contains/AND/非法兜底)真实 API 全过;tsc+eslint 净;`/trace` 编译 200 |
| **Phase 4（front half · 文法搜索栏）** | `field:value` 文法栏(用户要的「按 fields 选」):`langQ` 解析器 + `ast` + `adapter`(AST→FilterClause) + `filterClauseToQueryText`(反向导出) + `completions`(FIELDS+SUGGESTIONS,吃 Phase 3 的 facet) + **round-trip property test**;与 Phase 3 的结构化 UI 共享同一 FilterClause(两个编辑器一个真实源) | 复刻 langfuse 搜索栏;**只可能在 back half(P1)+facet(P3)就位后**才便宜 |
| **后期(可选)** | SQLite FTS5 全文(input/output 大字段,对标 `matches`)、保存的视图、否定/分组扩展、自然语言入口(对标 `searchBar.generateFilter`,prompt 由列注册表生成) | 性能/体验增强,非必需 |

---

## 7. 风险与开放问题

- **计算列下推**:`status`(由 session.endTime 推)、`ownership`(由 RegisteredAgent 推)、`agent`(JSON 还原)不是 Execution 列,纯下推需要 denorm 或等价 SQL。**决策**:本期这三者保留前端二次过滤,真实列全部下推;若后续要服务端分页严格正确,需把它们落成真实列(写入侧 denorm)。
- **AND-only**:本期 clause 间只支持 AND,够覆盖现状;OR/分组留后期。
- **向后兼容**:`/api/observe/data` 现有单参数(`skill`/`framework`/`onlySubagents`/`query`…)调用方多,迁移期内部转 `FilterClause`,不一次性删旧入口。
- **agents 多选**:JSON 子串降级 vs 新建 `ExecutionAgent` 反查表的取舍——倾向二期建表,与 `ExecutionSkill` 对称。
- **范围控件 UX**:数值/时间「区间」在 UI 上是「双输入框 / 范围选择器」还是「两条 `>=` 与 `<=` clause」,需在 Phase 3 定。

---

## 8. 对抗性测试结论(filter 功能,06-30)

用「真实 API(3023)vs 直连 DB 同语义 ground truth」对比 ~25 个场景,发现并修复 2 个真 bug、记录 2 个局限:

**已修复**
- **latency 单位错(用户点名)**:DB 原始 `latency` 是**秒**(claude=durationMs/1000、jiuwen=ns/1e9),但注册表标了 `ms` 且裸下推 `latency > 值` → 用户输 `2000`(以为 2 秒)几乎匹配不到。**改单位为秒**(`unit:'s'`、描述「执行时长(秒)」),裸比较原始列即正确。实测 `latency>2` → 36 条命中。(展示侧 `toDisplayLatencyMs` 的 ms 换算是另一套、且对 jiuwenswarm 漏转 = 独立**展示** bug,本期不动。)
- **否定操作符丢 NULL 行**:`does not contain` / `none of` 用 `NOT(LIKE)` / `notIn`,SQL 里对 NULL 行求值为 NULL → 被排除;但「不包含 X / 不属于这些值」语义上 NULL 应命中。**nullable 列的否定结果再 OR `IS NULL`**。证据:`subagentType`(该 user 全 NULL)`none of [kuafu]` 修复前 0 → 修复后 60。

**已记录的局限(本期不修)**
- **LIKE 通配符不转义**:Prisma SQLite 的 `contains/startsWith/endsWith` 不转义 `_`/`%`(无 ESCAPE)。`de_pseek`、`de%` 都会通配匹配 → **过匹配**(返回超集,绝不漏)。彻底修需 raw SQL `LIKE … ESCAPE`,危害小故缓。已在 `to-prisma.ts` 注明。
- **分数列 0–1 标度**:`answerScore/skillScore/skillTriggerRate` 存 0–1(非 0–100),描述里标「(0–1)」提示用户按 0–1 输入。

**已验证正确**(api==truth):number 区间(>/>=/</<=、负/零/小数、string 强转)、datetime 区间(ISO→Date、拒 `=`)、stringOptions any/none、string contains/前后缀、boolean、`agents` observedAgents JSON 成员降级(any/all/none,且不被子串误命中)、多子句 AND、`q` 自由文本 + clause 组合、非法子句优雅忽略(不 500、不过滤)、deferred(skill/status/ownership)忽略。

---

## 附:对照一图

```
langfuse:
  front half:  [文法搜索栏 field:value]  +  [facet 侧栏]      ← 两个编辑器
                          ↘                ↙
  back half:        一份 FilterState  →  createFilterFromFilterState → ClickHouse

本方案(SQLite 版,无 FTS):
  back half 先行(P1-2):  列注册表 → FilterClause → buildPrismaWhere → Prisma + 服务端分页
  front half 后叠(P3-4):  [结构化过滤 UI + facet 计数]  +  [field:value 文法栏]
  P0 已落地:             裸文本 contains 搜索框 = langfuse 的 bare-text 全文 lane
```
