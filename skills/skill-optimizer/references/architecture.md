# 架构与核心组件

本文件解释 `skill-optimizer` 的整体架构、核心组件与数据流。

# 核心目标

- **优化 Agent Skill 定义**：通过静态检查、质量评估，提升 Skill 执行效率和质量。
- **提供反馈驱动的迭代优化**：利用运行时反馈和人工指令，持续改进 Skill 实现。

## 核心组件

1. **SkillOptimizer（核心控制器）**：优化流程总调度，负责冷/热启动策略选择。
2. **EvaluationAdapter（评估适配器）**：对 Skill 进行全方位"体检"，输出结构化诊断结果。
3. **ExperienceCrystallizer（经验结晶器）**：处理运行时反馈，将非结构化测试报告转化为可执行优化建议。
4. **DiagnosticMutator（诊断式变异器）**：具备工具调用能力的 Agent，根据诊断结果精准修改代码。

## 优化分层

| 层次 | 名称 | 描述 | 适用场景 |
| :--- | :--- | :--- | :--- |
| **L1** | Static Compliance（静态合规） | 基于硬规则检查格式与规范 | 代码提交前、初次创建 |
| **L2** | Static Quality（静态质量） | 基于 LLM 五维评估分析逻辑质量 | 代码审查、冷启动优化 |
| **L3** | Dynamic Adaptation（动态适应） | 基于运行时 Trace 数据自动调优 | 集成测试、线上运行 |
| **L4** | Human Feedback（人工反馈） | 基于人工干预与直接指令进行强制优化 | 专家审查、人工干预 |

## 优化模式

- **static**：L1 + L2，适合初次创建或无运行日志时。
- **dynamic**：L3，需要 Agent Insight 平台历史运行日志。
- **hybrid**：L1 + L2 + L3，先静态后动态，合并所有诊断结果。
- **feedback**：L4，专门针对专家给出的直接反馈指令进行强制优化调整。

## 人工反馈

人工反馈作为**最高优先级** reflection 传递给 Mutator，强制 LLM 在修改时遵循该指令。支持输入反馈文件路径或直接文本两种形式。

## 数据流（简化）

1. 读取目标 Skill（目录或 `SKILL.md`）。
2. 生成诊断（静态合规 + LLM 评估，或从 SKILL\_INSIGHT\_HOST 拉取运行时反馈解析）。
3. 生成候选修改（对 SKILL 文本与必要辅助文件一起修改）。
4. 写入版本快照（`snapshots/v*`），并生成差异视图供人工 Review。

## 代码位置导航

- 入口脚本： scripts/main.py
- CLI 包装脚本： scripts/opt.sh
- 核心优化器：scripts/optimizer.py
- 引擎层（评估/结晶/变异/报告）：scripts/engine
- 诊断结构与打分： scripts/architecture

## 文档体系建议

- 面向 Agent 的执行入口： SKILL.md
- 面向维护者的背景与细节：`references/*.md`（本文件即其中之一）

