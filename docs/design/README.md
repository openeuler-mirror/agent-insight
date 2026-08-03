# 需求清单（agent-insight 设计文档索引）

本目录收录 agent-insight 的所有需求设计。**每个需求一个子目录**,内部按三阶段组织:
`phase1 需求分析` → `phase2 需求设计` → `phase3 开发计划`。

> 说明:子目录里的设计文档**只描述设计意图,不记录实现进度**。「是否实现」这类执行状态统一在本清单跟踪。
>
> **Agent RAS** 相关设计见 [`docs/agent-ras/`](../agent-ras/README.md)（本表 RAS 行链接指向该处）。

## 清单

| 需求名称 | 目录 | 需求描述 | 类型 | 创建时间 | 是否实现 | 对应 issue |
|-|-|-|-|-|-|-|
| Hermes 平台适配（OTel/OTLP 接入） | [hermes-otel-adapter](hermes-otel-adapter/) | 让运行在 hermes 平台的 Agent 通过标准 OpenTelemetry(OTLP)协议把链路数据上报到 agent-insight,被解析、按会话归并、标记 `framework=hermes` 并在观测看板呈现;子 Agent 与 skill 对齐 opencode 成为一等公民(可评测/注册/A-B) | Feature | 2026-06-02 | 🟨 MVP 实现中（仓库内置轻量插件、OTLP JSON 高保真采集与 subagent 关联开发中；原生事件上报作为备用方案） | —（待补） |
| Framework 适配器注册表 | [framework-adapter-registry](framework-adapter-registry/) | 把散落在数十处的「按框架走分支」收进统一的 `FrameworkAdapter` 注册表;第一刀治理三块:skill 抽取重复(4~5 份拷贝)、claude 入库归一化(5 个调用点)、框架名值域不统一(`claude`/`claudecode`) | Refactor | 2026-06-04 | 🟡 实现中（注册表骨架已落地,旧调用点切换与验证待开发） | —（待补） |
| AgentDebug 与 Skills 分析并行化 | [agentdebug-parallel-skills-analysis](agentdebug-parallel-skills-analysis/) | 将 AgentDebug 主诊断与 Skills 步骤核验拆成独立存储和独立轮询链路,支持点击诊断后并行运行、先完成先展示;不兼容旧 `reportJson.skillsAnalysis` 数据 | Feature | 2026-06-05 | ✅ 已实现 | —（待补） |
| Claude Code OTel 工具输出采集补全 | [claude-code-otel-tool-output-followup](claude-code-otel-tool-output-followup/) | 记录 Claude Code 官方 OTel logs 中 `tool_result` 只有 metadata、raw API body file 模式未产出 `body_ref`、本地 transcript 有工具输出但平台 trace 仍缺 output 的遗留问题;后续需在 OTel traces、raw body file 模式或 Claude native JSONL 补充源之间选定稳定方案 | Bugfix | 2026-06-10 | ⬜ 未实现（遗留问题已记录,待后续开发） | —（待补） |
| 质量监控结果维度评测 | [quality-monitoring](quality-monitoring/) | 对 Agent 最终交付按忠实度、指令遵循、答案质量、准确性四项异步评测，持久化证据并为质量报告、趋势和执行记录提供统一分数 | Feature | 2026-06-23 | 🟡 实现中（代码与自动化验证已完成，浏览器验收待确认） | —（待补） |
| 标签化版本管理与版本分析 | [tag-based-version-management](tag-based-version-management/) | 通过系统标签、版本标签、业务标签三类标签重构版本管理、链路追踪打标/筛选与版本分析；版本分析只做已有 Trace 指标汇总，不做模型分析 | Feature | 2026-07-06 | 🟡 MVP implemented; browser validation pending | —（待补） |
| Trace 回流到评测数据集 | [trace-to-dataset-backflow](trace-to-dataset-backflow/) | 支持 Trace 单条/批量回流到评测数据集、数据集新增自定义字段，以及逐条编辑样本字段值；input/output 使用评测执行已有逻辑处理后写入 | Feature | 2026-07-15 | 🟡 实现中（代码与目标测试已完成，浏览器验收待确认） | —（待补） |
| Openclaw 平台适配 | [openclaw-adapter](openclaw-adapter/) | (待补充:定义 Openclaw 平台的接入适配设计,包括链路数据上报、解析及面板呈现等) | Feature | 2026-06-17 | ⬜ 未实现（设计起草中） | —（待补） |
| Trace Bundle 导入导出 | [trace-bundle-import-export](trace-bundle-import-export/) | 将链路追踪详情导出的 Trace 作为版本化 Bundle 重新导入平台，保留无冲突 ID，并完整恢复多 Agent 父子树 | Feature | 2026-07-15 | 🟡 实现中（代码与自动化验证已完成，浏览器验收待确认） | —（待补） |
| Langfuse Trace 完整展示 | [langfuse-trace-fidelity](langfuse-trace-fidelity/) | 为 Langfuse OTLP 增加独立完整节点快照，保留业务 CHAIN/AGENT/TOOL 与真实时序，同时保持其他框架和现有 interactions 行为不变 | Bugfix | 2026-07-21 | 🟡 代码与自动化验证已完成，浏览器验收待确认 | —（待补） |
| agent_ras 迁入与环内监控 | [../agent-ras/design/inproc-package-migration](../agent-ras/design/inproc-package-migration/) | 将 agent_ras 整包迁入仓根 `agent_ras/`；只保留同进程 runtime；anomaly/actions 经 **`/api/ingest/ras`** 落库并在 **可靠性观测**及链路详情展示（不进 OTLP 热路径） | Feature | 2026-07-25 | ✅ inproc 已实现 | 安装器 + 可靠性链路 + ingest API |
| AgentRAS 可靠性独立页面 | [../agent-ras/design/reliability-standalone-ui](../agent-ras/design/reliability-standalone-ui/) | 将 RAS 从链路追踪中剥离，新建独立导航分组"AgentRAS 可靠性"（与运行观测同级）；子页面：可靠性追踪（故障统计 + Trace 列表 + 详情 + 节点跳转）、故障注入与评测（UI + mock） | Feature | 2026-07-28 | ⬜ 未实现 | —（待补） |
| LLM 过度思考（Analysis Paralysis）二阶段检测 | [../agent-ras/design/detector-analysis-paralysis](../agent-ras/design/detector-analysis-paralysis/) | 新增触发词库 Stage1 + LLM 语义判定 Stage2 的二阶段检测，识别 agent 在推理中反复自我质疑、方案摇摆但语义停滞的分析瘫痪模式；复用现有 L3 Skill 检测通道 | Feature | 2026-07-29 | ⬜ 未实现（方案设计阶段） | —（待补） |
| LLM Agent 规划错误（Planning Error）检测 | [../agent-ras/design/detector-planning-error](../agent-ras/design/detector-planning-error/) | 识别策略层规划错误（约束忽略、不可行动作、低效计划、错误工具选择等）；判定依赖任务约束/环境状态/工具契约等外部信息，按信息完备度分层检测与恢复 | Feature | 2026-07-30 | ⬜ 未实现（方案设计阶段） | —（待补） |
| LLM Agent 领域认知偏差（Domain Cognitive Bias） | [../agent-ras/design/detector-domain-cognitive-bias](../agent-ras/design/detector-domain-cognitive-bias/) | 六类信念层故障场景说明书 + 业界检测/恢复/故障注入调研；与分析瘫痪、规划错误形成认知层三角覆盖 | Research / Feature | 2026-07-30 | ⬜ 未实现（调研与方案设计阶段） | —（待补） |
| Agent 可靠性开源生态调研 | [../agent-ras/design/open-source-ecosystem-survey](../agent-ras/design/open-source-ecosystem-survey/) | 调研与 agent_ras 可对照的 agent 检测/恢复/可靠性开源仓库（不含安全审计类），产出能力矩阵 + 定位分析 | Research | 2026-07-29 | ✅ 已完成（调研报告） | —（待补） |
| RAS ingest 契约收紧（兼容层破除） | [../agent-ras/design/ras-ingest-contract-purge](../agent-ras/design/ras-ingest-contract-purge/) | flat+必填 deliveryId+浅路径唯一契约；删除 rewrite/rasEventId/正文兜底；旧 RasAnomalyEvent 可清 | Refactor | 2026-07-31 | ✅ 已实现 | —（待补） |

## 字段口径

- **创建时间**:取该需求 phase1 起草日期。
- **是否实现**取值:
  - ⬜ **未实现** —— 仅有设计,代码未动
  - 🟡 **实现中** —— 部分落地
  - ✅ **已实现** —— 全部落地并通过验收
- **对应 issue**:关联的跟踪 issue/工单链接;暂无则填「待补」。

## 新增需求时的约定

1. 在本目录下新建一个**短横线命名**的子目录(如 `xxx-yyy`)。
2. 子目录内放 `phase1-requirements-analysis.md` / `phase2-requirements-design.md` / `phase3-development-plan.md`。
3. **回到本清单追加一行**,填齐上表各列。
