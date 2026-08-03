# Agent RAS 需求设计清单

本目录收录 **Agent RAS** 相关需求设计。  
全仓通用需求仍见 [`docs/design/README.md`](../../design/README.md)；其中 RAS 条目链接指向此处。

> 子目录只描述设计意图，不记录实现进度。「是否实现」在全仓需求清单中跟踪。  
> 命名约定：`<领域>-<主题>` kebab-case；检测类需求统一 `detector-` 前缀。

| 需求名称 | 目录 | 需求描述 | 类型 | 创建时间 | 是否实现 |
|-|-|-|-|-|-|
| 包级需求与开发计划 | [package-baseline](package-baseline/) | agent_ras 包级 IR（需求分析）与 SDD 开发计划 | Baseline | 2026-07-25 | ✅ 文档已沉淀 |
| 同进程迁入与环内监控 | [inproc-package-migration](inproc-package-migration/) | 将 agent_ras 整包迁入仓根；同进程 runtime；anomaly/actions 经 `/api/ingest/ras` 落库并在可靠性观测展示 | Feature | 2026-07-25 | ✅ inproc 已实现 |
| AgentRAS 可靠性独立页面 | [reliability-standalone-ui](reliability-standalone-ui/) | 独立导航「AgentRAS 可靠性」；可靠性追踪 + 故障注入与评测 | Feature | 2026-07-28 | ⬜ 未实现 |
| Agent 可靠性开源生态调研 | [open-source-ecosystem-survey](open-source-ecosystem-survey/) | 对照开源检测/恢复仓库，产出能力矩阵与定位 | Research | 2026-07-29 | ✅ 已完成 |
| LLM 过度思考（Analysis Paralysis）二阶段检测 | [detector-analysis-paralysis](detector-analysis-paralysis/) | 触发词 Stage1 + LLM 语义 Stage2；复用 L3 Skill 通道 | Feature | 2026-07-29 | ⬜ 未实现（方案设计） |
| LLM Agent 规划错误（Planning Error）检测 | [detector-planning-error](detector-planning-error/) | 策略层规划错误；依赖外部信息包分层检测与恢复 | Feature | 2026-07-30 | ⬜ 未实现（方案设计） |
| LLM Agent 领域认知偏差（Domain Cognitive Bias） | [detector-domain-cognitive-bias](detector-domain-cognitive-bias/) | 六类信念层故障（过时知识/确认偏差/权威盲信/跨源冲突/策略违背/假前提）；业界检测·恢复·场景构建调研 + 金样例说明书 | Research / Feature | 2026-07-30 | ⬜ 未实现（调研与方案设计） |
| RAS ingest 契约收紧（兼容层破除） | [ras-ingest-contract-purge](ras-ingest-contract-purge/) | 只保留 flat+deliveryId+浅路径；删除 rewrite/rasEventId/witty 别名/正文兜底；旧数据可清 | Refactor | 2026-07-31 | ✅ 已实现 |
