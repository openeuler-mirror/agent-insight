# 通用实验 Trace 生成：需求分析

## 背景

实验向导当前只加载内置可靠性数据集。用户选择“生成 Trace”后，服务端把所有 Case 都送入故障注入编排，因此普通 `ideal_output`、`trajectory` 评测数据集无法用自身 `input` 驱动 Agent 生成 Trace 并继续评估。

仓库已经具备客户端白名单动作 `RUN_EXPERIMENT_CASE`，可以接收结构化的 `platform`、`model` 和 `input` 并启动 Agent，但实验域尚未接入该动作，也没有保存普通 Trace 生成的指令、状态和错误。

## 目标

1. 新建实验时可选择任意评测数据集类型。
2. “生成 Trace”以所选数据集 Case 的 `input` 作为 Agent 用户输入。
3. 普通数据集通过 `RUN_EXPERIMENT_CASE` 生成 Trace；可靠性数据集继续通过 FI 编排生成带故障的 Trace。
4. Trace 入库后绑定回原 `ExperimentCase`，再运行用户选择的评估器。
5. 单个 Case 生成失败时可追踪指令和错误；部分成功时只评估成功 Case。
6. 普通生成必须使用客户端返回的 Trace ID 精确绑定，禁止以输入文本推测关联。
7. 临时失败自动重试；自动重试耗尽后复用 Case 操作列的统一“重试”入口。

## 非目标

- 不新增 Agent 执行协议或自由 Shell 执行能力。
- 不改变数据集 Case 的输入、预期输出和自定义字段定义。
- 不改变已有 Trace 模式、自动监听或评估器评分逻辑。
- 不把普通 Trace 生成伪装为无故障 FI Run。

## 验收标准

- `ideal_output`、`trajectory`、`reliability` 数据集均可在实验向导中选择。
- 每种数据集的 Case 都可被勾选并以 `input` 生成 Trace。
- 普通数据集不创建 `FaultInjectionRun`；可靠性数据集行为保持兼容。
- 通用生成指令成功且 Trace 可用后，Case 保存 `executionId`、`taskId` 和实际输出并进入评估。
- 指令失败、Trace 为空或等待超时会显示为 Trace 生成失败且不计分。
- 相同输入、输入格式化或并发实验不会导致 Trace 串绑；客户端不返回 Trace ID 时明确失败。
- Trace 生成默认最多尝试三次；最终失败后可在原实验、原 Case 上手动重试。
