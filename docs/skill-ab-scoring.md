# Skill A/B 评分体系（v2.1）

> **算法版本**: `agent-skill-scoring-v2.1`（短板原则 + 成本能力耦合 + 评测器百分制能力分）
> **唯一事实来源**: [`src/lib/skill-analysis/ab-scoring.ts`](../src/lib/skill-analysis/ab-scoring.ts)
> **前端落地**: [`src/app/(main)/skill-eval/grayscale/page.tsx`](../src/app/(main)/skill-eval/grayscale/page.tsx) Card 3「综合判定 & 决策」
> **更新时间**: 2026-05-27

---

## 0. 这份文档解决什么问题

灰度评测页（`/skill-eval?view=gray`）会基于 A/B 测试结果给出「能力 / 成本 / 稳定性」三个分数 + 一个综合判定。本文档说明这三个分数是怎么算出来的、综合判定怎么得到、以及前端在哪里展示这套计算的明细，方便用户在看到一个分数时立刻能追溯到原始数据。

读完应该能回答：

1. 一个 Skill 的好坏由哪几个维度决定？每个维度的 0-100 分是怎么算出来的？
2. 三个分数怎么汇总成发布决策？
3. 哪些边界情况会让某个维度无法出分？

> 与既往版本的差异：v2.1 把三个维度都归一到 0-100、把能力分从「通过率 pp」升级为「评测器百分制 Δscore」、把综合分从加权平均改为 **min(能力, 成本, 稳定性)** 的短板原则。详见 §6.5。

---

## 1. 总体设计

### 1.1 三个维度

| 维度 | 一句话问题 | 0-100 分 | 判定带 |
|------|------------|----------|--------|
| **能力** | 这个 Skill 有用吗？ | 越高越有用 | ≥75 好 / 50–75 一般 / <50 拒绝 |
| **成本** | 这个 Skill 划算吗？ | 越高越划算 | ≥70 好 / 40–70 警告 / <40 拒绝 |
| **稳定性** | 这个 Skill 可靠吗？ | 越高越可靠 | ≥70 好 / 50–70 警告 / <50 拒绝 |

### 1.2 设计原则

1. **统一量纲** — 三个维度都是 0-100，可横向比、可排序。
2. **短板决策** — 综合判定看最低分，不看平均分。
3. **耦合保留** — 成本分会根据能力分动态调整，避免误杀「贵但有用」的 Skill。
4. **可解释** — 每个分数都能下钻到原始公式和原始数据（前端见 §7）。
5. **抗噪声** — 样本不足（默认 `minSampleSize`）时不出综合结论。

---

## 2. 实验设计

A/B 测试唯一变量是 Skill 开/关：

```
A 组（对照）: 基础 Agent + Skill 关闭
B 组（实验）: 基础 Agent + Skill 开启
```

每个 case 跑 R 轮（`repeatRounds`），所有其他变量（Agent 基座、数据集、评测器、随机种子）必须保持一致。

采集字段（前端 `caseStates[caseId][a|b].runs[]`）：

| 类别 | 字段 |
|------|------|
| 身份 | `caseId`、`runIndex/roundIndex`、`sessionId`、`evaluationTraceId` |
| 过程 | `skillTriggered`、`toolCallCount` |
| 资源 | `timeCost`、`tokenUsage` |
| 结果 | `score`（评测器百分制，0-100）、`status`（pass/fail/...） |

---

## 3. 能力分（Capability）

### 3.1 计算

A/B 两组评测器分数取均值，做差后归一化到 0-100：

```
avgEvalA = mean(run.score for run in A side, run terminal)
avgEvalB = mean(run.score for run in B side, run terminal)
Δscore   = avgEvalB - avgEvalA          # 百分制下的绝对差
capability_score = clamp(50 + Δscore × 2.5, 0, 100)
```

直观对应：

| Δscore | 能力分 | 判定 |
|---|---|---|
| ≥ +20 | 100 | 🟢 好 |
| +10 | 75 | 🟢 好 |
| 0 | 50 | 🟡 一般 |
| −10 | 25 | 🔴 拒绝 |
| ≤ −20 | 0 | 🔴 拒绝 |

> **向下兼容二元评测器**：评测器只输出 0/1 时，把它当 0 分和 100 分代入即可——`avg` 后即等于「通过率 × 100」。`passRateA/B` 仍作为辅助指标在结果里保留，方便对照 v1.1 历史报告。

### 3.2 边界情况

| 情况 | 处理 |
|------|------|
| A、B 评测均分都 < 5 分 | 标记 `dataQualityIssue = '数据集太难'`，不出能力结论 |
| A、B 评测均分都 > 95 分 | 标记 `dataQualityIssue = '数据集太简单'`，不出能力结论 |
| 某 trace 评测分缺失 / 非数值 | 该 trace 不参与均值计算 |

---

## 4. 成本分（Cost）

### 4.1 计算

以 Token 增量为主指标，先映射出基础成本分，再按能力分调整：

```
Δtoken = (avgTokensB - avgTokensA) / avgTokensA × 100%

base_cost =
    100                              if Δtoken ≤ 0%
    100 - Δtoken × 1.0               if 0% < Δtoken ≤ 20%      # 0→100, 20→80
    80 - (Δtoken - 20) × 0.5         if 20% < Δtoken ≤ 100%    # 20→80, 100→40
    40 - (Δtoken - 100) × 0.4        if 100% < Δtoken ≤ 200%   # 100→40, 200→0
    0                                if Δtoken > 200%

if capability_score ≥ 75:    cost = base_cost + 15    # 贵但有用，加分
elif capability_score < 50:  cost = base_cost − 20    # 白烧钱，扣分
else:                        cost = base_cost
cost_score = clamp(cost, 0, 100)
```

举例：

- Token +100%、能力 80 → 40 + 15 = **55**（贵但有用，监控发布）
- Token +100%、能力 30 → 40 − 20 = **20**（白烧钱，打回）
- Token +10%、能力 60 → ≈ **90**（成本可控）

### 4.2 辅助指标（不参与判定）

- 平均耗时 `avgDurationA/B` 与 `deltaDurationPct`
- 平均工具调用次数 `avgStepsA/B` 与 `deltaStepsPct`

耗时/步数仅用于报告辅助显示，因为耗时受网络/并发/负载抖动影响大，Token 才是相对稳定的客观资源消耗。

### 4.3 边界情况

| 情况 | 处理 |
|------|------|
| A 平均 Token = 0 或缺失 | `dataQualityIssue = 'A 组平均 Token 缺失或为 0，成本维度无法计算'`，成本分 null |
| Token 减少（Δ < 0） | 视为 100 分 |

---

## 5. 稳定性分（Stability）

### 5.1 计算

```
invokeRate = (# of B runs with skillTriggered=true) / (# of B runs)
variance   = mean(per-case variance of B runs' isPassed(0/1))

stability_score = invokeRate × 100 × (1 − variance / 0.25)
```

直观：

- 触发率 100%、方差 0 → **100**
- 触发率 100%、方差 0.10 → 100 × 1 × (1 − 0.4) = **60**
- 触发率 70%、方差 0 → **70**
- 触发率 50%、方差 0.15 → 50 × (1 − 0.6) = **20**

二项分布方差上限是 0.25，所以 `1 - var/0.25` 是 0-1 的「一致性系数」。两个子指标是「且」的关系，任一项拉胯总分都上不去。

### 5.2 边界情况

| 情况 | 处理 |
|------|------|
| 重复轮次 R < 2 | 无法计算方差，按 `variance = 0`，UI 标注「方差不可计算，仅供参考」 |
| B 组样本为 0 | `invokeRate = null`，稳定性分 null |
| `skillTriggered` 字段缺失 | 视为 false，记录到数据质量问题 |

---

## 6. 综合判定（短板原则）

### 6.1 综合分

```
total_score = min(capability_score, cost_score, stability_score)
```

为什么是最低分而不是加权平均？因为三个维度是「且」的关系：一个 Skill 必须**有用、划算、可靠**才能发布。能力满分但成本翻倍，加权平均还挺高，但实际应该打回——短板原则能正确处理这种情况。

### 6.2 四道关卡（顺序执行，前一关阻断则直接返回）

```
第一关：N < minSampleSize         → 'insufficient'（样本不足）
第二关：任一维度低于拒绝阈值        → 'reject'
                                      • capability < 50 → reject(能力)
                                      • cost       < 40 → reject(成本)
                                      • stability  < 50 → reject(稳定性)
第三关：三个维度都 ≥ 75            → 'direct-release'（直接发布）
第四关：其他                       → 'monitor-release'（监控发布）
```

`hardGates`（被命中的拒绝项）和 `rejectCategory`（第一命中的拒绝类）写入结果，前端用于显示具体打回原因 + 改进建议。

### 6.3 决策与建议映射

| 决策 | 含义 | 建议文案 |
|------|------|---------|
| `direct-release` | 三维全达标 | 进入全量发布，保留后续复测记录 |
| `monitor-release` | 至少一维介于阈值之间 | 小流量监控发布，持续观察短板维度 |
| `reject` | 至少一维低于拒绝线 | 按 `rejectCategory` 修正后复测 |
| `insufficient` | 样本不足 | 补齐到 `recommendedSampleSize` 再复测 |

---

## 7. 计算明细（前端可下钻）

为满足设计文档第 4 条原则（**可解释**），每个分数的 `breakdown` 字段会随评分结果一起返回：

```ts
interface ScoreBreakdown {
  formula: string;          // 带实参的公式字符串
  steps: string[];          // 逐步计算的中间结果
  reference: string;        // 指向本文档对应小节（如 'ab-scoring §3.1'）
}
```

灰度页 Card 3 的每张维度卡（能力 / 成本 / 稳定性）底部都会渲染该 breakdown：

```
能力分计算
  avgEvalA = mean([62, 65, 70]) = 65.7
  avgEvalB = mean([75, 80, 80]) = 78.3
  Δscore   = 78.3 − 65.7 = 12.6
  score    = clamp(50 + 12.6 × 2.5, 0, 100) = 81.5
  参考：ab-scoring §3.1
```

UI 风格遵循 `docs/design/foundations.md` §0.2 锚点③：`font-mono` + `tabular-nums`，数字右对齐；颜色与维度卡 tone 保持一致（绿/琥珀/红/灰）。

---

## 8. 可配置阈值（`AbScoringPolicy`）

所有阈值都暴露在 `DEFAULT_AB_SCORING_POLICY` 中，可通过 `calculateAbScoring` 的 `options.policy` 覆盖：

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `capabilityScoreSlope` | 2.5 | Δscore 每 +1 分对应能力分变化（§3.1） |
| `capabilityGoodThreshold` | 75 | 能力分「好」下限（§1.1） |
| `capabilityRejectThreshold` | 50 | 能力分「拒绝」上限（§1.1） |
| `costGoodPct` / `costWarningPct` / `costRejectPct` | 20 / 100 / 200 | Δtoken 转 base_cost 的分段拐点（§4.1） |
| `costCouplingBonus` / `costCouplingPenalty` | +15 / −20 | 能力耦合的加扣分（§4.1） |
| `costGoodThreshold` / `costRejectThreshold` | 70 / 40 | 成本分判定带（§1.1） |
| `varianceMax` | 0.25 | 二项分布方差上限（§5.1） |
| `stabilityGoodThreshold` / `stabilityRejectThreshold` | 70 / 50 | 稳定性分判定带 |
| `minSampleSize` | 1 | 出结论的最小样本量（**当前为开发友好值，规范推荐 5**） |
| `recommendedSampleSize` | 20 | 推荐样本量 |
| `minRepeats` | 1 | 计算方差的最小重复次数（规范推荐 3） |

> 阈值变更需同步 `version` 字段，便于历史回放与策略对比。

---

## 9. 与设计规范的衔接

- **`docs/design/foundations.md` §0.2 识别锚点③**：能力 / 成本 / 稳定性三张维度卡的分数走 `<MetricValue>` 等宽数字 + 单位对位（未来落地）。
- **`docs/design/foundations.md` §0.1 第 2 条**：颜色用来传递信息——绿/琥珀/红/灰对应判定带，不允许用其他颜色装饰。
- **`docs/design/patterns.md` §A.4 模板 1**：grayscale 页是「列表 + 详情」混合，决策卡走详情模板的 KPI 卡布局。
- **`docs/design/components.md`** 第 13 条：分数 + 单位组合统一走 MetricValue（迁移项，见 ROADMAP）。

---

## 附录：与 v2.2（旧加权 + hard gate ceiling）的映射

旧实现（`policy.version = 'agent-skill-scoring-v2.2'`）使用加权平均 + hard gate 天花板，判定逻辑：

```
rawTotal = 0.5 × cap + 0.25 × cost + 0.25 × stab
total = min(rawTotal, ...hardGateCeilings)   # 命中 hard gate 强行打回
```

v2.1（本文档）切到短板原则后：

| v2.2 概念 | v2.1 等价 |
|-----------|-----------|
| `weights.capability/cost/stability` | 移除（无加权） |
| `hardGateCeilings.{capability,cost,stability}` | 移除（拒绝由判定带自动触发） |
| `capabilityScore` 分段函数（0/60/80/100） | `clamp(50 + Δscore × 2.5, 0, 100)` |
| `costScore`（+200% → 20 分） | `costScore`（+200% → 0 分）+ 能力耦合 |
| `stabilityWeights.invoke/variance` 加权 | `invokeRate × 100 × (1 − var/0.25)` 乘法 |
| `rawTotal` 加权平均 | `min(cap, cost, stab)` |

历史评测结果不会回填——`policyVersion` 字段会标明算法版本，前端在历史时间线上展示不同版本时按各自策略渲染。
