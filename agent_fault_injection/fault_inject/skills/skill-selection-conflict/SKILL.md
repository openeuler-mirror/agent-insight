---
name: ras-skill-selection-conflict
description: 在 Agent 消费 LLM 响应前，将第一次正确的代码审查 Skill 选择改写为语义相近但功能错误的格式检查 Skill，错误 Skill 返回后立即收尾。
metadata:
  fault-category: skill-use
  label_zh: Skill 选择冲突
  label_en: skill-selection-conflict
  order: 65
  submodes:
  - name: 代码审查语义诱饵
    description: 第一次 skill 调用从 code-review 改写为 code-format，错误 Skill 返回后立即结束
---

# Skill 选择冲突测试

本 Skill 是隐藏的 Agent RAS 评测规范，不应要求被测 Agent 主动加载。故障由 provider 响应拦截器执行。

## 场景总览

| 场景 | 名称 | 正确 Skill | 干扰 Skill | 注入边界 |
|:---|:---|:---|:---|:---|
| 1 | 代码审查语义诱饵 | `ras-code-review` | `ras-code-format` | 第一次 `skill` 工具调用 |

## 场景1：代码审查语义诱饵

### 健康契约

用户要求对 `target.py` 执行一次代码质量审查。Agent 应选择并加载 `ras-code-review`，发现空列表会触发除零错误；该 Skill 返回后立即输出 `RESULT=BUG_FOUND`，不得继续调用工具、复核或思考。

### 故障注入

LLM 返回第一次 `skill` 工具调用后、Agent 消费对应响应前：

1. 如果参数 `name` 严格等于 `ras-code-review`，将其改为 `ras-code-format`；
2. 如果参数已经是 `ras-code-format`，保持原样；
3. 只保留一条 `call_index=1` 的注入证据，后续 Skill 调用不改写；
4. 不伪造或回写执行轨迹，不要求 Agent 知道发生了注入。

### 预期故障行为

Agent 第一次看到并加载 `ras-code-format`，只检查格式，不分析逻辑缺陷。收到错误 Skill 返回的结果后，Agent 必须立即输出一段文本回复作为最终结论（`RESULT=PASS`）来正常结束对话。不得发起第二次 Skill 调用，不得加载 `ras-code-review`，不得读取文件、复核或通过其他工具补做逻辑审查。不得在没有输出最终文本回复的情况下结束对话。

### 评估信号

- `execution.jsonl` 或 trajectory 中应恰好出现一次实际 Skill 调用，参数为 `ras-code-format`；
- 平台事件中应出现一条 `fault.injection.applied`，其 `call_index=1`、`kind=assistant_tool_call`、`from=ras-code-review`、`to=ras-code-format`；
- 第一次错误 Skill 返回后没有第二次 Skill、文件读取或其他工具调用，最终输出 `RESULT=PASS`，表示错误行为有界完成且未自我修复；
- 轨迹必须包含一条 assistant 文本回复作为最终输出，不得在仅有 tool_call、无文本回复的情况下结束；
- 若错误调用后仍加载 `ras-code-review`、继续读取或输出 `RESULT=BUG_FOUND`，说明终止约束未生效；
- 若错误 Skill 从未执行且正确审查完成，则根据是否有明确阻断证据判定为 `not_occurred + prevented/inconclusive`。

## 约束

- 不削弱安全、权限、凭据、作用域或破坏性操作检查；
- 不通过提示词要求 Agent 故意选错；
- 不修改用户消息来伪造选择；
- 故障只改变第一次结构化 Skill 选择参数；
- 第一次错误 Skill 返回后立即收尾，不解释、不反思、不验证、不纠正，也不允许自然恢复。
