# Agent Insight 接入 Goal Plus

本目录描述**修改 Agent Insight、只读接入 Goal Plus**的完整方案。Goal Plus 继续负责目标编排，Agent Insight 负责采集、关联、质量判定和可视化。

## 文档导航

| 文档 | 解决的问题 |
|-|-|
| [Phase 1：需求分析](phase1-requirements-analysis.md) | 能否接入、当前数据边界、完整 trace 的判定标准与风险 |
| [Phase 2：接口与数据设计](phase2-requirements-design.md) | collector、API、领域模型、存储、关联和查询契约 |
| [全流程与状态流](architecture-flow.md) | 部署、采集、Codex/Pi、关联、完整性、故障恢复和 UI 的全面流程图 |
| [Phase 3：开发计划](phase3-development-plan.md) | 分阶段任务、验收标准、测试策略和上线顺序 |
| [集成后高保真交互原型](agent-insight-goal-plus-hifi.html) | Agent Insight 完成 Goal Plus 接入后的产品界面与交互 |

## 结论

可以集成，并能达到可审计的完整采集，但必须组合两条链路：

1. Agent Insight collector 只读 `.gp`，采集 Goal Plus 的 goal/run/candidate/iteration/selection 等权威语义。
2. Codex 复用 Agent Insight 现有 hooks/OTLP；Pi 在 `--no-extensions` 约束下由 collector 被动导入 native session。
3. 服务端通过明确的 native ID、session ID 或 deterministic task name 建立关联；不按时间窗口猜测。
4. UI 同时展示 completeness 与 fidelity，明确区分缺失、策略裁剪和重建时间。

高保真 HTML 是可独立打开的设计原型；实际产品行为和支持范围以源码、API 契约及用户指南为准。
