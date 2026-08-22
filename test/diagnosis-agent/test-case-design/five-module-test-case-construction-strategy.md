# 五模块单步认知诊断测试用例构建策略

> 本文档定义 agent-debug-diagnosis Skill 五模块单步认知诊断（Memory / Reflection / Planning / Action / System）的测试用例构建策略，目标是完整覆盖 [02-error-taxonomy.md](../../../skills/agent-debug-diagnosis/references/02-error-taxonomy.md) 中定义的全部错误 ID 的诊断能力。
>
> 创建时间：2026-08-08

---

## 1. 核心目标

完整覆盖 [02-error-taxonomy.md](../../../skills/agent-debug-diagnosis/references/02-error-taxonomy.md) 中 41 个错误 ID 的诊断能力，验证：

- **识别能力**：每个 ID 都能被正确识别。
- **拒识能力**：相似但不构成错误的情况不误报。
- **独立判定**：同一 step 内多模块错误互不干扰。
- **时序稳定**：priorWindow 随 step 推进保持稳定。

---

## 2. 覆盖维度（4 维正交）

| 维度 | 含义 | 策略 |
|---|---|---|
| **错误 ID 维度** | 41 个 ID 逐一覆盖 | 每个 ID 至少 1 个正向 + 1 个边界用例 |
| **模块维度** | 5 个模块独立可测 | 单 step 单模块单错误（最简用例） |
| **组合维度** | 真实场景多错误共存 | 单 step 多模块错误 + 多 step 错误传播 |
| **证据维度** | 每个 ID 的判定依据不同 | 按"判定要点"构造必要证据锚点 |

---

## 3. 分层用例集（6 层）

### 3.1 第 1 层：单 ID 单点覆盖（基线层，必做）

**目标**：每个错误 ID 都有最小可复现用例。

**构造方式**：单 step、单模块、单错误，其余模块和 step 都正常。

**数量**：41 个正向 + 边界用例（去重同义后约 78 个）。

**示例**：

- `memory/hallucination` 正向：step N 的 Memory 引用了 prior facts 中不存在的文件 `/foo/bar.js`。
- `action/redundant_call` 正向：短窗口内同工具同参数调用 3 次。
- `action/redundant_call` 边界：短窗口内同工具同参数调用 2 次（阈值边界，不应报）。

### 3.2 第 2 层：单 step 多模块共存（独立性层，必做）

**目标**：验证 [03-phase-analysis.md](../../../skills/agent-debug-diagnosis/references/03-phase-analysis.md) 的"同 step 内各模块互不倒推"原则。

**构造方式**：同一 step 内 2-3 个模块同时出错，且错误之间无因果关系。

**数量**：每模块组合至少 1 个 = **约 10 个**。

**示例**：step N 同时存在 Memory 引用过期文件 + Action 路径不存在 + Planning 缺少测试步骤，三个错误应被独立报告，互不掩盖。

### 3.3 第 3 层：跨 step 错误传播（时序层，必做）

**目标**：验证 priorWindow 稳定性和错误沿时序的因果传递。

**构造方式**：错误 A 在 step N 产生，错误 B 在 step N+1 因 A 而发生（但系统应独立判定 B，不倒推 A）。

**数量**：每个模块至少 1 条传播链 = **约 5 个**。

**示例**：step N 的 Memory 引用过期文件 → step N+1 的 Reflection 基于过期文件做了结果误读 → step N+2 的 Planning 基于误读制定了错误计划。三个错误应分别在各自 step 被识别，priorWindow 不应回溯改写。

### 3.4 第 4 层：边界与拒识（防误报层，必做）

**目标**：验证不会误报正常行为。

**构造方式**：构造"看起来像错误但不是"的场景。

**数量**：每个 ID 的判定要点都构造 1 个边界 = **约 40 个**。

**示例**：

- `reflection/missed_test_failure` 边界：输出含 `AssertionError` 但是在注释/字符串里，不是真实测试失败。
- `system/auth_failure` 边界：日志含 `401` 但是日期 `20260401`，不是 HTTP 401（[03-phase-analysis.md](../../../skills/agent-debug-diagnosis/references/03-phase-analysis.md) Phase 0 明确要求）。
- `planning/over_engineering` 边界：引入框架但确实有必要（性能、可维护性）。

### 3.5 第 5 层：脚本静态 vs LLM 语义分工（协议层，必做）

**目标**：验证 [02-error-taxonomy.md](../../../skills/agent-debug-diagnosis/references/02-error-taxonomy.md) 末尾的分工规则——Action/System 优先信脚本，Memory/Reflection/Planning/`tool_misuse` 靠 LLM。

**构造方式**：

- Action 类错误：脚本能静态判定的（路径不存在、危险命令、格式错误）—— 用例中确保脚本信号足够，LLM 不应改写。
- Memory/Reflection 类错误：脚本无信号 —— 用例中 prior facts 和工具输出需要 LLM 语义理解才能判定。
- `tool_misuse`：唯一需要 LLM 语义判断的 Action 错误 —— 构造"工具能跑但选择不合适"的场景。

**数量**：**约 10 个**，覆盖分工边界。

### 3.6 第 6 层：Phase 0 系统风险预检（预检层，必做）

**目标**：验证 [03-phase-analysis.md](../../../skills/agent-debug-diagnosis/references/03-phase-analysis.md) Phase 0 的预检规则。

**构造方式**：

- 正向：连续 401、上下文溢出、工具系统性不可用、早期用户取消。
- 边界：`tree: command not found`（属 Action）、`No such file`（属 Action/Memory）、业务日志里的 `401` 字符串、单次工具失败后修正。

**数量**：4 正向 + 4 边界 = **8 个**。

---

## 4. 证据锚点构造规则（按模块）

每个错误 ID 的"判定要点"决定了用例必须包含哪些证据字段：

| 模块 | 必备证据字段 | 构造要点 |
|---|---|---|
| **Memory** | prior facts、文件读写历史、用户约束原文 | 必须在 step N 之前的 step 里埋入可对照的 prior facts，让 Memory 的引用能被验证真伪 |
| **Reflection** | 上一步工具返回（status/output/error） | step N-1 的工具输出必须包含可被误读的内容（如 FAILED 字样、warning） |
| **Planning** | 任务约束、计划文本、同 step Action | 必须有明确的约束来源（用户消息、系统配置），且 step N 的 Action 与 Planning 文本可对照 |
| **Action** | 工具调用真实参数、返回状态、错误信息 | 参数和错误信息必须具体（如 `No such file: /foo/bar`），不要用模糊描述 |
| **System** | 外部环境证据（HTTP 状态、token 用量、超时日志） | 必须是环境侧证据，不能让 Agent 背锅 |

---

## 5. 数据来源策略

| 来源 | 用途 | 比例 |
|---|---|---|
| **合成 trace**（最小可复现） | 第 1-2 层单点覆盖，可控性强 | 约 70% |
| **真实 trace 改造**（从 jiuwenswarm 模板注入错误） | 第 3-4 层时序和边界，真实度高 | 约 20% |
| **真实故障 trace**（从实际诊断中收集） | 第 5-6 层协议验证，含真实噪声 | 约 10% |

合成 trace 的骨架参考 [test/agent-debug-diagnosis/](../../../test/agent-debug-diagnosis/) 现有 jiuwenswarm 方言格式，保持字段结构一致。

---

## 6. 用例元数据规范

每条用例应包含：

```json
{
  "caseId": "memory-hallucination-positive-01",
  "layer": "L1-single-id",
  "module": "Memory",
  "errorId": "hallucination",
  "polarity": "positive",
  "expectedFinding": {
    "errorId": "hallucination",
    "severity": "high",
    "evidenceAnchor": "step=3, memory引用了/foo/bar.js，prior facts中无此文件"
  },
  "turns": [...]
}
```

---

## 7. 规模估算

| 层 | 用例数 | 累计 |
|---|---|---|
| L1 单 ID 单点 | 39 正向 + 边界用例（去重同义） | — |
| L2 单 step 多模块 | 10 | — |
| L3 跨 step 传播 | 5 | — |
| L4 边界拒识 | 40 | — |
| L5 脚本/LLM 分工 | 10 | — |
| L6 Phase 0 预检 | 8 | — |
| **合计** | **约 100+** | — |

---

## 8. 验证指标

- **ID 覆盖率** = 被至少 1 个正向用例覆盖的 ID 数 / 39（去重同义）→ 目标 100%。
- **正向通过率** = 正向用例检出正确 ID 的数 / 正向用例数 → 目标 ≥ 95%。
- **独立性通过率** = L2 用例中多错误被独立报告的数 / L2 用例数 → 目标 100%。
- **时序稳定性** = L3 用例中 priorWindow 未回溯改写的数 / L3 用例数 → 目标 100%。
