# 评估器开发指南

> 适用于给「评测中心 / 实验」新增或改造评估器的同学。
> 前置阅读：[04-api-and-contracts.md](./04-api-and-contracts.md)、[07-conventions-and-extension.md](./07-conventions-and-extension.md)。

本文分两部分：**打分方法论**（怎么设计一个可信的评估器，第 3 节，必读）与**工程接入**（代码怎么写，第 4 节起）。方法论部分踩过的坑都是真实线上问题，别跳过。

---

## 1. 评估器在系统里的位置

```
实验(Experiment)
  └─ case(ExperimentCase：一条 trace + 输入/实际输出/参考答案)
       └─ × 每个评估器 → ExperimentEvalResult(status/score/points/evidence)
```

- 一个 case × 一个评估器 = 一行结果，互不影响；单行失败不拖垮其它行，可单独重评。
- 执行入口：`src/lib/engine/experiment/run-experiment.ts` 的 `executeResultRow()`。
- 分发规则（同一文件 `runEvaluatorById`）：

| evaluatorId | 走哪个实现 |
|---|---|
| `preset-agent-task-completion` / `preset-agent-trace-quality` | `experiment/faithful-preset-evaluators.ts` |
| `preset-result-*` | `experiment/result-preset-evaluators.ts` → 复用 canonical `runSingleResultMetric()` |
| 其它（自建） | 通用 LLM Judge（三段式提示词组装） |

> **canonical 提醒**：`result-*` 系列的实现体在 `engine/evaluation/result-quality-evaluator.ts`，**「可靠性与性能」页与质量监控管线共用同一份**。改它的口径 = 两个产品面同时变，必须同步升 `RESULT_METRIC_VERSIONS`（见 §6.4）。

---

## 2. 输出契约

定义在 `src/lib/evaluators/eval-output.ts`，三个字段**全可选**、任意组合合法：

```ts
EvaluatorOutput = {
  score?: number          // 0-100，卡片总分。纯定性评估器可省
  points?: EvalPoint[]    // 评分点（最多 64）
  evidence?: {md} | {json} // 卡级证据
}

EvalPoint = {
  label: string           // 必填，≤120 字
  score?: number          // 0-100，该点得分
  status?: 'covered' | 'partial' | 'missing'  // 状态 chip
  evidence?: {md} | {json}
  skillAttributable?: boolean  // 可归因 skill → skill 优化闭环据此挑 finding
  suggestion?: string
  anchors?: string[]      // 'step-N'，可跳链路观测
}
```

**归一化 `normalizeEvaluatorOutput()` 的行为**（务必知道，否则会被"吞字段"坑到）：

- `score` 越界 clamp 到 [0,100]；非数值丢弃。
- **0-1 量纲自动放大**：`score ∈ (0,1]` 且非整数时 ×100。所以要给 100 分必须显式写 `100`，写 `1` 会被当成 1 分。
- 非法评分点逐条丢弃，不会让整次评估失败。

---

## 3. 打分方法论（核心）

### 3.1 反模式：让 LLM 自由打 0-100

LLM 不擅长"回归"。自由打分的表现是：分数扎堆（总在 70-90）、同一条重跑分数飘、绝对值无法解释。**任何新评估器都不要直接让模型输出一个连续分**。

### 3.2 正路一：分解 + 确定性汇总（首选）

让 LLM 只做**离散的原子判断**，代码按固定公式算总分。系统里绝大多数评估器都是这么做的：

| 评估器 | 原子判断 | 汇总 |
|---|---|---|
| 任务完成度 | 每个参考关键观点 覆盖/部分/缺失 | 加权均分 |
| 准确性 | 每条主张 correct/partially_correct/wrong | (Σ 分)/(判定数) |
| 忠实度 | 每条主张 supported/contradicted/not_covered | 有据数/总数 |
| 指令遵循 | 每条约束 met/not_met/n.a. | 达成比例 |
| 答案质量 | 逐句相关性 + 逐要点完整性 + 连贯性评级 | 三子分合成 |

好处：LLM 做"分类"比"打分"稳得多；分数可追溯到每一条判断；前端天然有评分点可展示。

### 3.3 正路二：锚定档位（整体判断用）

实在无法分解的整体维度（如"工具选择是否合理"），用**三档锚定**，每档写清判据，让模型对号入座：

```
- 1.0 合理   —— 调用都符合意图，该用 Skill 脚本处用了，无明显错误选择
- 0.5 部分合理 —— 大体正确但有个别偏差
- 0.0 不合理  —— 多数调用跑偏、用错工具
```

代码侧再做一次**吸附**兜底（`opencode-trajectory-evaluator.ts` 的 `snap3()`），把模型漂移的连续值吸到最近一档。

**为什么是三档**：问卷学的信度到 5~7 档封顶，而 LLM 比人更要往少了走；更重要的是——系统既有的原子判断本来就是三档（covered/partial/missing、met/not_met/n.a.），跟着用口径统一。**档数其次，把每档判据写具体才是关键**，只给数字不给定义，加再多档也没用。

### 3.4 铁律：未达标必须计入分母

**"没做到"要体现在分数上**，不能悄悄排除。

- 完成度：缺失的关键观点算 0，进均分。
- 忠实度：无依据的主张算 0，进比例。
- 准确性：说错的主张算 0，进分母。

**唯一可以排除的是"无从判定"**，而且必须在证据里写清原因。例如准确性里 `not_in_reference`（参考答案压根没涉及这条主张）——既不能算对也不能算错，排除出分母，前端显示 `—` 并在证据写明「参考答案未涉及此主张——不计入准确性分母」。

> 曾经的反例：准确性把"参考里有但输出没提"的点排除出分母，导致 **4 个点 3 个未覆盖却拿 100 分**。根因是点取错了边（见 §3.5）。

### 3.5 三轴不要撞车：精确率 / 召回率 / 有据性

评分点**从哪一侧提取**，决定了这个评估器在测什么。这是最容易设计错的地方：

| 评估器 | 评分点来自 | 对什么核 | 回答 |
|---|---|---|---|
| **完成度** | 参考答案 | 实际输出 | 该说的说全了吗（**召回**） |
| **准确性** | **实际输出** | 参考答案 | 说的都对吗（**精确**） |
| **忠实度** | **实际输出** | trace 证据 | 说的有执行依据吗（**防脑补**） |

- 准确性与忠实度**共用同一批主张**（一次抽取、两处判定，见 §6.3），只是判定对象不同——这是合理的一体两面。
- 完成度取参考答案的要点，跟它们不重叠。
- **新增评估器时先问自己：我的评分点该从哪一侧取？** 取错边会立刻和既有评估器语义重复（历史上准确性和完成度都取参考侧，导致两张卡评分点一模一样）。

---

## 4. 新增一个预置评估器

### 4.1 文件清单

| 步骤 | 文件 |
|---|---|
| ① 登记卡片（名称/描述/评分区间/标签） | `src/lib/evaluators/preset-evaluators.ts` |
| ② 登记元数据（类目 + 前置条件） | `src/lib/evaluators/registry.ts` 的 `PRESET_META` |
| ③ 写实现 | `src/lib/engine/experiment/*-preset-evaluators.ts`（或复用 `engine/evaluation/` 下的 canonical 能力） |
| ④ 接分发 | `run-experiment.ts` 的 `runEvaluatorById`（若沿用现有 `isResultPresetId` 这类前缀判断则无需改） |

### 4.2 元数据怎么填

```ts
'preset-your-evaluator': { category: 'res' | 'traj', requires: ['reference'] | [] },
```

- **category**：只读最终输出（±参考答案）→ `res`；需要读执行过程（步骤/工具/耗时/成本/token）→ `traj`。决定它在 Trace 评测详情里归到「结果评测」还是「轨迹评测」板块，以及进哪个类目均分。
- **requires**：填 `['reference']` 表示必须有参考答案。实验向导 ④ 步是**硬门控**——任一 case 没标注参考，该评估器整体置灰不可选。别在实现里假设参考一定存在，仍要兜底（`ctx.referenceOutput` 可能为空）。
- **tags 不用填**，由元数据派生（`deriveEvaluatorTags`）。

### 4.3 实现签名

```ts
// ctx: FaithfulPresetContext —— caseInput / actualOutput / referenceOutput /
//      interactions / execution / traceSummaryText / user
async function runYourEvaluator(user: string, ctx: FaithfulPresetContext): Promise<EvaluatorOutput> {
  // 1) 取输入。注意 input/actualOutput 在 trace 模式下由引擎从 Execution 兜底解析
  // 2) 调模型做**离散判断**（见 §3.2/§3.3），别让它直接给连续分
  // 3) 代码汇总成 score + points
  return normalizeEvaluatorOutput({ score, points, evidence });
}
```

---

## 5. 新增自建 LLM 评估器（无需改代码）

评估器中心 → 新建，只填**评估提示词**（三段式由系统组装，不要自己拼 system/user）。

- 占位符：`{{query}}`、`{{actual_output}}`、`{{reference_output}}`、`{{trace_summary}}`。
- **`requires` 自动推导**：提示词里用到 `{{reference_output}}` → 自动标记依赖参考数据，向导 ④ 步随之门控。
- 可选填「评分点清单」：填了就按清单逐条判定（等价于 §3.2 的分解），留空则自由模式。**建议填**。

---

## 6. 工程坑位（都踩过）

### 6.1 `0` 分不能丢

`if (score) pt.score = score` 这类**假值判断会吞掉 0 分**。必须用 `typeof score === 'number'`。0 分是有意义的信号（判错了），丢了会让前端显示 `—`，用户以为"没评"。

### 6.2 LLM 输出 schema 要宽容

模型经常把对象写成字符串。schema 用 `z.preprocess` 兜一层，别让整次评估因为一个字段类型挂掉：

```ts
const issueSchema = z.preprocess(
  (v) => (typeof v === 'string' ? { quote: v } : v),
  z.object({ quote: z.string().min(1), reason: z.string().default('') }),
);
```

同理，**不要因为模型自报的 `score` 与 `status` 不一致就抛异常**——以 status 为准推导分数即可。

### 6.3 共享抽取，别重复调模型

准确性与忠实度都需要「从实际输出抽主张」。抽取只依赖 `(query, finalResult)`，因此统一走 `faithfulness-evaluator.ts` 的 `extractOutputClaims()`——它按二者哈希缓存，同一 case 内谁先跑谁抽，另一个直接命中。新增评估器如果也要主张列表，复用它，别再写一份。

### 6.4 改 canonical 口径要升版本号

`result-*` 系列共用 `RESULT_METRIC_VERSIONS`（`result-quality-evaluator.ts`）。**口径变了就升主版本**，否则历史缓存会被当成"可复用"直接返回旧分：

```ts
// 3.0.0：口径由「参考关键观点被覆盖了多少」改为「实际输出的主张对不对」(精确率)，
// 与旧分不可比，升主版本让历史缓存失效重算。
accuracy: '3.0.0',
```

并且要意识到：**旧数据不会自动重算**。页面上没重评过的 case 仍是旧口径结果，排查问题时先确认这条 case 是什么时候评的。

### 6.5 前端呈现约定

Trace 评测详情（`app/(main)/experiments/[id]/cases/[caseId]/page.tsx`）的评分点表是「评分点 / 得分 / 证据」三列：

- **得分列显示 `—`** 只应有一种含义：**该点不参与计分**（无从判定）。任何"未达标"都必须给 0，不能留空。
- **证据**用 markdown，`EvidenceBlock` 自动识别 md/json 并默认折叠。层级明细（如完整性下挂的每条关键动作覆盖）**写进证据 md**，不要另造嵌套行结构——统一走同一套渲染更一致。
- 状态 chip 与得分**同时给**：chip 表达定性（已覆盖/部分/未覆盖），分数表达定量，两者不矛盾。

---

## 7. 自测清单

提交前逐条过：

- [ ] `npx tsc --noEmit` 零错误
- [ ] `npm test` 无新增失败
- [ ] **真跑一条**：在实验详情页对目标 case 单项重评，确认出分且**每个评分点都有证据**
- [ ] 未达标的点确实是 `0` 而不是 `—`
- [ ] 有分必有据：不存在"给了分但证据为空"的评分点
- [ ] 若改了 canonical `result-*`：升了版本号，并确认「可靠性与性能」页不回归
- [ ] 若依赖参考答案：`requires` 填了 `['reference']`，且实现里对空参考有兜底

---

## 8. 现有预置评估器速查

| id | 名称 | 类目 | 依赖参考 | 评分点来自 | 口径 |
|---|---|---|---|---|---|
| `preset-agent-task-completion` | 任务完成度 | res | ✅ | 参考答案 | 关键观点覆盖率（召回） |
| `preset-agent-trace-quality` | 轨迹质量 | traj | — | 三维度 | 完整性(关键动作覆盖) + 工具选择(三档) + 冗余度(三档) |
| `preset-result-accuracy` | 结果准确性 | res | ✅ | 实际输出主张 | 对参考判对错（精确） |
| `preset-result-answer` | 答案质量 | res | — | 三子维度 | 相关性/完整性/连贯性 |
| `preset-result-faithfulness` | 忠实度 | res | — | 实际输出主张 | 对 trace 证据判有据（防脑补） |
| `preset-result-instruction` | 指令遵循 | res | — | 输出约束 | 约束达成比例；无约束时不计分 |
