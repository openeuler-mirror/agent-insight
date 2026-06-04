# Framework 适配器注册表 — 需求分析（第一刀：Skill 抽取 + Claude 归一化 + 值域统一）
版本：v0.2
最后更新：2026-06-04

> 文档类型：Phase1 需求分析 ｜ 关联项目：agent-insight
> 复杂度：**Low-Medium**（纯内部、行为保持型重构,零功能新增）
> base_commit：c47829a（master_0530）｜ 变更类型：重构（refactor）
> 关联：本目录债务地图（簇 A~I）；与 `docs/design/hermes-otel-adapter/` 并行、互不阻塞

---

## 导读（工程师先看这段）

**这是什么** —— 一次纯内部重构。把「先判断当前是哪个框架(opencode / claude / openclaw),再走不同逻辑」这件散落在几十处的事,收进**一个统一的注册表**。不新增任何用户可见功能。

**为什么要做** —— 同一段「按框架抽 skill」的逻辑现在被抄了 **4~5 份**,还互相漂移(有一份漏了 openclaw);claude 的入库归一化函数被 **5 个地方各调各的**。每多接一个框架,就得满代码库改一遍。

**这一轮做到哪** —— 只动三块最痛、最安全的(下文「簇 A/C/I」)。**明确不碰**另外六块(§3),因为其中一块正被 hermes 那条线占用,动了会撞车。

**工程师怎么验收（记住这三条就够）**
1. 现有三框架抽 skill 的结果,重构前后**逐字节一样**(有 golden 测试守着,见 phase3 T1)。
2. **不碰数据库**:不改表、不改存量数据。
3. §3 那六块「不碰」的代码,在本轮的 git diff 里**不该出现**。

**名词速查**（文档/模型用的编号,工程师扫一眼即可,不影响读代码）
| 记号 | 含义 |
|-|-|
| **簇 X** | 债务地图里按「关注点」分的第 X 组耦合点(A~I)。本轮只治 A/C/I |
| **D-0x** | 已经拍板、不再讨论的设计决策 |
| **AC-0x** | 验收准则——「怎么算做对了」 |
| **dispatcher** | `data-service.ts:476` 那个「按 framework 挑 skill 抽取函数」的调度函数 |
| **归一化(normalize)** | 把不同框架五花八门的数据,转成内部统一形状 |

---

## §1 背景：现在哪里痛

agent-insight 北向要兼容多个 Agent 框架(opencode / claudecode / openclaw,即将加 hermes)。「判断框架走不同逻辑」的耦合点经全量盘点共 **9 簇、约 70+ 处**。本轮只治其中三簇(最痛、最安全):

| 簇 | 痛在哪（人话） | 散落位置 | 量级 |
|-|-|-|-|
| **A · Skill 抽取** | 「这条 trace 调了哪些 skill」的同一套逻辑被抄了多份,还会各自改歪 | dispatcher(:476)、upload 同步+异步两份(:167/:292)、rejudge(:61,漏了 openclaw)、proxy/end(自己又抄了份函数体)、AgentTraceView(前端再来一遍) | 4~5 份拷贝 |
| **C · Claude 入库归一化** | 一个叫 `normalizeClaudeCodeInteractionsForStorage` 的函数,被 5 个入口手动各调各的——它其实就是个「没被收编的 claude 适配器」 | data-service、fault/stream、observe×2、claude-otel/aggregator | 5 个调用点 |
| **I · 框架名不统一** | 同一个 claude,有的地方叫 `claude`、有的叫 `claudecode`;framework 字段用 `claudecode`,platform 字段又用 `claude`。没有一份「框架名的标准答案」 | 全局 | 全局 |

## §2 目标：建一个注册表当「唯一真相」

落一个 **FrameworkAdapter 注册表**,把下面三件事都收进它一个入口:
1. **框架名标准化**(簇 I)——`claude`/`claudecode` 解析到同一答案。
2. **Skill 抽取分发**(簇 A)——按框架挑抽取函数,只此一处。
3. **Claude 入库归一化的归属**(簇 C)——本轮先把它认领进 adapter,并切 data-service 一处试水。

> 一句话:**适配器只负责「把各框架数据转成内部统一形状」,不负责入库**;入库仍由 `saveExecutionRecord` 一个出口管。适配器是纯函数,不碰数据库。

## §3 边界：这一轮明确不碰什么（防止越改越大）

下面六块**本轮一律不动**,每块都有具体原因。验收时它们的 git diff 应为空:

| 簇 | 是什么 | 为什么这轮不碰 |
|-|-|-|
| **F** | `role === 'opencode'` 这种把框架名当 role 值用的写法(9 处) | 这是 hermes 那条线「把 hermes 整形成 opencode 同构」所依赖的地基。现在动它 = 和 hermes 撞车。须等内部统一形状(CanonicalInteraction)的 role 命名独立出来后再单独治理 |
| **G** | `platform` 这条平行的框架轴(agent 注册/评测在用) | 是另一套建模轴,单独立项。本轮只在 descriptor 里预留 `platform` 字段占位,不接线 |
| **B** | `saveExecutionRecord` 里的派生/门控(:1580 / :1937 / :1970) | :1937 正被 hermes 那条线动。本轮只把扩展点(capability 位)留好,留到 Phase 2 |
| **D** | opencode「CLI 是否跑完」的生命周期判断 | 横跨 ingest 和 observe 两层,需单独评估 |
| **E** | 前端 6 处重复的「延迟单位换算」 | 纯前端工具函数,和注册表没依赖,可单独抽 |
| **H** | 安装脚本里四份重复的框架清单 | 本轮只让它「读」注册表的 `listFrameworks()`,不改安装逻辑本身 |

## §4 已拍板的决策（不再讨论）

| 编号 | 决策 | 为什么这么定 / 代价 |
|-|-|-|
| **D-01** | 标准框架名定为 **`claude`**,`claudecode` 当别名。**不迁移存量数据**——库里照旧存 `claudecode`,读的时候靠 `resolveFrameworkId` 翻译成 `claude` | 好处:framework 字段和 platform 字段(本就用 `claude`)从此对齐,顺手为以后治理簇 G 省一道。代价:凡是判断存量数据,**必须走 `resolveFrameworkId`,严禁直接写 `=== 'claude'`**(否则会漏掉库里的 `claudecode`)。这条是硬约束,验收会 grep 核 |
| **D-02** | 某框架没实现 skill 抽取时,dispatcher 返回 **`null`** | 严格等于今天「遇到不认识的框架返回 null」的行为,零差异 |
| **D-03** | claude 归一化本轮**只切 data-service 一处**,其余 4 处先留 TODO | 一次别动太多,分轮迁,缩小出问题的范围 |

## §5 验收准则（怎么算做对了）

| 编号 | 验什么 | 通过标准 |
|-|-|-|
| **AC-01** | skill 抽取行为没变 | opencode/claude/openclaw 三框架,重构前后对同一条 trace 的抽取结果**逐字节相等**(golden 测试) |
| **AC-02** | 顺手修了 rejudge 的 bug | rejudge 现在也能抽出 openclaw 的 skill(今天漏了) |
| **AC-03** | 不认识的框架不出事 | 未知/空 framework → dispatcher 返回 `null`(同今天) |
| **AC-04** | 别名能对上 | `getAdapter('claudecode')` 和 `getAdapter('claude')` 拿到同一个 adapter;库里存量 `claudecode` 数据的抽取/归一化不退化 |
| **AC-05** | 没碰数据库 | 不改表结构、不改存量 framework 值、无迁移脚本 |
| **AC-06** | 没越界 | §3 那六块(F/G/B/D/E + 既有框架逻辑)的 git diff 与本轮无关 |
