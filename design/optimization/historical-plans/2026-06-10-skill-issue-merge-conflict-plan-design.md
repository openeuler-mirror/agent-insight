# 优化点归并与冲突检测设计（SkillIssue 台账 + SkillOptPlan 归并层）

> 分支：`feat/skill-opt-merge-conflict` · 2026-06-10
> 方法参考：[Trace2Skill (arXiv 2603.25158)](https://arxiv.org/abs/2603.25158) 的
> lesson-as-patch + 层级归并算子 + prevalence 路由。

## 1. 背景与问题

当前优化点（`SkillIssue`）链路：评估器派生 → 写库（写入时按 `dedupKey` 哈希初筛）→
读取时按 `dedupKey` 分组出 `prevalenceCount` → 用户在 skill-opt 页勾选 → 平铺注入
agent prompt（`buildSkillOptSystemPrompt`）→ agent 改完 resolve。

实测三个问题（数据来自 home 库 + 仓库 `data/` 库共 254 条 SkillIssue）：

1. **合并是字符串级不是语义级**：dynamic 的 `dedupKey = hash(category::normalizeSummary::salt)`，
   同一问题换措辞就分裂成多条；目前唯一的"语义合并"发生在 opt agent 脑内
   （prompt 修改细则第 1 条"prevalence 优先"），不可见、不可审、不持久。
2. **没有冲突检测**：两个优化点对同一区域提矛盾修改（如"输出详细解释" vs "禁止解释"）
   无任何机制发现，全靠 agent 自行取舍。
3. **优化点多、噪音重**：单 skill 未 resolve 的聚合 issue 可达几十条；其中存在完全
   笼统不可行动的条目（如 summary="金额"、evidence 空、fix 空）。用户反馈"优化点很多"。

锚点现状：`SkillIssue` 无结构化 file/line 字段，只有自由文本 `evidence`——
static linter 有 `file:line` 文本（如 `scripts/verify.py:9`）；static LLM 维度评估引用原文
（半锚定）；dynamic 只锚到轨迹 Step #N、不锚到 skill 文件；trigger 语义上固定锚到
frontmatter `description`。

## 2. 核心决策：两层模型——台账层不动，归并层新增

**`SkillIssue` 保持为不可变的"原始发现台账"**（raw findings ledger）：

- 归并**不修改、不删除、不写回** `SkillIssue`；`source` 枚举不变
  （`static | dynamic | feedback | trigger`，**不新增 `merged`**）。
- 现有机制全部保留：写入时 dedupKey 初筛、读取时 prevalence 聚合、
  `resolvedAt` 懒删除、重评按版本重新派生。

**归并结果是新实体 `SkillOptPlan`（+ `SkillOptPlanItem`），持久化到数据库**，
挂在一轮优化会话（`SkillOptSession`）上：

```
SkillIssue (台账, 跨 eval 累积, 版本内有效)
    │  N : 1（sourceIssueIds 引用，不回写）
    ▼
SkillOptPlanItem (归并产物, 一轮会话内有效, 带锚点与建议 diff)
    │  应用后
    ▼
SkillOptIteration.resolvedIssueIds → PATCH /resolve 回标台账
```

### 为什么不把合并结果写回 SkillIssue（被否决的替代方案）

把归并结果作为 `source='merged'` 的新 SkillIssue 写回看似简单，实际破坏三个不变式：

1. **prevalence 重复计数**：merged 行与其源行并存，读取聚合会双算；
2. **污染懒删除模型**：重评只重派生原始 issue，merged 行成为无人维护的孤儿；
3. **resolve 语义混乱**：resolve merged 行时源行状态不明，反之亦然。

归并产物的生命周期（一轮会话、一个 baseVersion）与台账（跨 eval 累积）根本不同，
分表是正确建模。

### 为什么要持久化（而不是进 prompt 前临时算一次）

1. 冲突项需要用户**仲裁**，跨页面刷新/多次会话往返必须可恢复；
2. resolve 回标需要 plan item → sourceIssueIds 的映射；
3. 审计：「agent 为什么改这段」可从 plan item 回溯到原始 issue 与评估证据；
4. 未来收益归因 / A-B 验证的单位就是 plan item（接 held-out 反事实门）。

## 3. 锚点：version-scoped，不跨轮存活

锚点漂移的解法是**让锚点只活一个版本**，而不是放弃锚点：

- plan item 的锚点（`targetFile` + `anchorText`）针对 **`baseVersion` 的钉死快照**；
  归并与冲突判定都发生在这个固定坐标系内（merge-time），不存在漂移。
- 一轮完成 → 源 issues resolve → 发布新版本 → 重评**针对新版本重新派生** issue
  （现有懒删除模型）→ 下一轮归并用全新锚点。旧锚点随旧版本退役。
- 版本内的行号漂移（多次 draft iteration）用**文本锚**（原文片段 / section 标题）
  代替纯行号——文本锚可在变更后的内容里重新定位，行号不行。

这与 Trace2Skill 同构：其 lesson 就是针对固定 base 的 patch，
"no two edits may target overlapping lines" 约束在合并时对固定 base 强制执行。

## 4. 归并算子（merge operator）

一轮优化入口处运行的 LLM 算子，输入 `(skill, baseVersion)` 全部未 resolve 的
聚合 issues（含 prevalenceCount）+ baseVersion 文件快照，输出 plan items。

- **批与树归并**：单批上限 B≈30 条（带证据全文喂进上下文）；超过 B 时分批归并出
  中间 plan，再对中间结果跑一轮合并（⌈log_B N⌉ 层）。实际规模：单 skill 优化点
  多时可达 **240 条**（每条 trace 都产优化点），树归并是 P1 必须路径而非兜底；
  240 条 ≈ 8 批 + 1 层二次归并。派生侧"多条 trace 找共性再产点"的源头治理
  是后续优化，本期不做。
- **三个职责**（对齐 Trace2Skill 的 merge operator）：
  1. **语义去重**：同义 issue 合为一条，保留最具体、证据最强的表述，
     `rationale` 必须引用全部源 issue id；
  2. **冲突消解**：同 targetFile + 锚点区域重叠、或同 section 修改方向矛盾 →
     justification 强弱分明的直接综合（rationale 说明取舍）；
     无法综合的标 `status='conflict'` + `conflictNote`，交用户仲裁；
  3. **prevalence 优先**：`prevalence = Σ 源 issues 的 prevalenceCount`，
     多来源（static+dynamic 同时指向）加权，作为 rank 主键。
- **归并顺序**（采纳 SkillOpt 的 failure-first）：失败类 issue（轨迹偏差/工具误用）
  先归并定调，表达/格式类后归并且让位——SkillOpt 的消融表明
  "failure corrections given priority" 的层级归并能在预算筛选前滤掉大部分重复与矛盾。
- **质量门（采纳 SkillLens rubric）**：算子 prompt 内置三维质检，core 路由的 item 必须
  同时满足：①**失败机制编码**（写清"什么情况下会怎么坏"，不是泛泛建议）、
  ②**可执行具体性**（目标模型能直接照做的指令）、③高危操作显式列入黑名单段。
  三维都不满足的候选不得进 core（降 backlog 并注明）。SkillLens 验证过：
  无 rubric 的 LLM 判官选优精度 46.4%≈随机，按"看起来合理"评估反而劣化（−0.59pp）。
- **锚点尽力而为**：算子结合文件快照为每条 item 推断 `targetFile/anchorText`；
  dynamic 源证据不足时允许为空（P3 由评估器侧补齐，见 §9）。

## 5. 「优化点很多」怎么办：归并坍缩 + 三路路由（不是机械分批）

Trace2Skill 对 ~70 条 patch 的做法**不是分批应用**，而是**分批归并成一份统一 plan**
（B=32 树归并 → 一次性产出统一 skill），再配合双层路由：高频教训
（>50% patch 复现的 SoP）进 SKILL.md 正文，低频边角观察路由到 `references/` 按需查阅。
其消融还发现 patch 价值是组合性的——贪心挑子集会塌方，全量归并后统一应用更优。

本设计照搬这个思路，plan item 带 `route` 字段三路路由：

| route | 含义 | 本轮处理 | resolve |
|---|---|---|---|
| `core` | 高 prevalence/severity 的 SoP 级修改 | agent 必做 | 应用后 resolve 源 issues |
| `reference` | 低频长尾，有价值但不配占主文件 | agent 写入/追加 `references/` | 同上 |
| `backlog` | 信号不足 / 用户 dismiss / 仲裁放弃 | 本轮不动 | **不 resolve**，下轮重新参与归并 |

用户审阅的对象从"几十条原始 issue"坍缩为"少数 SoP 级 plan item +
明确标出的 conflict 仲裁项"。backlog 顺延等价于 Trace2Skill 把
单例观察降权——不丢弃（台账还在），但不抢本轮带宽。

**每轮编辑预算（采纳 SkillOpt 的 textual learning rate）**：core 路由每轮硬上限
K=4 条（rank 截断，超出自动降 backlog）。依据：SkillOpt 实测最终胜出的 skill
只含 1–4 条被接受的编辑（中位 2.5），且"unbounded rewrites erase useful rules"
——小步有界更新优于一次性大改；其全量对比中 SkillOpt 在 52 个
(model, benchmark, harness) 格上全部打平或超过 Trace2Skill 的一次性全量归并。
这也天然控制了 diff 审阅负担与单轮回归风险。

## 6. Schema 变更（纯增量，`npm run db:push` 即可）

```prisma
/// 一轮优化会话入口处由归并算子产出的统一优化计划
model SkillOptPlan {
  id           String   @id @default(cuid())
  sessionId    String   @unique          // 一轮会话至多一份 plan
  session      SkillOptSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  skillId      String
  baseVersion  Int
  status       String   @default("draft") // draft | confirmed | applied | abandoned
  operatorMeta String   @default("{}")    // JSON：批数/层数/模型/耗时，纯审计
  createdAt    DateTime @default(now())
  items        SkillOptPlanItem[]

  @@index([skillId, baseVersion])
}

model SkillOptPlanItem {
  id               String   @id @default(cuid())
  planId           String
  plan             SkillOptPlan @relation(fields: [planId], references: [id], onDelete: Cascade)
  rank             Int                          // 展示与应用顺序（prevalence×severity）
  route            String                       // 'core' | 'reference' | 'backlog'
  status           String   @default("pending") // pending | conflict | applied | deferred | dismissed
  title            String
  rationale        String                       // 归并理由：为什么这些 issue 是一件事 + 综合后的修改方向
  targetFile       String?                      // 锚点：相对 baseVersion 快照的文件路径
  anchorText       String?                      // 锚点：目标位置原文片段 / section 标题
  proposedEdit     String?                      // 建议修改（diff 或指令式描述）
  conflictNote     String?                      // status='conflict' 时的矛盾说明，给用户仲裁
  sourceIssueIds   String   @default("[]")      // JSON string[]：归并自哪些 SkillIssue.id
  sourcesBreakdown String   @default("{}")      // JSON：{"static":n,"dynamic":m,"trigger":k}
  prevalence       Int      @default(1)         // Σ 源 issues 的 prevalenceCount
  createdAt        DateTime @default(now())

  @@index([planId, rank])
}
```

`SkillOptSession` 增加反向关系 `plan SkillOptPlan?`。`SkillIssue` 零改动。

## 7. 流程

```
用户进入 skill-opt 会话（skill, baseVersion）
  └─ POST /api/skill-opt/plan        ← 新端点：跑归并算子，持久化 plan（status=draft）
       ├─ 输入：aggregateSkillIssues(skill, version, 未resolve) + 版本文件快照
       └─ 输出：plan items（core/reference/backlog + conflict 项）
用户审阅 plan
  ├─ conflict 项仲裁：选方向 / 综合 / 弃用（PATCH /api/skill-opt/plan/items/:id）
  └─ 可调 route（core ↔ backlog）、dismiss
用户发起优化（chat）
  └─ prompt 注入从「平铺 checkedIssues」改为「plan items（带锚点/proposedEdit）」
       （无 plan 时回退老路，向后兼容）
agent 应用 → SkillOptIteration
  └─ resolvedIssueIds = 已应用 items 的 sourceIssueIds 并集 → PATCH /resolve（现有端点）
backlog/dismissed 的源 issues 不 resolve → 留在台账，下轮重新归并
发布新版本 → 重评派生新 issues（新锚点）→ 下一轮
```

## 8. API 变更

- 新增 `POST /api/skills/by-name/[name]/optimization-points/merge`
  （或挂 `api/skill-opt/plan`）：body `{ user, baseVersion, sessionId }`，
  跑归并算子并落库，幂等（同 session 重复调用返回已有 draft plan）。
- 新增 `PATCH .../plan/items/[id]`：仲裁/改 route/dismiss。
- `POST /api/skill-opt/chat`：body 增加可选 `planId`；有 plan 时
  `buildSkillOptSystemPrompt` 走新的 `formatPlanSection`（注入锚点 + proposedEdit +
  rationale），无 plan 保持现状。
- `PATCH .../optimization-points/resolve`：不变（resolve 输入由 plan 映射生成）。

## 9. 分期落地

- **P1 最小闭环**：plan 两张表 + 归并算子（单批）+ plan 注入 prompt +
  resolve 映射。锚点由算子尽力推断。验证：用仓库库里 pdf-extractor 的
  10 条 dynamic + 同版本 static 跑归并，检查去重/冲突/路由输出。
- **P2 仲裁与路由 UI**：conflict 仲裁交互、三路分组展示、backlog 顺延、
  plan 历史可回看（挂在会话详情）。改 UI，PR 需改前/改后双截图。
- **P3 锚点与验证门**：评估器子代理（trajectory-evaluator）输出升级——dynamic issue
  派生时带 `targetFile/anchorText` 候选；归并算子输出接「最小修复复验」式验证门，
  联动 held-out 切分做收益归因（对应已知的反事实缺口）。验证门采纳 SkillOpt 的
  **strictly-improves 接受准则**：候选草稿在 held-out 集（trigger 评测集 +
  轨迹评测任务）上严格优于基线才接受，打平即拒——这是业界共识的"终极冲突仲裁器"
  （结构检测管的是"改不改得到一起"，经验门管的是"改了是否真的更好"）。
- **P4 成功集挖掘**：当前 issue 全部来自失败/缺陷信号。Trace2Skill 的 Success
  Analyst 与 SkillLens 的实证（"pure-failure pools consistently produce the worst
  skills"）都指向：成功轨迹中的可泛化行为模式应同样派生为正向优化点
  （新 `source='success'` 或复用 dynamic + 正向 category），进入同一归并管线。

## 10. 业界实现对照

| 系统 | 归并/规模化 | 冲突处理 | 与原始发现的关系 | 本设计采纳 |
|---|---|---|---|---|
| [Trace2Skill](https://arxiv.org/abs/2603.25158) | B=32 树归并成一份统一 plan，一次应用；高频→正文 SoP，低频→references/ | **结构性**：合并时强制"edit 行级独立"，矛盾选 justification 强者或综合 | patch 与轨迹分离，prevalence 加权 | 树归并、三路路由、版本内锚定 |
| [SkillOpt](https://arxiv.org/abs/2605.23904)（Microsoft） | **edit budget = 文本学习率**：每步至多 L_t 条 add/del/replace；最终 skill 仅 1–4 条编辑胜出（中位 2.5）；epoch 边界 slow/meta update | **经验性**：层级归并先滤重复矛盾（failure 优先），held-out 验证门 strictly-improves 终裁；被拒编辑进 buffer 防复提 | 全量持久化：best_skill.md + 每步快照 + history.json + patches + rejected-edit buffer（完整台账） | 每轮 K=4 预算、failure-first 归并序、P3 验证门、backlog≈rejected buffer |
| [SkillLens](https://microsoft.github.io/SkillLens/)（Microsoft） | （评价侧）rubric 编译成 meta-skill 注入提取器 | n/a | 高/低效用 skill 对比实验得三维 rubric：失败机制编码 / 可执行具体性 / 高危黑名单（各自 >64% 预测力） | 算子 prompt 内置三维质检；"10–20 例小评测集+确定性检查"思路 |
| [SkillGrad](https://arxiv.org/abs/2605.27760) | 轨迹级 loss → 文本梯度，LLM patcher 做 layer-aware 编辑 | **momentum agent** 把跨轮复现的诊断模式累积为持久 memory overlay，抑制振荡 | 诊断与 overlay 分层持久化 | 印证 prevalenceCount 跨轮累积的价值（我们已有） |
| [EvoSkill](https://arxiv.org/abs/2603.02766) | 失败分析→提议新 skill/编辑→物化为 skill 文件夹 | **Pareto 前沿**选择：仅保留 held-out 提升的 | skill 文件夹与执行记录分离 | held-out 门的又一例证 |

要点：**业界冲突消解的主流是经验门控（held-out 严格提升才接受），结构检测只是
归并阶段的预过滤**。本设计 P1/P2 先做结构检测+人工仲裁（人机协同场景下用户就是
终裁者），P3 补经验门，两层互补而非二选一。

## 12. P1 实测（2026-06-10，deepseek-chat）

归并算子在真实 issue 池上的表现（详见 `agent-insight-data/skill-opt-merge-experiment/REPORT.md`）：

| 池 | 输入 issue | 输出 item | 压缩 | core 预算 | 批/层 | LLM 调用 | 墙钟 |
|---|---|---|---|---|---|---|---|
| doc-summarizer v3（真实）| 88 | 25 | 3.5× | 4/4 | 3/2 | 5 | 95s |
| pad 到 240（含 152 克隆）| 240 | 9 | 26.7× | 4/4 | 8/3 | 12 | 123s |
| messages skill（真实 static+dynamic）| 42 | 11（core4/ref2/backlog5）| 3.8× | 4/4 | 2/2 | 3 | 40s |

- **240 条规模验证**：用户报告的最大规模可处理，墙钟仅比 88 条慢 30%（分批并发）。
- **去重 recall**：240 臂中 83%（121/145）被引用克隆与原件归并进同一 item。
- **锚点命中**：core 条目普遍带 `targetFile + anchorText`（逐字摘自 baseVersion 快照、
  后端校验通过），证明 version-scoped 文本锚可行。
- 端到端优化效果对比（flat 平铺 vs plan 归并注入）结论见 REPORT.md。

## 13. 优化回路改进（第二轮，2026-06-11）

目标：让优化后的分数真正上升且不过拟合。落地的回路/评测改进（均已提交）：

- **held-out 验证门**（反过拟合核心）：评测集做 val/test 切分；优化版只有在 val 严格优于基线
  才被接受，最终分报在密封 test。等价于 SkillOpt 的 strictly-improves + ML 的 train/val/test。
  实验侧已验证能正确拒绝所有回归候选、保留基线（floor=baseline，杜绝负迁移盲发）。
- **eval-aligned 优化点生成**：当前 issue 多来自 trace 的"过程合规"，与评测目标错位。改为从
  skill 在 held-out 上的判官 `missing_reason` 抽象出**能力级** issue（自动剥离答案值防过拟合）。
- **编辑范围硬守卫**（src/lib/engine/skill-opt/edit-scope-guard.ts）：实测 deepseek-v4-pro 无视
  "别删脚本"的 prompt → 改用结构性强制：禁删基线文件（删了还原）+ 改动行数预算。借鉴 trace2skill。
- **优化器/测量模型解耦**：/plan 与 /chat 支持 modelId；优化器可用 v4-pro，测量模型固定保证可比。
- **评测健壮性**：per-case 超时 + 仅对基建失败（超时/ECONNRESET/空输出）重试，不对真实低分重试。

### 三个"为什么测不出提升"的混淆（实验关键教训）

1. **评测方差极大**：同一 skill 同一 case 跑 4 次，分数极差可达 **1.0**（agent 执行随机）。
   单次测量 ±0.4/case 淹没优化效果(~0.1)。→ 必须多轮平均（runsPerCase，runs≥3）。
2. **deepseek "限流"实为 ECONNRESET**（非 429）：本机代理重置慢长连接。多 key 无用；
   解法是退避重试 + deepseek 直连绕代理。
3. **优化器预填错基线**：resolveSkillStorageDirSync 按 frontmatter name 扫目录，同名 orphan
   storage 碰撞 + readdir 顺序不稳 → 优化器有时拿到缺核心脚本的旧基线（已提修复任务，应按
   id/assetPath 解析，与测量路径一致）。

**结论**：可靠地"让分数上升"的前提是先消除这三个混淆 + 多轮平均把方差降到可分辨增益；
机制（门/守卫/eval-aligned/复用）本身由单测与直接检查独立验证有效。

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| 算子误合并（不同问题合成一条） | rationale 强制引用源 issue id；UI 上 plan item 可展开核对源 issues 原文 |
| 算子幻觉锚点（anchorText 在快照中不存在） | 落库前后端校验 anchorText 是否能在 baseVersion 快照中定位，失败置空并降级 |
| LLM 成本/时延（入口处多一次调用） | 一轮一次、幂等缓存；单批 ≤30 条控制上下文 |
| 笼统 issue 拖低归并质量 | 算子允许将不可行动条目直接路由 backlog 并注明"信号不足"；派生侧修复另行处理（已挂任务） |
| 与现有「agent 脑内合并」重复 | prompt 修改细则第 1 条在有 plan 时改为"按 plan 执行，不要二次合并" |
