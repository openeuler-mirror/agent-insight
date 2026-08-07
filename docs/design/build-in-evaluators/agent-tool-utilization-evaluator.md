# Agent 轨迹工具利用率预置评估器

> 归档目标：`docs/design/build-in-evaluators/agent-tool-utilization-evaluator.md`
> 关联需求：openEuler Issue #163
> 更新时间：2026-08-04

## 1. 定位与前置条件

`preset-agent-tool-utilization` 是轨迹类预置评估器，用于判断 Agent 对可用 Tool/Skill 目录的覆盖、匹配和调用节制程度。它统计 Tool 与 Skill，不统计 Agent 节点、任务委派节点或子代理本身。

这张卡需要显式的 Tool/Skill 目录：

- 实验 API 的 `evaluatorContext`；
- 数据集字段 `available_tools` 和可选 `available_skills`；
- 新建实验或数据项页面中的手动 JSON 字段。

Trace 只能还原“实际调用过什么”，不能还原执行时的完整可用能力集合。不能用已调用集合反推目录，否则会产生选择偏差并掩盖遗漏能力。目录缺失时卡片门控或运行时返回“不计分”；`availableTools: []`（且没有 Skill）是显式确认无需能力，可以正常得到合理闲置分。

## 2. 目录和轨迹事实

目录归一化为 `tool`/`skill` 两类 capability，按 `kind + canonicalName` 去重。同名 Tool 和 Skill 不互相覆盖。OpenCode/Jiuwen 的 `skill`、`load_skill`、`skill_view`、`skill_tool` 是加载入口，不作为独立 Tool；实际 Skill 以 `skill:<name>` 出现在 `available_skills` 中。

评估器从 Agent 树提取 `ToolTraceFacts`，每次调用保存：能力类型、名称、参数、结果、状态、调用顺序、`step-N` anchor 和次数。Agent/任务委派事件被排除。Judge 接收压缩后的目录与事实，不解析展示文本。

## 3. Judge 的职责：能力三档分类

Judge 按目录顺序对**每一个** Tool/Skill 分类：

- `required`：完成当前任务必须使用，缺失会使结果不可靠或无法完成；
- `optional`：可提高效率、验证或表达质量，但存在等价替代，不调用不扣分；
- `irrelevant`：与当前任务无关，调用它反而引入噪声或风险。

Judge 还可以为实际调用给出负向 `callFindings`，每项必须锚定真实 `step-N`：`out_of_catalog`、`irrelevant`、`redundant` 或 `ineffective`，并说明原因。Judge 不输出维度分数；三档分类和调用事实是代码计算的输入。

## 4. 三个主比例与评分公式

设目录分类集合为 `R`（required）、`O`（optional）、`I`（irrelevant），真实 Tool/Skill 调用总数为 `N`。

### 必要能力覆盖率（50%）

```text
requiredCoverage = |{r∈R : r 至少调用一次}| / |R| × 100%
```

没有必要能力时为 N/A，不把“没有必要能力”扣成 0。

### 调用匹配率（25%）

```text
callMatch = 调用到 R 或 O 的次数 / N × 100%
```

没有任何调用时为 N/A。目录外调用和 `irrelevant` 调用只影响该比例。

### 调用节制率（25%）

令相关调用为调用到 `R` 或 `O` 的调用，`effective` 表示没有被标记为 `redundant` 或 `ineffective`：

```text
callRestraint = effective 相关调用次数 / 相关调用次数 × 100%
```

没有相关调用时为 N/A。重复或无效的相关调用只影响该比例。

总分按有效比例的原始权重重归一：

```text
score = round( Σ(valid metric) weight × metric / Σ(valid metric) weight )
```

没有必要能力且没有调用表示题目合理闲置，得 100。没有低覆盖率封顶，也不设置机械的“频次均衡”扣分；合理闲置只作为证据和建议呈现。

一次调用只能影响一个比例：目录外/无关调用影响 `callMatch`，重复/无效相关调用影响 `callRestraint`，未调用必要能力影响 `requiredCoverage`，避免同一问题被重复扣分。

## 5. 输出与卡片展示

输出 evidence 至少包含：

- `rubricVersion: "1.0.0"`；
- `summary`：一句话总结，例如“必要能力覆盖完整，相关调用集中且没有明显闲置调用。”；
- 三个比例及其分母、分子、权重和 N/A 原因；
- `capabilityClassifications`：必要、可选、无关三组，每项包含能力名、类型、调用次数和 Judge 依据；
- `callFindings`、问题列表、改进建议和 `step-N` anchors。

卡片顶部展示摘要与总分，展开后展示三个比例和三档能力清单；不直接展示未格式化的 Judge JSON。Judge 的“必要能力 2 项”之类的表述必须能在清单中逐项核验。

## 6. 实现位置与测试边界

- Judge Prompt：`src/prompts/agent-tool-utilization-prompt.ts`
- 评估器、比例计算和证据聚合：`src/lib/engine/experiment/agent-tool-utilization-evaluator.ts`
- Tool/Skill 目录契约与归一化：`src/lib/evaluators/evaluator-case-context.ts`
- 轨迹事实提取：`src/lib/engine/experiment/agent-tool-trace-facts.ts`
- 共享输出契约：`src/lib/engine/experiment/specialized-evaluator-common.ts`
- 测试：`test/agent-tool-preset-evaluators.test.ts`、`test/experiment-dataset-match.test.ts`、`test/agent-dataset-dynamic-fields.test.ts`

测试覆盖必要/可选/无关分类、Tool/Skill 混合目录、合理闲置、N/A 分母、零分保留、重复/失败/未知调用、目录缺失和显式空目录。8 条工具利用率示例只作为验证输入，不在代码里按题目名称分支。

## 7. 兼容与非目标

新增目录字段是可选的；旧 Case 和旧 API 请求不受影响。缺目录不伪造低分，旧 `preset-agent-trace-quality` 的分数和轨迹摘要不变。本卡不负责自动从 OpenCode、MCP 网关或 Trace 推导完整目录；自动目录采集应作为独立采集器契约设计。
