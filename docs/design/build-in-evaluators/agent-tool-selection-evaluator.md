# Agent 工具选择合理性预置评估器

> 归档目标：`docs/design/build-in-evaluators/agent-tool-selection-evaluator.md`
> 关联需求：openEuler Issue #163
> 更新时间：2026-08-04

## 1. 定位与前置条件

`preset-agent-tool-selection` 是轨迹类预置评估器，用于判断 Agent 是否选对了 Tool/Skill、传对了参数、利用了结果并遵守依赖顺序。它与“工具利用率”互补：利用率关注目录级覆盖和调用比例，本卡关注每次选择的任务语义与执行链路。

评估对象为 Tool 与 Skill；Agent/任务委派节点不进入五维评分。评估器需要显式 Tool/Skill 目录，目录来源与门控规则见 [`agent-tool-utilization-evaluator.md`](agent-tool-utilization-evaluator.md)：实验 `evaluatorContext`、数据集 `available_tools`/`available_skills` 或界面手动 JSON。Trace 不能提供未调用能力目录。

## 2. 输入与事实锚定

评估器向 Judge 提供用户问题、目录描述以及 `ToolTraceFacts`：能力类型、名称、参数、结果、状态、顺序、次数和 `step-N` anchor。Judge 的问题必须能落到显式目录或真实调用：

- `missing_required_tool`：锚定目录能力，`stepIndex=null`；
- 其他调用问题：锚定真实步骤，能力名和类型以结构化事实为准；
- 无法命中目录或步骤的问题写入 `statistics.discardedJudgeIssues`，不参与评分、建议或封顶。

这样可以避免 Judge 虚构一个 Trace 中不存在的步骤，或者把目录中没有的能力当作遗漏。

## 3. 五个评分维度

五维各占 20%，Judge 只返回 `met`、`partial`、`missing`，代码映射为 100、50、0：

| 维度 | 判定重点 |
|---|---|
| `tool_necessity` | 是否只选任务所需能力，是否避免无关或重复调用 |
| `tool_match` | 所选 Tool/Skill 是否能完成当前子任务，是否选错核心能力 |
| `parameter_validity` | 参数是否来自用户问题、上下文或前序结果，是否符合目录 schema |
| `result_utilization` | 是否读取并正确使用关键结果，是否忽略或违背工具返回 |
| `call_order` | 是否满足数据依赖和先读后写、先查询后更新等顺序 |

总分为五维等权平均，统一输出 0–100。每个维度必须给出可核验 `reason`；不允许只写“选择合理”这类结论。

## 4. 问题类型与严重度封顶

Judge 的问题使用白名单 code，并包含 `severity`、Tool/Skill 名称、类型、`stepIndex`、原因和建议：

| code | 含义 | 总分上限 |
|---|---|---:|
| `missing_required_tool` | 遗漏显式目录中完成任务所需的能力 | 20 |
| `hallucinated_critical_argument` | 关键参数无来源且会改变任务结果 | 40 |
| `wrong_core_tool` | 选择了不能完成核心子任务的能力 | 50 |
| `ignored_key_result` | 忽略或违背关键工具结果 | 50 |
| `dependency_order_violation` | 违反必要的数据/执行依赖顺序 | 50 |
| `irrelevant_call` | 调用了与任务无关的能力 | 不单独封顶 |
| `redundant_call` | 重复调用且无新增信息 | 不单独封顶 |
| `invalid_argument` | Judge 判断参数格式或 schema 存在问题 | 不单独封顶 |
| `other` | 有证据但不属于上述类型的问题 | 不单独封顶 |

代码对已锚定问题应用最低总分上限；多个严重问题取最低上限。普通参数格式错误只影响 `parameter_validity`，不自动升级为“关键参数幻觉”。

## 5. 参数判断与问题锚定

`parameter_validity` 由 Judge 结合用户问题、Tool/Skill 目录、调用参数与前序结果进行判断。代码侧通过输出契约校验、问题类型映射和真实调用/目录锚定，确保 `invalid_argument` 等问题有可核验的 `step-N` 或目录能力；未能落到显式目录或真实调用步骤的问题会被丢弃，不参与评分、封顶或建议。

当前实现没有独立的 JSON Schema 规则层，不会由代码自动检查 `required`、`properties`、`enum`、数组 `items` 或 `additionalProperties` 并生成 `invalid_argument`。复杂或缺少目录依据的参数问题交给 Judge 结合任务上下文判断；因此 `invalid_argument` 仅表示 Judge 返回并通过结构校验、事实锚定的问题，不代表存在确定性 Schema 校验器。

## 6. 输出与卡片展示

卡级 evidence 保存：

- `rubricVersion: "1.0.0"`；
- `summary`：一句话结论，例如“5 个选择维度全部达成，参数和调用顺序均与任务依赖一致。”；
- 五维的 verdict、分数、原因和 `step-N` 证据；
- 经过事实锚定的问题、应用的最低封顶、`discardedJudgeIssues` 和改进建议。

页面按项目通用评估器卡片展示：顶部为摘要和总分，展开后是五个评分点及证据，再展示问题与建议；原始结构化 JSON 只作为 evidence 数据保存，不直接铺在结果正文。

## 7. Prompt 与实现位置

- Judge Prompt：`src/prompts/agent-tool-selection-prompt.ts`
- 评估器与封顶：`src/lib/engine/experiment/agent-tool-selection-evaluator.ts`
- Tool/Skill 目录契约：`src/lib/evaluators/evaluator-case-context.ts`
- 轨迹事实：`src/lib/engine/experiment/agent-tool-trace-facts.ts`
- 注册和卡片元数据：`src/lib/evaluators/registry.ts`、`src/lib/evaluators/preset-evaluators.ts`

对应测试位于 `test/agent-tool-preset-evaluators.test.ts`、`test/agent-dataset-dynamic-fields.test.ts` 和 `test/experiment-dataset-match.test.ts`，覆盖五维聚合、Tool/Skill、问题 anchor、五类封顶、多个封顶取最低以及虚构问题丢弃。

## 8. 兼容与非目标

目录缺失时不运行或返回不计分结果；显式空目录表示任务无需 Tool/Skill。旧 Case、旧请求和 `preset-agent-trace-quality` 保持兼容。32 条工具选择示例用于验收验证，不进入生产 Prompt，也不作为单独的规则分支。
