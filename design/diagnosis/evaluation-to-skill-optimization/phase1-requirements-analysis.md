# 评测 → 智能诊断 → Skill 优化：需求分析

## 目标与结论

可行，属于现有三个模块的证据与工作流衔接。交付目标是让用户从评测结果进入诊断，再将有依据、可归属于 Skill 的诊断发现转为优化计划。本文为待评审方案，不表示功能已实现。

## 现状证据

- `prisma/schema.prisma` 的 `ExperimentEvalResult` 已有 verdict、summary、score、pointsJson、evidenceJson 和人工修正分；结果可重评，不能仅引用可变行。
- `ExperimentTraceAttempt` 保存 case、attemptNo、traceId 和执行状态。诊断必须定位被测 Agent 的执行，不能误用评估器自身的 evaluationTraceId。
- `src/app/api/observe/executions/[executionId]/agent-debug/route.ts` 当前接收 user / force，复用规则基于 execution、interactionsHash 和 generator，未接收实验结果集合。
- `AgentDebugReport` 当前 executionId 唯一；同一执行的不同评测上下文不能直接共用或覆盖这条缓存。
- `AgentDebugFinding` 已有 summary、evidence、correctionGuidance、confidence 和 issueRefs，可适配为优化计划输入，但尚无可靠的 Skill 版本归属。
- `SkillOptimizationRecord` 已有 sourceKind、sourceRefsJson、sourceExperimentId、retestExperimentId 和候选发布状态；当前 sourceKind 仅支持 user / evaluation / experiment。
- `SkillOptPlanItem` 已有修改目标、理由、建议和冲突状态；复用现有优化器、候选 Diff、自验证及复测发布流程。

## 用户流程与范围

1. 评测 Case 详情勾选已完成的评估器结果，点击「用于智能诊断」，确认输入、被测 Trace 和版本。
2. 诊断显示评测证据、执行证据及其关联；用户勾选与某个 Skill 有关的发现，点击「用于 Skill 优化」。
3. 确认 Skill name / 基线版本 / 修改约束后，生成优化计划；确认计划才生成候选。
4. 展示 Diff；复用来源实验配置做候选复测，用户决定是否发布。

首期支持单 Case、多评估器、一个被测执行、一个目标 Skill。实验级批量诊断、跨 Case 聚类、多 Skill 自动拆分和没有 Trace 的结果级诊断放后续。没有 Trace 的评测结果首期仍可查看，但不能宣称完成执行根因分析。

## 验收标准

- 诊断输入包含所选结果的原始评分、人工修正、结论、评分点和证据快照；可回溯实验、Case、结果及执行 attempt。
- 重评或人工改分不改变旧诊断依据；新输入生成新 run，相同输入防重复提交。
- 仅使用最终完成且用户选中的诊断发现；运行中、失败或证据不足状态不能静默转入自动修改。
- 明确区分 Skill、Agent、工具、环境和未知原因；环境问题不默认成为 Skill 修改项。
- 未知或多 Skill 归属要求用户明确选择；基线版本不匹配阻止直接应用。
- 优化输入与计划条目可追溯至 finding 和证据；候选复测沿用数据集、评估器、Agent、模型和运行配置，变化时标明不可直接对比。
- 重复点击、刷新、任务失败、跨用户引用和来源失效有明确行为。
- 数据库升级必须无损保留既有数据与关联：迁移前后原有记录主键集合及原有字段逐项一致，关联完整性不退化，历史页面仍可读取。迁移、重复执行及恢复演练通过后才能上线；不能仅以 schema 同步成功作为验收。
- 历史缺失信息保持未知，不将未记录的 Skill 版本补成最新版，不为旧报告补造评测快照或来源关联。
- 确认未调用 Skill 且不存在已核实的未触发问题时，不提供直接 Skill 优化入口；调用记录缺失与明确未调用分开呈现。

## 方案选择

仅传文本实现较快，但丢失版本和证据，不采用。推荐传服务端引用并冻结快照，再映射结构化计划；需要增加持久化 run 与适配层，但可审计、可复测。首期不采用诊断后自动修改并发布，避免将不确定归因直接固化进 Skill。
