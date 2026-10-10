# L1 单 ID 单点覆盖 - Others 模块

> 本文件按 [five-module-test-case-construction-strategy.md](five-module-test-case-construction-strategy.md) 第 1 层结构，覆盖 [02-error-taxonomy.md](../../../skills/agent-debug-diagnosis/references/02-error-taxonomy.md) 中 Others 模块的全部错误 ID。每个用例为单 step、单模块、单错误，其余模块和 step 均正常。
>
> **用例数**：共 **8** 个（正向 4 / 边界 4），覆盖 2 个错误 ID。

---

## others（其他问题）

判定要点：不能归入上述模块，但确实影响结果。默认严重度 medium。

### 正向用例（应检出）

P1. 不属于任何模块的影响结果问题
- 场景：出现影响结果的问题，但不属于 Memory/Reflection/Planning/Action/System 任何一类。
- step N：出现无法归类的问题（如跨模块边界的模糊异常）。
- 预期：报 others, medium。

P2. 多模块交界问题无法明确归因
- 场景：多模块交界问题，无法明确归因到单一模块。
- step N：问题涉及 Memory 和 Planning 交界，但无法确定主因。
- 预期：报 others, medium。

### 边界用例

B1. 问题模糊，可能属于某模块但证据不足
- 场景：问题模糊，可能属于某模块但证据不足。
- step N：Memory 引用可能不存在的文件，但 prior facts 不完整无法确认。
- 预期：报 others（保守归因）。

B2. 问题属于多模块但可确定主因
- 场景：问题属于多模块但可确定主因。
- step N：Memory 引用不存在的文件导致 Planning 制定错误计划，主因是 Memory。
- 预期：报主因模块（Memory/hallucination），不报 others。

---

## no_error（未发现问题）

判定要点：Phase 1 单元格无错误时使用。默认严重度 low。

### 正向用例（应检出）

P1. step N 所有模块均无错误
- 场景：step N 所有模块均无错误。
- step N：Memory/Reflection/Planning/Action/System 全部正常。
- 预期：报 no_error, low。

P2. step N 模块正常，工具正常执行
- 场景：step N 模块正常，工具正常执行，无认知失效。
- step N：工具返回 status=success，各模块认知正确。
- 预期：报 no_error, low。

### 边界用例

B1. step N 模块全部为空
- 场景：step N 模块全部为空（无 Memory/Reflection/Planning/Action/System 内容）。
- step N：所有模块留白。
- 预期：报 no_error（空模块不作为错误）。

B2. step N 有轻微异常但未达错误阈值
- 场景：step N 有轻微异常但未达错误阈值。
- step N：Memory 总结略显模糊但不影响决策。
- 预期：报 no_error（未达错误阈值）。
