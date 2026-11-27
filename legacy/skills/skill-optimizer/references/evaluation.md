# 评估分层与诊断

本文件解释优化器如何从“规则合规、质量评估、运行时反馈、人工反馈”四类信号生成诊断，并驱动后续修改。

## 分层（L1/L2/L3/L4）

- L1 Static Compliance：硬规则检查（frontmatter、长度、基础结构等）。
- L2 Static Quality：LLM 语义评估（Role/Structure/Instruction/Content/Risk 等维度）。
- L3 Dynamic Adaptation：运行时反馈驱动（把真实失败经验固化回 Skill）。
- L4 Human Feedback：人工反馈驱动（基于专家直接指令强制优化）。


## 静态合规 (L1): Static Linter 静态检查器

检查项：
- **YAML Frontmatter**：`name`、`description` 是否存在且格式正确（如 kebab-case）。
- **Length Check**：内容长度是否超过阈值（如 5000 字符），防止 Context Window 溢出。
- **Header Structure**：是否包含必要的章节标题。

## 语义质量评估 (L2): LLM 6D Assessment 六维评估

1. **Role（职责明确性）**：Skill 是否聚焦于单一目的，description 是否包含具体可匹配的触发信号？
2. **Structure（结构规范性）**：格式是否规范：SKILL.md 保持精炼，且目标阅读者是具备专家背景的 agent？
3. **Instruction（指令适配性）**：指令自由度是否与任务的风险等级与确定性相匹配？
4. **Content（内容一致性）**：同一概念是否始终使用统一的术语？是否存在过期的信息或硬编码的参数？
5. **Risk（风险可控性）**：安全边界和权限控制是否完备？
6. **Execution（脚本与参考文档质量）**：脚本是否完整实现业务逻辑？错误处理是否包含具体的修复建议？

## 运行时反馈 (L3): Runtime Feedback 运行时反馈

解析测试报告中的 `skill_issues`（技能缺陷）和 `failures`（运行时异常），将非结构化错误描述转化为可执行优化建议。

## 人工反馈 (L4): Human Feedback

目标：把人工干预与直接指令转化为最高优先级的修改建议，强制 LLM 在修改时遵循该指令。


## 诊断报告结构（OPTIMIZATION_REPORT.md）

优化过程中会生成结构化诊断与报告文件（视模式与实现路径而定），用于：
- 解释“为什么要改”
- 驱动 mutator 产出 candidate 修改
- 支持人工审阅与回滚

每个诊断项包含：
- **Dimension**：评估维度（Role / Structure / Instruction / Content / Risk / Execution）
- **Issue Type**：问题类型（如 Missing Section、Vague Instruction）
- **Severity**：严重程度（Critical / High / Medium / Low）
- **Description**：问题描述
- **Suggested Fix**：建议修复方案
