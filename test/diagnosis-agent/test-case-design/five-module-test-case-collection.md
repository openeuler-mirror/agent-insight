# 五模块单步认知诊断测试用例索引导航

> 本文档原为测试用例全集，已按 [five-module-test-case-construction-strategy.md](five-module-test-case-construction-strategy.md) 的 6 层结构拆分为分文件，便于维护。本页仅作为索引导航，详细用例请查阅下表对应文件。
>
> 创建时间：2026-08-08；拆分更新：2026-08-13

---

## 分层文件索引

| 层 | 内容 | 文件 |
|---|---|---|
| L1 | 单 ID 单点覆盖 - Memory 模块 | [L1-single-id-single-point-memory.md](L1-single-id-single-point-memory.md) |
| L1 | 单 ID 单点覆盖 - Reflection 模块 | [L1-single-id-single-point-reflection.md](L1-single-id-single-point-reflection.md) |
| L1 | 单 ID 单点覆盖 - Planning 模块 | [L1-single-id-single-point-planning.md](L1-single-id-single-point-planning.md) |
| L1 | 单 ID 单点覆盖 - Action 模块 | [L1-single-id-single-point-action.md](L1-single-id-single-point-action.md) |
| L1 | 单 ID 单点覆盖 - System 模块 | [L1-single-id-single-point-system.md](L1-single-id-single-point-system.md) |
| L1 | 单 ID 单点覆盖 - Others 模块 | [L1-single-id-single-point-others.md](L1-single-id-single-point-others.md) |
| L2 | 单 step 多模块共存（独立性） | [L2-single-step-multi-module.md](L2-single-step-multi-module.md) |
| L3 | 跨 step 错误传播（时序） | [L3-cross-step-error-propagation.md](L3-cross-step-error-propagation.md) |
| L4 | 边界与拒识（跨 ID 边界混淆） | [L4-boundary-and-rejection.md](L4-boundary-and-rejection.md) |
| L5 | 脚本静态 vs LLM 语义分工 | [L5-script-static-vs-llm-semantic.md](L5-script-static-vs-llm-semantic.md) |
| L6 | Phase 0 系统风险预检 | [L6-phase0-precheck.md](L6-phase0-precheck.md) |

---

## 用例统计

| 层 | 内容 | 用例数 |
|---|---|---|
| L1 | 单 ID 单点覆盖 - Memory 模块 | 37 |
| L1 | 单 ID 单点覆盖 - Reflection 模块 | 44 |
| L1 | 单 ID 单点覆盖 - Planning 模块 | 50 |
| L1 | 单 ID 单点覆盖 - Action 模块 | 51 |
| L1 | 单 ID 单点覆盖 - System 模块 | 47 |
| L1 | 单 ID 单点覆盖 - Others 模块 | 8 |
| L2 | 单 step 多模块共存（独立性） | 10 |
| L3 | 跨 step 错误传播（时序） | 5 |
| L4 | 边界与拒识（跨 ID 边界混淆） | 8 |
| L5 | 脚本静态 vs LLM 语义分工 | 10 |
| L6 | Phase 0 系统风险预检 | 4 |
| **合计** | | **274** |

---

## 错误 ID 覆盖清单（详见各 L1 分文件）

| 模块 | 错误 ID | 正向 | 边界 | 是否覆盖 |
|---|---|---|---|---|
| Memory | hallucination | 4 | 6 | ✓ |
| Memory | memory_retrieval_failure | 3 | 2 | ✓ |
| Memory | over_simplification | 3 | 2 | ✓ |
| Memory | hallucinated_file_content | 3 | 3 | ✓ |
| Memory | stale_file_reference | 3 | 2 | ✓ |
| Memory | forgot_user_constraint | 3 | 3 | ✓ |
| Reflection | progress_misjudge | 3 | 2 | ✓ |
| Reflection | outcome_misinterpretation | 3 | 3 | ✓ |
| Reflection | causal_misattribution | 3 | 2 | ✓ |
| Reflection | hallucination (reflection_hallucination) | 3 | 2 | ✓ |
| Reflection | false_success_claim | 3 | 3 | ✓ |
| Reflection | missed_test_failure | 3 | 3 | ✓ |
| Reflection | premature_completion | 3 | 2 | ✓ |
| Reflection | ignored_warning | 3 | 3 | ✓ |
| Planning | constraint_ignorance | 4 | 3 | ✓ |
| Planning | impossible_action | 3 | 3 | ✓ |
| Planning | inefficient_plan | 3 | 2 | ✓ |
| Planning | wrong_file_target | 3 | 2 | ✓ |
| Planning | missing_test_step | 3 | 3 | ✓ |
| Planning | over_engineering | 3 | 2 | ✓ |
| Planning | no_explicit_plan | 3 | 2 | ✓ |
| Planning | plan_action_mismatch | 3 | 2 | ✓ |
| Planning | unsafe_destructive_action | 3 | 3 | ✓ |
| Action | misalignment | 3 | 2 | ✓ |
| Action | invalid_action | 3 | 2 | ✓ |
| Action | format_error | 3 | 2 | ✓ |
| Action | parameter_error | 3 | 3 | ✓ |
| Action | nonexistent_path | 3 | 3 | ✓ |
| Action | wrong_diff_anchor | 3 | 2 | ✓ |
| Action | dangerous_command | 4 | 3 | ✓ |
| Action | redundant_call | 3 | 3 | ✓ |
| Action | tool_misuse | 3 | 3 | ✓ |
| System | step_limit | 2 | 2 | ✓ |
| System | tool_execution_error | 3 | 3 | ✓ |
| System | llm_limit | 3 | 2 | ✓ |
| System | environment_error | 3 | 2 | ✓ |
| System | context_overflow | 3 | 2 | ✓ |
| System | user_aborted | 3 | 2 | ✓ |
| System | auth_failure | 3 | 3 | ✓ |
| System | schema_violation | 3 | 2 | ✓ |
| System | step_timeout | 3 | 3 | ✓ |
| Others | others | 2 | 2 | ✓ |
| Others | no_error | 2 | 2 | ✓ |

---

## Trace 用例构造方法

上表用例以文字形式描述了场景与预期，便于评审。若要用于真实诊断器回归测试，需落成与生产环境一致的 trace 文件。本目录提供基线 trace [normal-trace.json](normal-trace.json) 作为构造起点，并约定如下注入方法。

### 基线 trace 说明

- 文件格式：`agent-insight.trace-bundle`（version 1），结构为 `executions[0].execution` + `executions[0].session.interactions[]`。
- 基线内容：一个完整的 messages 日志安全分析 session（12 个 interaction、13 次工具调用、0 错误），所有模块正常，无任何错误 ID 触发。
- 用途：作为"干净 prior facts"的来源——注入前确认基线不含目标错误模式，避免污染判定。

### 构造原则

1. **拷贝而非覆盖**：基于 `normal-trace.json` 深拷贝生成新文件，保留全部已有 interaction 原样不变。原内容用于构成 prior facts，必须保持完整。注入位置可在末尾或中间（见原则 2）。
2. **最小注入，但分层对待复杂度**：
   - **L1 单 ID 单点**：聚焦隔离单错误，注入节点保持精简（通常 1-2 个 interaction：1 个 user 追问 + 1 个 assistant 出错）。但"精简"指错误点单一，**不等于 trace 总长度短**——基线 `normal-trace.json` 本身已有 12 个 interaction 构成 prior facts，总 trace 达 13-14 个 interaction，足以提供真实上下文长度。L1 的简单是设计意图，复杂多错误场景由 L2-L6 覆盖。
   - **避免模式化**：不要每个用例都在末尾追加。错误可注入到基线**中间**某个 step（如 interaction[6] 之后），让诊断器必须在长 prior facts 中定位错误，而非只看末尾。同一错误 ID 建议至少有 1 个"中间注入"变体。
   - **勿改前序字段**：注入只追加新 interaction，不修改基线已有 interaction 的任何字段（保证 prior facts 可复现）。
3. **prior facts 干净**：注入前用全文搜索确认基线不含目标错误模式（如目标错误是"引用不存在的文件 /foo/bar.js"，需确认原 trace 全文无 `/foo/bar.js`）。
4. **taskId 一致性**：`executions[0].execution.taskId` 必须等于 `executions[0].session.taskId`。注入时若改写 execution.id / taskId，必须同步 session.taskId。
5. **时序递增**：追加的 interaction 的 `timestamp` / `timeInfo.created` / `timeInfo.completed` 必须晚于原末尾 interaction，保持单调递增。
6. **元数据同步**：注入后更新 execution 统计字段——`toolCallCount` / `llmCallCount` / `toolCallErrorCount` / `tokens` / `inputTokens` / `outputTokens` / `cacheReadInputTokens` / `latency` 累加新 interaction 的用量；`maxSingleCallTokens` 取新 call 的 total 与原值的较大者；`session.endTime` 推进到注入末尾时间；`finalResult` 更新为反映注入结果。

### 注入步骤（以 P1 "引用不存在的文件"为例）

1. **深拷贝** `normal-trace.json` → 新文件，输出到对应文字用例文档的同名目录（如 `test/diagnosis-agent/L1-single-id-single-point-memory/P1-hallucination-nonexistent-file.json`）。
2. **核查 prior facts**：全文搜索确认不含 `/foo/bar.js`。
3. **追加 interaction[N]**（user 追问）：内容不直接点明目标文件，让 assistant 主动出错。例如"顺便看一下这个项目里有没有其他需要关注的配置文件？"。
4. **追加 interaction[N+1]**（step N，错误注入点）：
   - `role`: assistant
   - `content`: 引用 prior facts 中不存在的文件作为决策依据，如"根据 /foo/bar.js 的内容，端口配置为 8080，我将其修复为 3000。"
   - `tool_calls[0]`: 基于 hallucinate 的内容发起动作，`state=failed`，`output` 给出失败证据（如 `sed: can't read /foo/bar.js: No such file or directory`）。
5. **同步 taskId**：`execution.taskId` 与 `session.taskId` 改为同一新值（如 `ses_P1_hallucination_nonexistent_file`），同时更新 `execution.id` / `rootExecutionId`。
6. **同步元数据**：累加 `toolCallCount += 1`、`toolCallErrorCount += 1`、`llmCallCount += 1`、`tokens` / `inputTokens` / `outputTokens` / `cacheReadInputTokens` / `latency` 累加注入值，`maxSingleCallTokens` 取 max，`session.endTime` 推进，`finalResult` 更新。

### 各层注入要点

| 层 | 注入位置 | 关键约束 |
|---|---|---|
| L1 单 ID 单点 | 末尾或中间追加 1 个错误 step | prior facts 必须不含目标错误模式；错误点单一（单 step、单模块、单错误）；建议每个错误 ID 至少 1 个"中间注入"变体，避免诊断器只看末尾 |
| L2 多模块共存 | 末尾追加 1 个 step，其 content/tool_calls 同时承载 2-3 个模块错误 | 多个错误之间无因果关系，应被独立判定 |
| L3 跨 step 传播 | 追加 3 个连续 step，错误 A→B→C | priorWindow 不回溯改写，三个错误分别在各自 step 被识别 |
| L4 边界与拒识 | 末尾追加"看似错误但不是"的 step | 预期不报或报具体 ID，验证拒识能力 |
| L5 脚本 vs LLM 分工 | 末尾追加 step，构造脚本信号足够 / 不足的两种场景 | Action/System 优先信脚本，Memory/Reflection/Planning/`tool_misuse` 靠 LLM |
| L6 Phase 0 预检 | 在 session 开头或连续多步注入系统性环境证据 | 触发 Phase 0 系统风险识别，跳过逐 step 诊断 |

### 命名约定

- **输出目录**：trace 文件按文字用例文档分目录存放，目录名 = 文字用例文件名去掉 `.md`，根目录为 `test/diagnosis-agent/`。例如：
  - [L1-single-id-single-point-action.md](L1-single-id-single-point-action.md) 的用例 → `test/diagnosis-agent/L1-single-id-single-point-action/` 目录下
  - [L1-single-id-single-point-memory.md](L1-single-id-single-point-memory.md) 的用例 → `test/diagnosis-agent/L1-single-id-single-point-memory/` 目录下
  - 以此类推，每个文字用例文档对应一个同名目录。
- 文件名：`{用例编号}-{错误ID简述}.json`，如 `P1-hallucination-nonexistent-file.json`。
- taskId / execution.id：`ses_{用例编号}_{错误ID简述}`，如 `ses_P1_hallucination_nonexistent_file`。
- 与本目录文字用例一一对应：文件名前缀（P1/B1…）与对应文字用例文档中的编号一致。

---

## 生成用例的示例 Prompt

用户在 IDE 中对 agent 下发以下简短指令即可生成 trace 用例文件，agent 应严格遵循本文档【Trace 用例构造方法】章节的约束执行。

### 通用 Prompt

```
基于 test/diagnosis-agent/test-case-design/normal-trace.json 的拷贝，按照 five-module-test-case-collection.md 中【Trace 用例构造方法】章节内容生成用例 json 文件。注意，不要覆盖拷贝文件中的已有内容。

用例定义见：{XXX}
```

`{XXX}` 是唯一需要替换的部分，需包含三层定位信息以唯一定位用例：**模块文件 + 错误 ID 章节 + 用例类型与编号（可含标题）**，格式如：

```
{文字用例文件} 中 {错误ID} 章节下{正向/边界}用例 {编号}（{标题，可选}）
```

例：`L1-single-id-single-point-memory.md 中 hallucination 章节下正向用例 P1（引用不存在的文件）`。

agent 应据此：

1. 打开文字用例文件，定位到"错误 ID 章节 → 用例类型子标题 → 编号"对应的条目，读取"场景 / prior facts 设置 / step N 模块内容 / 预期"四段。
2. 从章节标题提取错误 ID（如 `hallucination`），从编号提取类型（P=正向 / B=边界）。
3. 按命名约定自动生成输出路径：输出目录 = `test/diagnosis-agent/{文字用例文件名去掉.md}/`（如 `test/diagnosis-agent/L1-single-id-single-point-memory/`），输出文件名 = `{用例编号}-{错误ID简述}.json`；taskId = `ses_{用例编号}_{错误ID简述}`。
4. 默认注入位置为末尾追加；若 `{XXX}` 中注明"中间注入"或"interaction[N] 之后插入"，则按指定位置注入。
5. 按构造原则 1-7 执行（拷贝不覆盖、prior facts 干净、taskId 一致、时序递增、元数据同步、错误模式精确、勿改前序字段）。

### 示例

**P1（正向）**：
```
基于 test/diagnosis-agent/test-case-design/normal-trace.json 的拷贝，按照 five-module-test-case-collection.md 中【Trace 用例构造方法】章节内容生成用例 json 文件。注意，不要覆盖拷贝文件中的已有内容。

用例定义见：test/diagnosis-agent/test-case-design/L1-single-id-single-point-memory.md 中 hallucination 章节下正向用例 P1（引用不存在的文件）。
```

**B1（边界）**：
```
基于 test/diagnosis-agent/test-case-design/normal-trace.json 的拷贝，按照 five-module-test-case-collection.md 中【Trace 用例构造方法】章节内容生成用例 json 文件。注意，不要覆盖拷贝文件中的已有内容。

用例定义见：test/diagnosis-agent/test-case-design/L1-single-id-single-point-memory.md 中 hallucination 章节下边界用例 B1。
```

### 批量生成 Prompt

```
基于 test/diagnosis-agent/test-case-design/normal-trace.json 的拷贝，按照 five-module-test-case-collection.md 中【Trace 用例构造方法】章节内容生成以下用例 json 文件。每个用例独立拷贝基线 trace，不要覆盖拷贝文件中的已有内容。

用例清单：
1. test/diagnosis-agent/test-case-design/L1-single-id-single-point-memory.md 中 hallucination 章节下正向用例 P1（引用不存在的文件）
2. test/diagnosis-agent/test-case-design/L1-single-id-single-point-reflection.md 中 progress_misjudge 章节下正向用例 P1
...

完成后输出一份验证报告，包含每个用例的 taskId 一致性、时序递增性、prior facts 干净度、原 interaction 完整性核查结果。
```

### 使用说明

- **唯一可变部分**：`用例定义见：{XXX}`——按"模块文件 + 错误 ID 章节 + 用例类型与编号"三层定位，确保唯一定位用例。agent 据此自动推断输出文件名、taskId。
- **边界用例**：B 系列无需额外说明，agent 按文字用例定义的"预期"自动构造（B 系列"边界阈值"）。
- **多用例批量**：用批量 Prompt 的清单格式，每行一个用例定位，agent 循环处理并统一输出验证报告。
