# 03 Phase 分析流程

本文定义完整诊断阶段。脚本负责确定性阶段，智能诊断 agent 负责语义补充与根因归因。

## Phase 0：致命故障预检

Phase 0 的目标是判断本次执行是否在有效认知过程展开前就被系统性问题打断。

短路条件示例：

- 连续认证失败，例如多个 step 出现 401、Unauthorized、AuthError。
- 上下文溢出或输出长度限制导致后续步骤无法继续。
- 同一基础工具连续系统性不可用，且不是 Agent 参数误用。
- 任务很早就被用户或系统取消。

不要短路的情况：

- `tree: command not found` 这类命令选择问题，通常属于 Action 或 Planning。
- `No such file` 这类路径问题，通常属于 Action 或 Memory/Planning 的下游。
- 单次工具失败后 Agent 仍有机会修正。

脚本会先输出 `triage`。如果 `triage.shortCircuited=true`，不要补造 Memory/Reflection/Planning/Action 问题，直接生成系统性根因报告。

## Phase 1：模块级检测

Phase 1 输入是 `stepRecords`。每个 step 的模块分开判断：

- Memory：基于 prior facts 判断是否幻觉、漏召回、过度简化。
- Reflection：基于上一步 Action/System 判断是否误读结果、假成功、漏失败。
- Planning：基于任务约束、用户要求、同 step Action 判断是否计划错误。
- Action：基于真实工具调用判断路径、参数、命令、格式、危险动作。
- System：基于外部环境证据映射系统错误。

执行原则：

1. 对全部 step 分析，不使用候选窗口裁剪。
2. step 之间按时间顺序分析，确保 priorWindow 稳定。
3. 同一个 step 内各模块互不倒推。
4. 空模块不作为错误。
5. Action/System 的确定性错误优先相信脚本。
6. LLM 只补脚本无法静态判断的语义问题。

## Phase 1 静态脚本输出

`scripts/agentdebug_static.py` 会输出：

- `triage`
- `stepRecords`
- `phase1Grid`
- `issues`
- `staticSummary`

其中 `phase1Grid` 和 `issues` 只包含脚本确定发现的问题。智能诊断 agent 可以追加语义问题，但不能删除脚本的事实证据，除非证据明显来自正常文档内容误判。

## Memory 语义检测

检查当前 Memory 是否严格对应 prior facts：

- 文件名、路径、函数名、行号是否真实出现过。
- 用户约束是否真实由用户提出。
- 是否把多个关键事实压成模糊总结而导致后续误判。
- 是否引用了被 edit 后已过期的文件内容。

输出时必须说明违反了哪条 prior fact。

## Reflection 语义检测

检查当前 Reflection 是否正确评价上一步：

- 上一步工具失败时，Reflection 是否承认失败。
- 上一步测试失败时，Reflection 是否误称通过。
- 上一步输出警告或部分失败时，Reflection 是否忽略。
- 当前任务还未完成时，是否过早宣称完成。

输出时必须引用上一步工具状态或输出片段。

## Planning 语义检测

检查当前 Planning 是否合理：

- 是否违反用户或系统约束。
- 是否依赖不存在的工具、资源或能力。
- 是否计划修改错误文件。
- 是否计划与同 step Action 不一致。
- 是否对简单任务过度工程化。

Planning 留白本身不是错误。只有当同 step 存在写入、删除、破坏性动作时，才可标记 `no_explicit_plan`。

## Action 语义检测

Action 的静态错误由脚本优先处理。智能诊断 agent 只在必要时补充 `tool_misuse`：

- 明显应该搜索却读取大量无关文件。
- 明显应该读文件却直接修改。
- 明显应该验证路径却直接沿用假设路径。

不要因为工具失败就自动标记 `tool_misuse`；必须说明更合适的工具或动作是什么。

## System 检测

System 完全由事实映射，不需要 LLM 推断：

- `ContextOverflowError` -> `context_overflow`
- `OutputLengthError` -> `llm_limit`
- `AbortedError` -> `user_aborted`
- `AuthError` -> `auth_failure`
- `StructuredOutputError` -> `schema_violation`
- 单步超时 -> `step_timeout`
- 其他工具或环境失败 -> `tool_execution_error` 或 `environment_error`

## Phase 2：根因归因

Phase 2 只选择一个最关键根因。输入包括：

- Phase 1 错误网格。
- 完整 step 时间线。
- 任务描述。
- 最终结果或评测失败原因。

判定原则：

1. 找最早的、修复后最可能扭转轨迹的错误。
2. 找因，不找果；后续级联错误通常不是根因。
3. 前 1-2 个记录多为探索，除非有明确高置信错误，否则谨慎作为根因。
4. Action/System 可以是根因，但不要因此自动给 Planning 背锅。
5. 如果证据不足，宁可降低置信度，也不要编造级联链路。

输出必须包含：

- `criticalStep`
- `criticalModule`
- `criticalErrorType`
- `summary`
- `evidence`
- `cascadingChain`
- `correctionGuidance`
- `confidence`

## 合并规则

- 脚本 issues 与 LLM issues 去重，去重键为 `step + module + errorType`。
- 对同一事实，保留证据更具体、置信度更高的一条。
- `issues` 必须是 `phase1Grid` 中 `errorDetected=true` 的扁平子集。
- `rootCause` 必须来自 `phase1Grid` 中实际存在的错误，不能选择空模块。
