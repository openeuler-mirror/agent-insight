# 04 输出结构

最终只能返回一个 JSON 对象，不能带 Markdown 代码块或额外说明。

所有自然语言字段必须用中文；枚举值保持英文。原始命令、路径、英文报错可以作为证据片段保留。

## 顶层结构

```json
{
  "triage": {
    "category": "normal",
    "shortCircuited": false,
    "fatalDiagnosis": null,
    "prefilterHints": {
      "forceFullSteps": []
    },
    "notes": []
  },
  "stepRecords": [],
  "phase1Grid": [],
  "issues": [],
  "findings": [],
  "rootCause": null,
  "humanSummary": "中文摘要"
}
```

## triage

`triage` 记录 Phase 0 结果。

允许的 `category`：

- `normal`
- `infra`
- `tool_systemic`
- `early_fatal`

预检规则：

- `triage.fatalDiagnosis` 表示静态预检命中的系统风险，不等于最终关键发现。
- 静态预检命中后也必须继续正常认知诊断，`phase1Grid` 和 `issues` 仍应包含后续 Phase 1 的完整发现。
- 只有输入 trace 完全无法解析、诊断脚本自身失败、或没有足够数据继续分析时，才允许 `shortCircuited=true`。
- 若 `shortCircuited=true`，必须在 `fatalDiagnosis.summary` 中清楚说明“为什么无法继续分析”，不能只写泛化句子。

示例：

```json
{
  "category": "normal",
  "shortCircuited": false,
  "fatalDiagnosis": null,
  "prefilterHints": {
    "forceFullSteps": [2]
  },
  "notes": ["第 2 步存在工具错误，但更像动作参数问题，继续四模块诊断。"]
}
```

## stepRecords

每个 `stepRecord` 对应一个 assistant/subagent/opencode 可见 turn，必须包含五个模块，其中 System 是外部证据模块。用户界面不展示内部诊断序号，定位必须依赖左侧 trace 节点字段。

```json
{
  "step": 1,
  "diagnosticStep": 1,
  "traceStepIndex": 12,
  "traceNodeLabel": "工具调用 · bash tree ...",
  "traceNodeKind": "tool",
  "sourceInteractionIndex": 0,
  "title": "工具调用 · bash tree ...",
  "inputContext": "当前 step 的输入摘要",
  "agentOutput": "Agent 可见输出",
  "environmentResponse": "工具或环境返回摘要",
  "anchorId": "optional-anchor",
  "modules": {
    "memory": {
      "module": "memory",
      "content": "",
      "confidence": 0,
      "source": "implicit"
    },
    "reflection": {
      "module": "reflection",
      "content": "",
      "confidence": 0,
      "source": "implicit"
    },
    "planning": {
      "module": "planning",
      "content": "",
      "confidence": 0,
      "source": "implicit"
    },
    "action": {
      "module": "action",
      "content": "",
      "confidence": 0,
      "source": "raw_tool"
    },
    "system": {
      "module": "system",
      "content": "",
      "confidence": 0,
      "source": "system"
    }
  }
}
```

字段规则：

- `step` 是兼容字段；新报告应优先填左侧 trace 节点编号。
- `diagnosticStep` 是内部连续诊断序号，只能用于调试，不要写入自然语言摘要。
- `traceStepIndex`、`traceNodeLabel`、`traceNodeKind` 是 UI 展示和跳转解释的主字段。
- `anchorId` 是跳转左侧节点的主锚点。

`source` 只能是：

- `tag`
- `llm`
- `raw_tool`
- `implicit`
- `system`

## phase1Grid

`phase1Grid` 记录 Phase 1 单元格。可以只返回检测到错误的单元格。

```json
{
  "step": 2,
  "diagnosticStep": 1,
  "traceStepIndex": 12,
  "traceNodeLabel": "工具调用 · bash tree ...",
  "traceNodeKind": "tool",
  "module": "action",
  "errorDetected": true,
  "errorType": "parameter_error",
  "severity": "medium",
  "evidence": "中文证据，可包含原始英文报错",
  "reasoning": "中文判定理由",
  "confidence": 0.86,
  "anchorId": "optional-anchor",
  "resolution": "unresolved",
  "resolutionEvidence": "该问题未在后续步骤中被修正。"
}
```

允许的 `module`：

- `memory`
- `reflection`
- `planning`
- `action`
- `system`
- `others`

允许的 `severity`：

- `high`
- `medium`
- `low`

`errorType` 使用 `references/02-error-taxonomy.md` 中的词表。无错误单元格可使用 `no_error`。

## issues

`issues` 是 `phase1Grid` 中检测到错误的扁平列表。每条 issue 必须继承对应单元格的左侧节点定位字段。

```json
{
  "id": "N12-action-parameter_error",
  "step": 2,
  "diagnosticStep": 1,
  "traceStepIndex": 12,
  "traceNodeLabel": "工具调用 · bash tree ...",
  "traceNodeKind": "tool",
  "module": "action",
  "errorType": "parameter_error",
  "severity": "medium",
  "evidence": "中文证据",
  "reasoning": "中文判定理由",
  "confidence": 0.86,
  "anchorId": "optional-anchor"
}
```

规则：

- `issues` 不应包含 `errorDetected=false` 的单元格。
- 同一 `step + module + errorType` 只保留一条。
- 证据要短而具体。
- 不要用 `S2` 这类内部诊断编号作为用户可见 ID；ID 可使用 `N<traceStepIndex>-...`。
- `resolution` 可选值为 `unresolved`、`recovered`、`non_blocking`。它用于 Phase 2 判断该 issue 是否应提升为 finding。
- 最终校验必须传入 `--static`；静态 issue 与 Phase 1 单元格必须保留，误报只能通过 `resolution=non_blocking` 和 `resolutionEvidence` 解释。

## findings

`findings` 是 Phase 2 面向用户展示的关键诊断发现列表。它不是 `issues` 的简单平铺，而是若干 issue 组成的因果组。

```json
{
  "id": "finding-1",
  "severity": "high",
  "impact": "quality_degrading",
  "summary": "关键发现：Agent 在规划阶段选择了不相关的事件过滤参数，导致专用脚本未能返回用户关心的 Kerberos 日志内容。",
  "evidence": "节点 #12 中使用 --event E16,E17 分析 Kerberos 认证事件，但这些事件 ID 与 Kerberos 不相关。",
  "issueRefs": [
    {
      "issueId": "N12-planning-constraint_ignorance",
      "role": "root"
    },
    {
      "issueId": "N13-action-parameter_error",
      "role": "downstream"
    }
  ],
  "correctionGuidance": "在规划提示中加入事件域白名单约束校验，参数生成后先做 schema 比对。",
  "confidence": 0.86
}
```

允许的 `impact`：

- `result_blocking`
- `quality_degrading`
- `recovered_cost`
- `risk`

允许的 `issueRefs[].role`：

- `root`
- `contributing`
- `downstream`

规则：

- 每条 finding 必须有且只有一个 `role=root` 的 issueRef。
- `issueRefs[].issueId` 必须能在 `issues` 中找到。
- 同一 finding 内不能重复引用同一个 issue。
- 同一个 issue 默认不能被多个 finding 同时声明为 root。
- 下游症状通常保留为当前 finding 的 `downstream`，不要重复提升成另一条 finding。
- 每条 finding 必须提供独立的 `correctionGuidance`。
- findings 按严重度、因果重要性和用户关注价值排序，最重要的放第一条。

## rootCause

字段名 `rootCause` 为历史兼容。用户可见语义是“关键诊断发现”：没有明确关键发现时使用 `null`。当 trace 明确失败时，它可以表示失败根因；当 trace 最终完成或问题已恢复时，它应表示潜在问题或过程风险，不能在自然语言里写成“根因”。

新报告中，`rootCause` 必须与 `findings[0]` 语义一致；如果没有 `findings`，前端和后端只能按旧协议兼容展示单条关键发现。

```json
{
  "criticalStep": 2,
  "criticalTraceStepIndex": 12,
  "criticalTraceNodeLabel": "工具调用 · bash tree ...",
  "criticalTraceNodeKind": "tool",
  "criticalAnchorId": "event:n1:3",
  "criticalModule": "planning",
  "criticalErrorType": "constraint_ignorance",
  "summary": "中文关键发现结论，1-2 句",
  "evidence": "中文关键证据",
  "cascadingChain": [
    {
      "step": 3,
      "diagnosticStep": 1,
      "traceStepIndex": 12,
      "traceNodeLabel": "工具调用 · bash tree ...",
      "traceNodeKind": "tool",
      "module": "system",
      "errorType": "tool_execution_error",
      "consequence": "中文级联影响",
      "anchorId": "optional-anchor"
    }
  ],
  "correctionGuidance": "中文修复建议",
  "confidence": 0.8
}
```

规则：

- `criticalModule` 必须是允许模块之一。
- 不要选择留白模块。
- 不要选择首个记录的 Memory/Reflection，除非它明确引用 trace 前历史。
- `summary` 最多 1-2 句，只讲“发现了什么、为什么值得关注”；不要堆原始报错、命令、节点列表、重复模式和长推理。
- `summary` 默认使用“关键发现”“潜在问题”“过程风险”等表达。只有 trace 明确失败且该问题直接导致失败时，才可以使用“根因”。
- `evidence` 放短而具体的事实证据，例如命令、报错、工具输出、节点引用。
- `correctionGuidance` 面向 agent、prompt、工具约束或 skill 设计者。
- `criticalTraceStepIndex`、`criticalTraceNodeLabel`、`criticalAnchorId` 必须尽量填写；`criticalStep` 只保留兼容。
- `cascadingChain` 中每个节点必须尽量填写 `anchorId`、`traceStepIndex`、`traceNodeLabel`、`traceNodeKind`。
- 自然语言中不要写“第 2 个诊断 Step”；如需提位置，使用“左侧节点 #12”。

## humanSummary

`humanSummary` 是给聊天 UI 展示的一段中文摘要。应包含：

- 关键左侧节点、模块、错误类型。
- 简短因果解释。
- 简短修复方向。

如果没有关键发现，说明未发现足够证据，并给出下一步建议。
