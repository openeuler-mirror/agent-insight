# 需求清单（agent-insight 设计文档索引）

本目录收录 agent-insight 的所有需求设计。默认每个需求一个子目录，内部按三阶段组织：
`phase1 需求分析` → `phase2 需求设计` → `phase3 开发计划`。

当 issue 或维护者明确要求“一 issue 一份文档”时，使用
`issue-<number>-<slug>.md`，在同一文件内组织需求、设计与验收；该明确格式要求优先于默认
三阶段目录模板。

> 说明：设计文档**只描述设计意图，不记录实现进度**。「是否实现」这类执行状态统一在本清单跟踪。
>
> **Agent RAS** 相关设计见 [`docs/agent-ras/`](../agent-ras/README.md)（本表 RAS 行链接指向该处 designs/features 或 guides）；使用指南见 [`docs/agent-ras/guides/`](../agent-ras/guides/)。
> 少数早期以 spike 形式记录的需求(如 jiuwenswarm-tracing、langfuse-style-trace-search)不按三阶段拆分,
> 而是 `design.md` + `assets/` + 可选的 `index.html`(给人读的渲染版)。它们原先放在已废弃的 `docs/designs/`
> 目录下,现已并入本目录统一索引。

## 清单

| 需求名称 | 设计入口 | 需求描述 | 类型 | 创建时间 | 是否实现 | 对应 issue |
|-|-|-|-|-|-|-|
| 自定义评估器数据集输入变量 | [custom-evaluator-dataset-input](custom-evaluator-dataset-input/) | 新增 `dataset_input` Judge 变量与确定性数据集匹配门控，保存实验数据集输入快照，并统一“预期输出”展示术语 | Feature | 2026-08-27 | 🟡 代码与自动化验证完成，待浏览器验收 | —（待补） |
| IDaaS OAuth 登录 | [idaas-oauth-login](idaas-oauth-login/) | 新增与历史组织集成完全隔离的 OAuth 2.0 授权码登录，以 IDaaS UUID 映射本地用户，保护 callback 凭据并保留通用退出入口 | Feature | 2026-08-27 | 🟡 代码与专项测试完成，待浏览器验收 | —（待补） |
| DeepSeek Harness 观测接入 | [deepseek-harness-observability](deepseek-harness-observability/) | 复用 Harness 官方 Session Telemetry，以 Agent Insight 插件完成认证、脱敏和截断，并通过专用 OTLP Logs spool/adapter 生成 Trace、Tool、Skill 与子 Session 观测数据 | Feature | 2026-08-21 | 🟡 实现中 | —（待补） |
| Pi Agent Trace 采集器 | [issue-158-pi-agent-trace-collector.md](issue-158-pi-agent-trace-collector.md) | 通过 Pi Extension API、结构化 SubAgent 结果和 durable JSONL spool 采集 Agent/SubAgent/Skill/Tool/LLM/MCP Trace，并由专用 Adapter 转换为 ExecutionRecord | Feature | 2026-07-27 | ✅ 已实现并验证 | [openeuler/opensource-intern#158](https://atomgit.com/openeuler/opensource-intern/issues/158) |
| Codex CLI 与 IDE Trace 采集器 | [issue-159-codex-trace-collectors.md](issue-159-codex-trace-collectors.md) | 通过 Codex lifecycle Hooks 与原生 OTel 双通道采集 CLI/IDE Agent Trace，以本地 relay 合并 Token、Tool、SubAgent 和编辑器事件，并由专用 Adapter 转换为 ExecutionRecord | Feature | 2026-07-27 | ✅ 已实现并验证 | [openeuler/opensource-intern#159](https://atomgit.com/openeuler/opensource-intern/issues/159) |
| Hermes 平台适配（OTel/OTLP 接入） | [hermes-otel-adapter](hermes-otel-adapter/) | 让运行在 hermes 平台的 Agent 通过标准 OpenTelemetry(OTLP)协议把链路数据上报到 agent-insight,被解析、按会话归并、标记 `framework=hermes` 并在观测看板呈现;子 Agent 与 skill 对齐 opencode 成为一等公民(可评测/注册/A-B) | Feature | 2026-06-02 | 🟨 MVP 实现中（仓库内置轻量插件、OTLP JSON 高保真采集与 subagent 关联开发中；原生事件上报作为备用方案） | —（待补） |
| Framework 适配器注册表 | [framework-adapter-registry](framework-adapter-registry/) | 把散落在数十处的「按框架走分支」收进统一的 `FrameworkAdapter` 注册表;第一刀治理三块:skill 抽取重复(4~5 份拷贝)、claude 入库归一化(5 个调用点)、框架名值域不统一(`claude`/`claudecode`) | Refactor | 2026-06-04 | 🟡 实现中（注册表骨架已落地,旧调用点切换与验证待开发） | —（待补） |
| AgentDebug 与 Skills 分析并行化 | [agentdebug-parallel-skills-analysis](agentdebug-parallel-skills-analysis/) | 将 AgentDebug 主诊断与 Skills 步骤核验拆成独立存储和独立轮询链路,支持点击诊断后并行运行、先完成先展示;不兼容旧 `reportJson.skillsAnalysis` 数据 | Feature | 2026-06-05 | ✅ 已实现 | —（待补） |
| Claude Code OTel 工具输出采集补全 | [claude-code-otel-tool-output-followup](claude-code-otel-tool-output-followup/) | 记录 Claude Code 官方 OTel logs 中 `tool_result` 只有 metadata、raw API body file 模式未产出 `body_ref`、本地 transcript 有工具输出但平台 trace 仍缺 output 的遗留问题;后续需在 OTel traces、raw body file 模式或 Claude native JSONL 补充源之间选定稳定方案 | Bugfix | 2026-06-10 | ⬜ 未实现（遗留问题已记录,待后续开发） | —（待补） |
| 质量监控结果维度评测 | [quality-monitoring](quality-monitoring/) | 对 Agent 最终交付按忠实度、指令遵循、答案质量、准确性四项异步评测，持久化证据并为质量报告、趋势和执行记录提供统一分数 | Feature | 2026-06-23 | 🟡 实现中（代码与自动化验证已完成，浏览器验收待确认） | —（待补） |
| 内置 Agent 评估器套件 | [build-in-evaluators](build-in-evaluators/) | 新增回答深度性、轨迹工具利用率和 Agent 工具选择合理性评估，并建立 case 级 Tool/Skill 目录契约 | Feature | 2026-07-27 | 🟡 实现中（代码与自动化验证已完成，浏览器验收待确认） | [#163](https://gitcode.com/openeuler/opensource-intern/issues/163) |
| 标签化版本管理与版本分析 | [tag-based-version-management](tag-based-version-management/) | 通过系统标签、版本标签、业务标签三类标签重构版本管理、链路追踪打标/筛选与版本分析；版本分析只做已有 Trace 指标汇总，不做模型分析 | Feature | 2026-07-06 | 🟡 MVP implemented; browser validation pending | —（待补） |
| Trace 回流到评测数据集 | [trace-to-dataset-backflow](trace-to-dataset-backflow/) | 支持 Trace 单条/批量回流到评测数据集、数据集新增自定义字段，以及逐条编辑样本字段值；input/output 使用评测执行已有逻辑处理后写入 | Feature | 2026-07-15 | 🟡 实现中（代码与目标测试已完成，浏览器验收待确认） | —（待补） |
| 评测数据集加载性能优化 | [agent-dataset-loading-performance](agent-dataset-loading-performance/) | 为评测数据集增加样本数与参考答案轻量投影，列表和实验导入不再传输完整轨迹，并在数据库层按用户过滤 | Performance | 2026-08-04 | 🟡 实现中 | —（待补） |
| 通用实验 Trace 生成 | [generic-experiment-trace-generation](generic-experiment-trace-generation/) | 新建实验可选择任意评测数据集，以 Case input 驱动 Agent 生成 Trace；普通数据走客户端通用执行，可靠性数据保留 FI，再统一进入评估 | Feature | 2026-08-15 | ✅ 已实现（定向测试） | —（待补） |
| Skill 对话工作台重构 | [skill-workbench-refactor](skill-workbench-refactor/) | 将 Skill 生成、上传、静态评估、三类统一实验、候选优化、原实验复测与确认发布收敛到共享工作版本和会话上下文，并保留旧入口与 API 兼容 | Refactor / Feature | 2026-08-19 | 🟡 代码与专项测试完成，待浏览器验收 | —（待补） |
| Openclaw 平台适配 | [openclaw-adapter](openclaw-adapter/) | (待补充:定义 Openclaw 平台的接入适配设计,包括链路数据上报、解析及面板呈现等) | Feature | 2026-06-17 | ⬜ 未实现（设计起草中） | —（待补） |
| Trace Bundle 导入导出 | [trace-bundle-import-export](trace-bundle-import-export/) | 将链路追踪详情导出的 Trace 作为版本化 Bundle 重新导入平台，保留无冲突 ID，并完整恢复多 Agent 父子树 | Feature | 2026-07-15 | 🟡 实现中（代码与自动化验证已完成，浏览器验收待确认） | —（待补） |
| Langfuse Trace 完整展示 | [langfuse-trace-fidelity](langfuse-trace-fidelity/) | 为 Langfuse OTLP 增加独立完整节点快照，保留业务 CHAIN/AGENT/TOOL 与真实时序，同时保持其他框架和现有 interactions 行为不变 | Bugfix | 2026-07-21 | 🟡 代码与自动化验证已完成，浏览器验收待确认 | —（待补） |
| 安全与创意预置评估器 | [build-in-evaluators](build-in-evaluators/) | 新增不敏感性、争议性、性别歧视性、创造性 4 个 LLM Judge 预置评估器，专项检测 Agent 输出文本的安全风险与创意质量 | Feature | 2026-07-26 | 🟡 代码与自动化验证已完成，浏览器验收待确认 | [#160](https://gitcode.com/openeuler/opensource-intern/issues/160) |
| JiuwenSwarm 接入追踪（OTEL seam） | [jiuwenswarm-tracing](jiuwenswarm-tracing/) | 把 agent-insight 接入 openJiuwen / JiuwenSwarm，通过 OTEL seam 端到端追踪一次执行；含持久化 span spool 与 token 归属边界记录 | Feature | 2026-06-13 | ✅ 已验证（spike 结论已落地，见 design.md status: validated） | —（待补） |
| 链路追踪搜索/过滤改造（langfuse operator 模型） | [langfuse-style-trace-search](langfuse-style-trace-search/) | `/trace` 列表的搜索与过滤对齐 langfuse 的 operator 模型（搜索栏 + 左侧 facet 侧栏） | Feature | 2026-06-15 | 🟡 实现中（front-half 已落地：搜索栏 + facet 侧栏 + skill 接线） | —（待补） |
| agent_ras 环内 runtime | [`../agent-ras/designs/architecture.md`](../agent-ras/designs/architecture.md) | 仓根 `agent_ras/` 同进程检测与恢复；旁路经 **`/api/ingest/ras-events`**（见 developer-guide） | Feature | 2026-07-25 | ✅ inproc 已实现 | 安装器 + 可靠性链路 + ingest API |
| AgentRAS 可靠性独立页面 | [reliability-standalone-ui](reliability-standalone-ui/) | 独立导航「AgentRAS 可靠性」；可靠性追踪 + 故障模式 + 故障注入与评测（已接真实 BFF；UI 含 RasAnomalyStrip） | Feature | 2026-07-28 | ✅ 已实现 | —（待补） |
| 工具重复死循环检测与恢复 | [`../agent-ras/designs/features/repeat-tool.md`](../agent-ras/designs/features/repeat-tool.md) | 同参重复 / 失败连打 / ping-pong / 全局断路；steering + notice | Feature | 2026-08-13 | ✅ 已实现 | — |
| LLM 思考死循环检测与恢复 | [`../agent-ras/designs/features/thinking-loop.md`](../agent-ras/designs/features/thinking-loop.md) | L1/L2 字面 + L3 语义 + review skill；流中 abort | Feature | 2026-07-15 | ✅ 已实现 | — |
| Stream Abort 停流 | [`../agent-ras/designs/features/stream-abort.md`](../agent-ras/designs/features/stream-abort.md) | 环内打断 `llm.stream`；依赖宿主 abort 契约 | Feature | 2026-07-15 | ✅ 已实现 | — |
| Provider 断连停推理调研 | [`../agent-ras/designs/features/provider-disconnect.md`](../agent-ras/designs/features/provider-disconnect.md) | Provider 断连能力调研 | Spike | 2026-07-20 | ✅ 调研完成 | — |
| Agent RAS 可靠性检测恢复评估器门控 | [`../agent-ras/designs/features/ras-reliability-evaluator-split.md`](../agent-ras/designs/features/ras-reliability-evaluator-split.md) | 新实验移除故障注入评估器；检测恢复评估器仅在确认故障发生后评分，未确认时输出无分理由 | Refactor / Feature | 2026-08-15 | 🟡 代码与自动化验证已完成，浏览器验收待确认 | —（待补） |
| 仪表盘可靠性与性能拆分 | [`../agent-ras/designs/features/dashboard-reliability-performance.md`](../agent-ras/designs/features/dashboard-reliability-performance.md) | 将原可靠性与性能页签拆开，基于根 Trace 与 RAS 事件展示故障恢复、级别和 Agent 可靠性，并保留执行失败补充 | Feature | 2026-08-20 | 🟢 开发完成，待 UI 验收 | —（待补） |
| LLM 过度思考（Analysis Paralysis）二阶段检测 | [`../agent-ras/designs/features/analysis-paralysis.md`](../agent-ras/designs/features/analysis-paralysis.md) | 触发词 Stage1 + LLM 语义 Stage2；复用 L3 Skill 通道 | Feature | 2026-07-29 | ⬜ 未实现（规划中） | —（待补） |
| LLM Agent 规划错误（Planning Error）检测 | [`../agent-ras/designs/features/planning-error.md`](../agent-ras/designs/features/planning-error.md) | 策略层规划错误；按信息完备度分层检测与恢复 | Feature | 2026-07-30 | ⬜ 未实现（规划中） | —（待补） |
| LLM Agent 领域认知偏差（Domain Cognitive Bias） | [`../agent-fault-injection/designs/features/domain-cognitive-bias.md`](../agent-fault-injection/designs/features/domain-cognitive-bias.md) | 六类信念层故障；认知层三角覆盖；FI 剧本 + RAS 检测规划 | Research / Feature | 2026-07-30 | ⬜ 未实现（规划中） | —（待补） |
| RAS 能力配置（目录解耦 + 多平台同步） | [`../agent-ras/designs/features/capability-config.md`](../agent-ras/designs/features/capability-config.md) | Insight 目录/表单消费 PLUGIN presentation + catalog API；按 AgentRASConfig 粒度多平台配置，可选同步到 OpenCode/xiaoO 客户端；`agent_ras_config.default.yaml` | Feature+Refactor | 2026-08-12 | ✅ 已实现（API/同步/浏览器验收通过） | —（待补） |
| Agent RAS 可靠性闭环（服务端与客户端交互） | [`../agent-ras/designs/features/Agent RAS 可靠性闭环-服务端与客户端交互设计.md`](../agent-ras/designs/features/Agent%20RAS%20可靠性闭环-服务端与客户端交互设计.md) | 常驻客户端 + configRef 控制面；Trace 异常维度；可靠性数据集/评估器闭环；能力默认关闭 | Feature | 2026-08-11 | 🟡 部分落地（评测集 reliability / IF-N16 / FI 外挂编排 / Trace anomaly；ExperimentCase FI 独立列） | 集成分支 `codex/reliability-ras-fi-integrate` |
| 客户端控制面（安装、保活、配置下发） | [`../agent-ras/designs/features/reliability-client-control-plane.md`](../agent-ras/designs/features/reliability-client-control-plane.md) | 统一安装、systemd/launchd 保活、Prisma 配置下发、WSS/长轮询双向通信；新客户端吸收 FI Worker | Feature | 2026-08-13 | 🟡 开发中（已合入可靠性开发分支） | — |
| OpenCode / xiaoO 平台接入 | [`../agent-ras/designs/features/opencode-xiaoo-integration.md`](../agent-ras/designs/features/opencode-xiaoo-integration.md) | 共享 inproc 骨架；OpenCode libpython + L3 Judge；xiaoO Daemon SSE + Insight xiaoO-trace-collector（⓪ Trace）；FI 边界 | Feature / Docs | 2026-08-13 | 🟢 已落地 | — |
| RAS ingest 契约收紧 | [`../developer-guide/09-otlp-attribute-contract.md`](../developer-guide/09-otlp-attribute-contract.md) | flat+必填 deliveryId+浅路径；见 developer-guide RAS 旁路 | Refactor | 2026-07-31 | ✅ 已实现 | —（待补） |
| Agent Fault Injection 合并 | [`../agent-fault-injection/`](../agent-fault-injection/README.md) | 仓根 `agent_fault_injection/` **实现模块**；Insight 侧 Task/BFF/Judge/UI；关系见 [ras-fi-insight-relationship](../agent-fault-injection/designs/modules/ras-fi-insight-relationship.md) | Feature | 2026-08-04 | ✅ 已实现（UI 对齐 + opencode/xiaoo 真跑 collect） | —（待补） |
| Insight · RAS · FI 关系说明 | [`../agent-fault-injection/designs/modules/ras-fi-insight-relationship.md`](../agent-fault-injection/designs/modules/ras-fi-insight-relationship.md) | 平台 vs 实现模块边界；部署与四条上报通道；前端/DB 归 Insight | Docs | 2026-08-05 | ✅ 文档已落地 | — |
| RAS 本机安装过程说明 | [`../agent-ras/guides/local-install-process.md`](../agent-ras/guides/local-install-process.md) | curl/`install-ras` 本机逐步：tarball、目录树、预检、排障 | Docs | 2026-08-12 | ✅ 文档已落地 | — |
| FI 本机安装过程说明 | [`../agent-fault-injection/guides/local-install-process.md`](../agent-fault-injection/guides/local-install-process.md) | curl `/api/fault-injection/setup` 本机逐步：Worker、config、数据源 | Docs | 2026-08-12 | ✅ 文档已落地 | — |
| FI 服务端/客户端分离 | [fi-server-client-split](fi-server-client-split/)（**HISTORICAL SDD**；现网见 [server-client-split.md](../agent-fault-injection/designs/features/server-client-split.md)） | 任务下发与展示留服务端；注入编排与能力在本机 FI Worker；curl/`install-fault-injection` 安装对齐 agent-ras | Refactor | 2026-08-05 | ✅ 已实现（浏览器 E2E：Worker claim + collect-result） | — |
| FI 死字段清理 | [fi-dead-field-cleanup](fi-dead-field-cleanup/) | 删除 `FaultInjectionRun.injectionEvidenceJson` / `artifactDir`；collect 协议已不含 injectionEvidence | Refactor | 2026-08-10 | ✅ 已实现 | — |
| 记忆故障 FI 方案（文件丢失等） | [`../agent-fault-injection/designs/features/memory-file-loss.md`](../agent-fault-injection/designs/features/memory-file-loss.md) | 记忆丢失/损坏/投毒注入方案；FI-P0=`memory-file-loss` 已落地 | Feature | 2026-08-03 | 🟡 FI-P0 已落地；检测器与其余子类规划中 | — |
| 记忆噪声干扰 FI | [`../agent-fault-injection/designs/features/memory-noise-interference.md`](../agent-fault-injection/designs/features/memory-noise-interference.md) | Skill S1–S3 + middleware S4（假先验）已落地；S5 压缩失真未实施 | Feature | 2026-08-03 | ✅ S1–S4 已落地 | — |
| 思考死循环 FI | [`../agent-fault-injection/designs/features/thinking-dead-loop.md`](../agent-fault-injection/designs/features/thinking-dead-loop.md) | Skill 三场景强制复读；与 RAS 思考检测、分析瘫痪划界 | Feature | 2026-08-13 | ✅ Skill 已落地 | — |
| 工具重复死循环 FI | [`../agent-fault-injection/designs/features/tool-repeat-dead-loop.md`](../agent-fault-injection/designs/features/tool-repeat-dead-loop.md) | Skill 四场景串行连打；与 RAS 工具重复域对齐 | Feature | 2026-08-13 | ✅ Skill 已落地 | — |
| Agent RAS 故障域插件化（detectors/review/recovery） | [`../agent-ras/designs/features/fault-domain-plugins.md`](../agent-ras/designs/features/fault-domain-plugins.md) | P0–P3 ✅：三平级 PLUGIN；共同文件只留 yaml | Refactor / Feature | 2026-08-06 | ✅ 已实现 | — |
| FI 证据边界与 inconclusive 语义 | [`../agent-fault-injection/designs/features/server-client-split.md`](../agent-fault-injection/designs/features/server-client-split.md) | 注入工具不写自证快照；Judge 以轨迹为主；`no_trace`→`inconclusive` | Refactor | 2026-08-05 | ✅ 已实现 | — |
| FI 故障模式自包含插件化 | [`../agent-fault-injection/designs/features/fault-mode-plugins.md`](../agent-fault-injection/designs/features/fault-mode-plugins.md) | 五类 injection_method；plan/副作用分层；metadata + capability；配方契约 | Refactor | 2026-08-10 | ✅ 已实现 | — |
| LlamaIndex Trace 采集器 | [llamaindex-trace-collector](llamaindex-trace-collector/) | 从 LlamaIndex Dispatcher 获取原始调用信息，由 Agent Insight 自定义 Handler 继承官方 `llama-index-observability-otel` Handler 基类并补充 Agent、子 Agent、Tool、LLM、RAG 与 Workflow 语义，以可靠本地 spool 异步上传至现有 OTLP 接口，并提供服务端直接部署、配置和隔离清理能力 | Feature | 2026-08-03 | 🟢 已实现，待扩展 CI/长期 soak | —（待补） |

## 字段口径

- **创建时间**:取该需求首次起草日期。
- **是否实现**取值:
  - ⬜ **未实现** —— 仅有设计,代码未动
  - 🟡 **实现中** —— 部分落地
  - ✅ **已实现** —— 全部落地并通过验收
- **对应 issue**:关联的跟踪 issue/工单链接;暂无则填「待补」。

## 新增需求时的约定

1. 默认在本目录下新建一个**短横线命名**的子目录(如 `xxx-yyy`)。
2. 默认在子目录内放 `phase1-requirements-analysis.md` / `phase2-requirements-design.md` / `phase3-development-plan.md`。
3. issue 或维护者明确要求单文档时，改用 `issue-<number>-<slug>.md`，不再创建三阶段目录。
4. **回到本清单追加一行**,填齐上表各列。
