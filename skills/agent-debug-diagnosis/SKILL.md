---
name: agent-debug-diagnosis
description: >
  用 AgentDebug v0.4 风格的规则加算法诊断 Agent Insight 执行轨迹。适用于智能诊断、
  执行失败、工具调用异常、结果偏差、认知根因分析。该 skill 必须先运行 scripts 下的
  Python 静态分析脚本，再由智能诊断 agent 补充语义判断和根因归因，最后输出中文 JSON 报告。
---

# agent-debug-diagnosis

## 任务目标

对 Agent Insight 的一次执行记录运行 AgentDebug 认知诊断流水线：

```text
输入 JSON
  -> scripts/agentdebug_static.py 进行确定性拆分和规则检测
  -> 智能诊断 agent 补充语义检测和 Phase 2 根因归因
  -> scripts/agentdebug_validate.py 校验最终报告
  -> 输出一个中文 JSON 对象
```

项目后端只负责挂载 skill、提供输入文件和保存最终报告。拆分规则、检测规则、词表、校验逻辑都归这个 skill 管理。

## 必须读取的资料

诊断前必须按需读取这些文件。不要只凭本文件自由发挥。

1. `references/01-input-and-extraction.md`
2. `references/02-error-taxonomy.md`
3. `references/03-phase-analysis.md`
4. `references/04-output-schema.md`

## 必须执行的脚本

后端会在提示中给出输入文件路径，通常是：

```text
.agent-insight/agent-debug-input.json
```

第一步必须运行静态分析脚本：

```bash
python3 .agent-debug-diagnosis/scripts/agentdebug_static.py \
  --input .agent-insight/agent-debug-input.json \
  --output .agent-insight/agent-debug-static.json
```

然后读取 `.agent-insight/agent-debug-static.json`。如果脚本失败，不要继续凭空诊断；返回一个结构化失败报告，说明脚本失败原因。

最终回答前，先把准备返回的 JSON 写入：

```text
.agent-insight/agent-debug-final.json
```

再运行校验脚本：

```bash
python3 .agent-debug-diagnosis/scripts/agentdebug_validate.py \
  --input .agent-insight/agent-debug-final.json
```

如果校验报错，先修正 JSON 再重新校验。校验只警告时，可以返回最终 JSON，但应优先修正明显的英文说明和缺失证据。

## 不可违反的规则

- 最终回答只能是一个 JSON 对象，不能有 Markdown 代码块，不能有额外解释。
- 所有自然语言报告字段必须用中文；枚举值保留英文。
- Action 必须来自真实工具调用或明确动作标签，不能由 LLM 编造。
- 用户可见的 `step` 编号必须使用输入中的 `traceStepIndex`，与原始故障类报告保持一致；内部连续诊断序号只能放在 `diagnosticStep`。
- 不使用候选窗口，不要只分析局部 trace；必须对输入文件里的全部 step 执行拆分和 Phase 1 检测。
- System 是外部环境证据，不属于四个认知模块，但可以参与根因归因。
- Memory、Reflection、Planning、Action 都允许留白。
- 留白模块不是错误，不能因为空模块本身选择根因。
- 不允许从 Action 或 System 失败反推 Planning 一定失败。
- 不要修改用户项目文件，不要重新执行被诊断的用户任务。
- 只允许执行本 skill 的分析/校验脚本，以及读取 trace 资料包。

## 诊断流程

1. 读取输入文件路径、skill 挂载目录、静态输出路径和最终报告路径。
2. 读取上述四份 references，确认拆分、词表、Phase 1、Phase 2 和输出协议。
3. 运行 `agentdebug_static.py`，拿到静态 `stepRecords`、`triage`、`phase1Grid` 和 `issues`。
4. 如果 `triage.shortCircuited=true`，只做简短中文说明，构造系统性根因报告，不要补造四模块问题。
5. 如果没有短路，基于静态结果补充语义判断：
   - Memory：检查幻觉、召回失败、过度简化、遗忘用户约束。
   - Reflection：检查误读工具结果、假成功声明、漏掉测试失败、过早完成。
   - Planning：检查违反约束、不可能动作、低效计划、计划和动作不一致。
   - Action：脚本已覆盖大多数静态错误；只在必要时补充 `tool_misuse`。
6. 合并脚本发现和语义发现，形成 Phase 1 错误网格。
7. 执行 Phase 2：从 Phase 1 网格中选择最早、最能解释后续级联的根因。
8. 写入 `.agent-insight/agent-debug-final.json` 并运行校验脚本。
9. 返回校验后的最终 JSON。

## 输出要求

必须返回这些顶层字段：

- `triage`
- `stepRecords`
- `phase1Grid`
- `issues`
- `rootCause`
- `humanSummary`

字段结构以 `references/04-output-schema.md` 为准。
