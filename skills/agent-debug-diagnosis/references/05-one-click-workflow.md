# 一键诊断流程

一键诊断包含两个顺序阶段，但只启动一次 Agent；两个阶段都在同一次 `agent-debug-diagnosis` Skill 执行中完成。

## 阶段一：冻结主诊断

同一个 Agent 先运行现有 AgentDebug 五模块流程。该阶段不能读取专项诊断结果，只根据 trace、静态检测和 AgentDebug 规程生成完整主报告，并写入 `.agent-insight/agent-debug-core.json`。

机制或修复方向不同的问题必须保留为不同 finding；存在触发或上下游关系时使用 `issueRefs` 和故障链关联。core finding 的 `id`、`summary`、`evidence`、`issueRefs` 和 `correctionGuidance` 从此冻结。

## 阶段二：调用专项诊断器并生成最终报告

当前 Agent 运行 `scripts/detector_runner.py run-all --mode one_click`。runner 通过 `detectors/*/detector.json` 自动发现全部可用诊断器；服务端不运行诊断器，也不维护注册表。

当前 Agent 基于诊断器的结构化事实和必要的 trace 样本补充中文说明，再按 `references/08-detector-reconciliation.md` 直接生成完整最终报告：

- 重复结果写入目标 core finding 的 `supplementalEvidence`；不展示诊断器来源。
- 只有因果关系但机制或修复方向不同的结果写入 `detectorFindings`，可以通过 `relatedFindingId` 建立关联。
- 没有有效合并目标时默认独立保留，不能静默消失。
- 任何 core finding 都不能被删除或改写。
- `facts`、`anchors`、`details` 必须从原始专项结果无损复制。

最后由当前 Agent 写入 `.agent-insight/agent-debug-final.json` 并调用校验脚本。服务端只读取、标准化、存储和返回该最终报告。
