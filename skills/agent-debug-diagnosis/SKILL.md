---
name: agent-debug-diagnosis
description: >
  统一处理 Agent Insight 的一键诊断、普通诊断追问和定向查因。一键诊断运行 AgentDebug
  五模块及适用的专项诊断器；普通追问保持现有问答；定向查因仅额外调用命中的专项诊断器，
  不运行五模块。专项诊断器通过 detectors/*/detector.json 自注册。
---

# agent-debug-diagnosis

## 任务目标

用同一个 Skill 承载三条互斥路线：一键诊断、普通追问、定向查因。

## 路由边界

1. **一键诊断**：请求明确来自一键诊断入口。运行现有 AgentDebug 五模块，并执行所有支持 `one_click` 的专项诊断器。详见 `references/05-one-click-workflow.md`。
2. **普通追问**：用户问题未命中专项诊断器。保持现有追问流程，不运行五模块和专项诊断器。详见 `references/06-follow-up-workflow.md`。
3. **定向查因**：用户问题命中 `detectors/*/detector.json` 中的症状关键词。在普通追问基础上使用匹配诊断器的结果，不运行五模块。详见 `references/07-targeted-workflow.md`。

诊断器注册机制：每个诊断器目录必须包含 `detector.json`；公共 `scripts/detector_runner.py` 扫描这些清单完成发现、匹配和执行。服务端不维护诊断器名称列表，也不包含诊断器业务规则。

一键诊断的 AgentDebug 认知诊断流水线：

```text
输入 JSON
  -> AgentDebug 静态检测、五模块与 Phase 2
  -> 冻结 core findings
  -> 同一个 AgentDebug Agent 比较已富化专项结果
  -> 输出 merge / independent 决策
  -> 通用代码无损应用决策并生成最终报告
```

项目后端负责挂载 skill、提供输入、执行通用诊断器运行与富化、无损应用合并决策并保存报告。拆分规则、检测规则、词表、查重判定规则和校验逻辑都归这个 skill 管理。

## 一键诊断必须读取的资料

仅一键诊断需要按需读取这些文件。普通追问和定向查因只读取各自路线文件，不执行下述 AgentDebug 脚本。

1. `references/01-input-and-extraction.md`
2. `references/02-error-taxonomy.md`
3. `references/03-phase-analysis.md`
4. `references/04-output-schema.md`
5. 根据当前路线读取 `references/05-one-click-workflow.md`、`06-follow-up-workflow.md` 或 `07-targeted-workflow.md`
6. 一键诊断第二阶段必须读取 `references/08-detector-reconciliation.md`

## 一键诊断必须执行的脚本

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

然后必须运行统一查询脚本获取全局摘要：

```bash
python3 .agent-debug-diagnosis/scripts/agentdebug_inspect.py summary \
  --input .agent-insight/agent-debug-input.json \
  --static .agent-insight/agent-debug-static.json
```

根据五模块候选信号，继续使用 `tail`、`range`、`search`、`repeated-calls` 拉取小块证据。不要顺序读取大型 JSON，也不要临时编写 `python3 -c` 查询。静态或查询脚本失败时，不要继续凭空诊断；返回结构化失败报告。

最终回答前，先把准备返回的 JSON 写入：

```text
.agent-insight/agent-debug-final.json
```

再运行校验脚本：

```bash
python3 .agent-debug-diagnosis/scripts/agentdebug_validate.py \
  --input .agent-insight/agent-debug-final.json \
  --static .agent-insight/agent-debug-static.json
```

如果校验报错，先修正 JSON 再重新校验。校验只警告时，可以返回最终 JSON，但应优先修正明显的英文说明和缺失证据。

## 一键诊断不可违反的规则

- 最终回答只能是一个 JSON 对象，不能有 Markdown 代码块，不能有额外解释。
- 所有自然语言报告字段必须用中文；枚举值保留英文。
- Action 必须来自真实工具调用或明确动作标签，不能由 LLM 编造。
- 用户界面永远关联左侧真实 trace 节点；不要把内部诊断 step/turn 当作用户可见位置。
- `phase1Grid`、`issues`、`findings`、`rootCause`、`cascadingChain` 必须尽量携带或引用可定位到左侧 trace 节点的字段。`diagnosticStep` 仅供内部排查，不能写进自然语言摘要。
- `issues` 是 Phase 1 原子问题，不等于用户可见的关键发现；`findings` 才是 Phase 2 面向用户展示的关键诊断发现列表。
- 每条 `finding` 必须通过 `issueRefs` 引用实际存在的 `issues`，并且恰好有一个 `role=root`；下游症状使用 `role=downstream`，不要重复提升成另一条 finding。
- 用户可见自然语言里默认使用“关键发现”“潜在问题”“过程风险”，不要把已恢复或未造成任务失败的问题写成“根因”。只有 trace 明确失败且该问题直接导致失败时，才可以使用“根因”。
- `findings[].summary` 和 `rootCause.summary` 只写 1-2 句结论；原始报错、命令、节点、重复模式和长推理放入 `evidence`、`issueRefs`、`cascadingChain` 或 `correctionGuidance`，不要堆在 summary 里。
- 不使用候选窗口，不要只分析局部 trace；必须对输入文件里的全部 step 执行拆分和 Phase 1 检测。
- `agentdebug_static.py` 必须覆盖全部 turn；智能诊断 agent 根据 `summary` 中 Memory、Reflection、Planning、Action、System 五模块候选信号按需核查语义证据。
- 不允许使用 read + offset 顺序读取大型 JSON，也不允许临时编写 `python3 -c`；只使用 `agentdebug_inspect.py` 查询。
- 需要核对超过节点内联阈值的输入或输出时，使用 `search --scope artifact` 查询完整 artifact。
- 最终报告必须保留静态 `stepRecords`、`phase1Grid` 和 `issues`；误报通过 `resolution=non_blocking` 说明，不能删除或改写原始 evidence。
- System 是外部环境证据，不属于四个认知模块，但可以参与根因归因。
- Memory、Reflection、Planning、Action 都允许留白。
- 留白模块不是错误，不能因为空模块本身选择根因。
- 不允许从 Action 或 System 失败反推 Planning 一定失败。
- 不要修改用户项目文件，不要重新执行被诊断的用户任务。
- 只允许执行本 skill 的分析/校验脚本，以及读取 trace 资料包。

## 一键诊断流程

1. 读取输入文件路径、skill 挂载目录、静态输出路径和最终报告路径。
2. 读取上述四份 references，确认拆分、词表、Phase 1、Phase 2 和输出协议。
3. 运行 `agentdebug_static.py`，对全部 turn 生成静态 `stepRecords`、`triage`、`phase1Grid` 和 `issues`。
4. 运行 `agentdebug_inspect.py summary`，读取全局统计、头尾记录和 Memory、Reflection、Planning、Action、System 五模块候选信号。
5. 根据候选信号使用 `tail`、`range`、`search`、`repeated-calls` 核查 prior facts、相邻步骤、重复动作与工具结果；需要完整长文本时使用 `search --scope artifact`。
6. 读取 `triage`，继续完成语义补充：
   - Memory：检查幻觉、召回失败、过度简化、遗忘用户约束。
   - Reflection：检查误读工具结果、假成功声明、漏掉测试失败、过早完成。
   - Planning：检查违反约束、不可能动作、低效计划、计划和动作不一致。
   - Action：脚本已覆盖大多数静态错误；只在必要时补充 `tool_misuse`。
   - System：复核超时、认证、上下文限制和系统性工具失败是否属于外部原因。
7. 保留全部静态事实并追加语义问题，形成 Phase 1 错误网格。
8. 执行 Phase 2，聚合最值得用户关注的 core `findings`；机制或修复方向不同的问题不得合并。`rootCause` 仅作为 `findings[0]` 的历史兼容投影。
9. 写入 `.agent-insight/agent-debug-final.json`，使用 `--static` 对照校验后返回冻结的主诊断 JSON。
10. 后端随后发起第二阶段；只按 `08-detector-reconciliation.md` 比较 core findings 与专项结果并返回 decisions。

## 一键诊断输出要求

必须返回这些顶层字段：

- `triage`
- `stepRecords`
- `phase1Grid`
- `issues`
- `findings`
- `rootCause`
- `humanSummary`

字段结构以 `references/04-output-schema.md` 为准。
