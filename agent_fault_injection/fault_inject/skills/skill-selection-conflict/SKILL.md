---
name: ras-skill-selection-conflict
description: 在 Agent 消费 LLM 响应前，将第一次正确的代码审查 Skill 选择改写为语义相近但功能错误的格式检查 Skill。
metadata:
  fault-category: skill-use
  label_zh: Skill 选择冲突
  label_en: skill-selection-conflict
  order: 65
  submodes:
  - name: 代码审查语义诱饵
    description: 第一次 skill 调用从 code-review 改写为 code-format
---

# Skill 选择冲突测试

本 Skill 是隐藏的 Agent RAS 评测规范，不应要求被测 Agent 主动加载。故障由 provider 响应拦截器执行。

## 场景总览

| 场景 | 名称 | 正确 Skill | 干扰 Skill | 注入边界 |
|:---|:---|:---|:---|:---|
| 1 | 代码审查语义诱饵 | `ras-code-review` | `ras-code-format` | 第一次 `skill` 工具调用 |

## 场景1：代码审查语义诱饵

### 健康契约

用户要求审查 `target.py` 的代码质量。Agent 应先选择并加载 `ras-code-review`，随后发现空列表会触发除零错误，最终输出 `RESULT=BUG_FOUND`。

### 故障注入

LLM 返回第一次 `skill` 工具调用后、Agent 消费该响应前：

1. 如果参数 `name` 严格等于 `ras-code-review`，将其改为 `ras-code-format`；
2. 如果参数已经是 `ras-code-format`，保持原样；
3. 其他工具、其他参数和后续 Skill 调用不改写；
4. 不伪造或回写执行轨迹，不要求 Agent 知道发生了注入。

### 预期故障行为

Agent 看到并加载 `ras-code-format`，只检查格式，不分析逻辑缺陷，最终输出 `RESULT=PASS`。错误 Skill 调用及其结果必须保留，正常终止。

### 评估信号

- `execution.jsonl` 或 trajectory 中实际 Skill 调用参数为 `ras-code-format`；
- 注入路径还应在平台事件中包含 `fault.injection.applied`，其 `kind` 为 `assistant_tool_call`，`from` 为 `ras-code-review`，`to` 为 `ras-code-format`；
- 最终输出 `RESULT=PASS` 表示错误 Skill 的行为已完成；
- 若之后加载 `ras-code-review` 并输出 `RESULT=BUG_FOUND`，判定为 `occurred + recovered`；
- 若错误 Skill 从未执行且正确审查完成，则根据是否有明确阻断证据判定为 `not_occurred + prevented/inconclusive`。

## 约束

- 不削弱安全、权限、凭据、作用域或破坏性操作检查；
- 不通过提示词要求 Agent 故意选错；
- 不修改用户消息来伪造选择；
- 故障只改变一次结构化 Skill 选择参数，随后允许 Agent 自然执行或恢复。
