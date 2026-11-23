# 自定义评估器数据集输入变量：需求设计

## 变量契约

| 变量 | 用户界面名称 | 运行时来源 |
|-|-|-|
| `{{input}}` | 实际任务输入 | Execution query 或 ExperimentCase input |
| `{{dataset_input}}` | 数据集输入 | 匹配 case 的 input 快照 |
| `{{output}}` | 实际输出 | 本次执行结果 |
| `{{reference_output}}` | 预期输出 | 同一匹配 case 的 expectedOutput 或实验预期输出快照 |
| `{{trajectory}}` | 执行轨迹 | 本次实际轨迹摘要 |

`dataset_input` 是可选依赖。只有提示词实际引用它时才触发数据集匹配和门控。

## 匹配规则

可用性采用确定性包含匹配：

1. 对实际输入和数据集输入执行首尾空白清理与连续空白折叠。
2. 仅当 `normalizedTaskInput.includes(normalizedDatasetInput)` 时命中。
3. 多项命中选择规范化输入最长的 case；相同长度保持数据集原顺序。
4. 显式绑定的 dataset/case 仍需满足同一包含规则。
5. `dataset_input` 门控禁用语义匹配；只依赖 `reference_output` 的存量流程保留现有行为。

匹配范围优先使用当前评测传入的 `allowedDatasetIds`。未提供范围的旧入口沿用当前用户可用
数据集范围，但会在结果快照中记录最终命中的 dataset/case。

## 门控与运行时

注册元数据增加 `dataset_input` requirement。自定义 LLM 评估器的 System/User Prompt 任一处
引用 `{{dataset_input}}` 即自动派生该依赖。

- 实验向导：全部已选 case 都有数据集输入确定性匹配时才允许选择该评估器。
- 运行时：再次校验，避免旧数据、直接 API 调用或数据变化绕过向导。
- 多评估器运行：数据集输入不匹配只使依赖该字段的自定义评估器不适用，不阻塞无需该字段的
  评估器；不适用结果不计入分数聚合。

## 数据模型

`ExperimentCase` 新增可空 `datasetInput`，保存创建实验时匹配到的数据集输入快照。

- 新实验在从数据集导入或按数据集 case 生成 Trace 时写入。
- 现有 Trace 但未导入数据集时保持 `null`。
- 历史记录无需回填；引用 `dataset_input` 的评估器对这些 case 置为不可用。
- 读取与写入 API 增量返回/接收该字段，旧客户端可忽略。

Trace 评测已有 `caseEntry.input` 和 `caseSnapshot.input`，无需新增表字段。

## 兼容性

- 保留 `reference_output` key，只将展示文案统一为“预期输出”。
- 不引用 `dataset_input` 的存量评估器不增加数据集依赖。
- `dataset_input` 可单独使用，不要求 case 同时存在 `expectedOutput`。
- 同时引用 `dataset_input` 与 `reference_output` 时，匹配必须要求同一 case 的
  `expectedOutput` 非空。
