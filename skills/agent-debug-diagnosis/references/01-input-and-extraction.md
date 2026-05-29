# 01 输入协议与四模块拆分

本文定义如何把 Agent Insight 输入转成 AgentDebug 的 step 记录。执行时必须先运行 `scripts/agentdebug_static.py`，再由智能诊断 agent 对脚本结果做语义补充。

## 输入文件

后端会提供 `.agent-insight/agent-debug-input.json`，结构如下：

- `execution`：执行记录，包含任务、失败摘要、评分和评测原因。
- `turns`：归一化后的 assistant/subagent/opencode 可见 turn。
- `traceBundle`：长文本 trace 资料包路径。

`turns` 是主事实源。trace bundle 只在证据缺失或需要确认锚点时读取。

## 内部记录与左侧节点

一个 `stepRecord` 等于一个归一化的 assistant/subagent/opencode 可见 turn，用于认知拆分。它不是左侧执行链路里的每一个 atomic node。左侧执行链路可能把用户输入、模型调用、工具调用、Skill 调用都拆成独立节点；一个可见 turn 可能包含多个工具节点。

每个 `stepRecord` 输出：

- `step`：兼容字段，优先填左侧 trace 节点编号。
- `diagnosticStep`：AgentDebug 内部连续诊断序号，仅用于调试，不用于 UI 主展示。
- `traceStepIndex`：左侧执行链路节点编号，用户界面和跳转文案以它为准。
- `traceNodeLabel`：左侧节点标题，例如 `模型调用 · OpenAI`、`工具调用 · bash tree ...`。
- `traceNodeKind`：左侧节点类型，例如 `llm`、`tool`、`skill`、`task`、`agent`。
- `sourceInteractionIndex`：原始 interaction 下标。
- `title`：可使用 `traceNodeLabel`。
- `inputContext`：当前 step 可见输入或历史摘要。
- `agentOutput`：reasoningText 与 text 的可见输出拼接。
- `environmentResponse`：工具或环境返回的最短有用证据。
- `anchorId`：可定位到 trace 的锚点。
- `modules`：Memory、Reflection、Planning、Action、System。

定位规则：

- Action/System 类问题优先使用具体工具调用的 `anchorId`、`traceStepIndex`、`traceNodeLabel`。
- Planning/Memory/Reflection 类问题使用当前 LLM/assistant turn 的 `anchorId`、`traceStepIndex`、`traceNodeLabel`。
- `rootCause` 和 `cascadingChain` 必须保留同样的左侧节点定位字段，方便 UI 跳转。
- 不要在自然语言字段里写“诊断 Step 2”“Turn 2”这类内部编号；如需说明位置，写“左侧节点 #n”或直接依赖结构化字段。

## 拆分优先级

遵循 v0.4 原则：

1. 能直接读字段的绝不调 LLM。
2. `reasoningText` 优先于普通 `text`。
3. 普通 `text` 优先于弱推断。
4. Action 与 System 必须确定性提取。
5. Memory、Reflection、Planning 允许留白。

## Action 拆分

Action 是事实，不是判断。脚本必须从真实 `toolCalls` 生成：

- 工具名。
- 入参或命令。
- 状态：`ok`、`error`、`unknown`。
- 输出或错误摘要。

没有真实工具调用，也没有明确动作标签时，Action 留白。禁止根据最终结果编造 Action。

## System 证据拆分

System 不属于四个认知模块，但作为外部证据保存在 `modules.system`。以下情况进入 System：

- tool status 是 `error`。
- rawError、stderr、timeout、auth failure、quota、context overflow。
- shell 类工具输出 `command not found`、`No such file`、traceback、非零退出、权限错误。

正常文档内容里出现 “error/failure/故障” 不算 System 错误。

## Memory 拆分

Memory 表示 Agent 回忆或依赖过去信息：

- 引用之前工具结果。
- 引用用户前文约束。
- 引用过去读过的文件、路径、日志、报错、修改。
- 使用“之前、刚才、上一步、根据刚才输出”等表达。

首个记录默认 Memory 留白，除非明确引用 trace 前已有历史。

## Reflection 拆分

Reflection 表示 Agent 对先前动作结果、当前进度或任务状态的评价：

- 判断上一步成功、失败、部分成功。
- 解读工具输出。
- 判断当前进度。
- 修正先前认知。

首个记录默认 Reflection 留白，除非明确评价 trace 前已有上下文。

## Planning 拆分

Planning 表示 Agent 对下一步的计划、策略、todo 或工具意图：

- “接下来我要...”
- “我会先...然后...”
- todo/task list。
- “先读取日志文件”“运行测试确认”等工具意图。

当前产品允许 Planning 留白。留白本身不是错误。只有当同 step 出现写入、删除、破坏性动作等高风险操作时，才把缺少显式计划作为 `no_explicit_plan` 风险。

## 来源与置信度

输出字段 `source` 使用当前 UI 支持的枚举：

- `tag`：明确标签。
- `raw_tool`：真实工具调用。
- `implicit`：可见文本或规则抽取。
- `system`：外部系统证据。
- `llm`：语义补充判断。

置信度建议：

- 真实工具调用：`0.95`。
- 明确标签：`0.85-0.9`。
- 规则命中：`0.65-0.8`。
- LLM 语义抽取：`0.5-0.75`。
- 留白：`0`。

## 全量分析要求

不要使用候选窗口裁剪 trace。脚本和智能诊断 agent 必须对输入文件中的全部 `turns` 建立 `stepRecords`，并对全部记录做 Phase 1 检测。

原始故障类报告中的 failures 只能作为任务背景和最终对照，不应限制分析范围，也不应决定根因。
