# 02 错误词表

本文定义 Phase 1 可使用的错误类型。枚举值保持英文，中文说明用于诊断和 UI 展示。

## Memory

| 错误 ID | 中文名 | 判定要点 | 默认严重度 |
| --- | --- | --- | --- |
| `hallucination` | 记忆幻觉 | 引用了 prior facts 中不存在的事实、文件、路径、用户要求。 | high |
| `memory_retrieval_failure` | 召回失败 | prior facts 中有关键事实，但 Memory 未召回，导致后续判断缺依据。 | medium |
| `over_simplification` | 过度简化 | 把多个关键事实压缩成模糊总结，丢掉会影响决策的细节。 | low |
| `hallucinated_file_content` | 幻觉文件内容 | 声称看过某文件内容，但本 session 没有读取过对应内容。 | high |
| `stale_file_reference` | 旧版本引用 | 文件已被修改后仍引用旧内容。 | medium |
| `forgot_user_constraint` | 遗忘用户约束 | 用户明确说过“必须/不要”，后续 Memory 未承认或违背。 | high |

## Reflection

| 错误 ID | 中文名 | 判定要点 | 默认严重度 |
| --- | --- | --- | --- |
| `progress_misjudge` | 进度误判 | 错估当前完成度。 | medium |
| `progress_misjudgement` | 进度误判 | 与 `progress_misjudge` 同义，兼容 v0.4 原文拼写。 | medium |
| `outcome_misinterpretation` | 结果误读 | 对上一步工具输出的解释与事实不符。 | high |
| `causal_misattribution` | 因果误归 | 把错误原因归错，例如把路径不存在说成权限问题。 | medium |
| `hallucination` | 反思幻觉 | Reflection 中出现上一步并不存在的现象。 | high |
| `reflection_hallucination` | 反思幻觉 | 同上，用于更精确标注 Reflection 模块。 | high |
| `false_success_claim` | 假成功声明 | 工具失败、测试失败或命令报错时声称成功。 | high |
| `missed_test_failure` | 漏掉测试失败 | 输出包含 FAILED、AssertionError、npm ERR 等，但反思说测试通过。 | high |
| `premature_completion` | 过早完成 | 任务仍有未完成子目标，却宣称已经完成。 | high |
| `ignored_warning` | 忽略警告 | 工具输出有重要 warning/deprecated，但反思完全忽略。 | low |

## Planning

| 错误 ID | 中文名 | 判定要点 | 默认严重度 |
| --- | --- | --- | --- |
| `constraint_ignorance` | 忽略约束 | 计划违反用户、系统、环境或任务约束。 | high |
| `impossible_action` | 不可能动作 | 计划依赖不存在的工具、资源或能力。 | medium |
| `inefficient_plan` | 低效计划 | 已有信息足够却继续重复无效探索。 | low |
| `wrong_file_target` | 目标文件错误 | 计划修改或读取的目标与任务意图、prior facts 不一致。 | high |
| `missing_test_step` | 缺少验证步骤 | 修改代码后计划不包含测试或验证。 | medium |
| `over_engineering` | 过度工程 | 简单问题引入不必要重构、框架或复杂方案。 | medium |
| `no_explicit_plan` | 无显式计划 | 同 step 有写入/破坏性动作，但 Planning 留白。 | medium |
| `plan_action_mismatch` | 计划动作不一致 | 计划说做 A，实际 Action 做 B。 | high |
| `unsafe_destructive_action` | 不安全破坏动作 | 计划或动作包含高风险命令且无人工确认。 | high |

## Action

| 错误 ID | 中文名 | 判定要点 | 默认严重度 |
| --- | --- | --- | --- |
| `misalignment` | 动作失配 | 与计划或任务目标明显不一致。 | high |
| `invalid_action` | 无效动作 | 工具不存在、命令不可用、动作无法执行。 | high |
| `format_error` | 格式错误 | 工具入参或返回结构不符合 schema。 | medium |
| `parameter_error` | 参数错误 | 参数、命令、路径、选项选择不当导致失败。 | medium |
| `nonexistent_path` | 路径不存在 | 输出包含 No such file、not found 等路径不存在证据。 | medium |
| `wrong_diff_anchor` | 编辑锚点错误 | edit/apply_patch 锚点不匹配真实文件内容。 | high |
| `dangerous_command` | 危险命令 | 命令包含 rm -rf /、DROP TABLE、push --force 等高危操作。 | high |
| `redundant_call` | 冗余调用 | 短窗口内同样工具同样参数反复调用三次及以上。 | low |
| `tool_misuse` | 工具误用 | 工具能执行但选择明显不合适，例如该搜索却读全文。 | medium |

## System

| 错误 ID | 中文名 | 判定要点 | 默认严重度 |
| --- | --- | --- | --- |
| `step_limit` | 步数限制 | session 或任务步数触达限制。 | medium |
| `tool_execution_error` | 工具执行错误 | 工具或外部环境返回错误。 | medium |
| `llm_limit` | 模型输出限制 | 输出长度、token 或模型限制。 | medium |
| `environment_error` | 环境错误 | 沙箱、网络、文件系统、依赖环境异常。 | medium |
| `context_overflow` | 上下文溢出 | 模型或 agent 上下文超限。 | high |
| `user_aborted` | 用户中断 | 用户或系统主动取消。 | medium |
| `auth_failure` | 认证失败 | token、权限、认证配置失败。 | high |
| `schema_violation` | 结构输出违规 | 结构化输出不符合约束。 | medium |
| `step_timeout` | 单步超时 | 单个 step 耗时超过阈值。 | low |

## Others

| 错误 ID | 中文名 | 判定要点 | 默认严重度 |
| --- | --- | --- | --- |
| `others` | 其他问题 | 不能归入上述模块，但确实影响结果。 | medium |
| `no_error` | 未发现问题 | Phase 1 单元格无错误时使用。 | low |

## 使用规则

- 优先使用脚本已经输出的静态错误，不要重复制造同类问题。
- 对 Memory 和 Reflection 的语义错误，必须引用 prior facts 或上一步工具返回作为证据。
- 对 Planning 的语义错误，必须说明违反了哪个约束、目标或计划动作一致性。
- 对 Action 的大多数错误，优先相信脚本静态判断；只有 `tool_misuse` 需要 LLM 语义判断。
- System 是外部证据，不能自动说明 Agent 的认知模块出错。
