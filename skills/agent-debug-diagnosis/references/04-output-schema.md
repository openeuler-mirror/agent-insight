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

短路规则：

- 如果 `shortCircuited=true`，`phase1Grid` 和 `issues` 为空数组。
- 如果 `shortCircuited=true`，仍然返回 `rootCause`，通常是 `system`。
- 如果 `shortCircuited=false`，继续正常认知诊断。

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

每个 step 必须包含五个模块，其中 System 是外部证据模块。

```json
{
  "step": 1,
  "sourceInteractionIndex": 0,
  "title": "Step 1",
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
  "module": "action",
  "errorDetected": true,
  "errorType": "parameter_error",
  "severity": "medium",
  "evidence": "中文证据，可包含原始英文报错",
  "reasoning": "中文判定理由",
  "confidence": 0.86,
  "anchorId": "optional-anchor"
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

`issues` 是 `phase1Grid` 中检测到错误的扁平列表。

```json
{
  "id": "S2-action-parameter_error",
  "step": 2,
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

## rootCause

没有明确根因时使用 `null`。有根因时结构如下：

```json
{
  "criticalStep": 2,
  "criticalModule": "planning",
  "criticalErrorType": "constraint_ignorance",
  "summary": "中文根因说明",
  "evidence": "中文关键证据",
  "cascadingChain": [
    {
      "step": 3,
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
- 不要选择 Step 1 的 Memory/Reflection，除非它明确引用 trace 前历史。
- `summary` 要解释为什么它是根因，而不是复述错误类型。
- `correctionGuidance` 面向 agent、prompt、工具约束或 skill 设计者。

## humanSummary

`humanSummary` 是给聊天 UI 展示的一段中文摘要。应包含：

- 关键 step、模块、错误类型。
- 简短因果解释。
- 简短修复方向。

如果没有根因，说明未发现足够证据，并给出下一步建议。
