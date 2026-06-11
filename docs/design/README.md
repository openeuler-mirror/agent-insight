# 需求清单（agent-insight 设计文档索引）

本目录收录 agent-insight 的所有需求设计。**每个需求一个子目录**,内部按三阶段组织:
`phase1 需求分析` → `phase2 需求设计` → `phase3 开发计划`。

> 说明:子目录里的设计文档**只描述设计意图,不记录实现进度**。「是否实现」这类执行状态统一在本清单跟踪。

## 清单

| 需求名称 | 目录 | 需求描述 | 类型 | 创建时间 | 是否实现 | 对应 issue |
|-|-|-|-|-|-|-|
| Hermes 平台适配（OTel/OTLP 接入） | [hermes-otel-adapter](hermes-otel-adapter/) | 让运行在 hermes 平台的 Agent 通过标准 OpenTelemetry(OTLP)协议把链路数据上报到 agent-insight,被解析、按会话归并、标记 `framework=hermes` 并在观测看板呈现;子 Agent 与 skill 对齐 opencode 成为一等公民(可评测/注册/A-B) | Feature | 2026-06-02 | 🟨 MVP 实现中（OTLP protobuf 接收与 Hermes 基础聚合已完成;trace-tree/subagent follow-up 已补文档） | —（待补） |
| Framework 适配器注册表 | [framework-adapter-registry](framework-adapter-registry/) | 把散落在数十处的「按框架走分支」收进统一的 `FrameworkAdapter` 注册表;第一刀治理三块:skill 抽取重复(4~5 份拷贝)、claude 入库归一化(5 个调用点)、框架名值域不统一(`claude`/`claudecode`) | Refactor | 2026-06-04 | 🟡 实现中（注册表骨架已落地,旧调用点切换与验证待开发） | —（待补） |
| AgentDebug 与 Skills 分析并行化 | [agentdebug-parallel-skills-analysis](agentdebug-parallel-skills-analysis/) | 将 AgentDebug 主诊断与 Skills 步骤核验拆成独立存储和独立轮询链路,支持点击诊断后并行运行、先完成先展示;不兼容旧 `reportJson.skillsAnalysis` 数据 | Feature | 2026-06-05 | ✅ 已实现 | —（待补） |
| Claude Code OTel 工具输出采集补全 | [claude-code-otel-tool-output-followup](claude-code-otel-tool-output-followup/) | 记录 Claude Code 官方 OTel logs 中 `tool_result` 只有 metadata、raw API body file 模式未产出 `body_ref`、本地 transcript 有工具输出但平台 trace 仍缺 output 的遗留问题;后续需在 OTel traces、raw body file 模式或 Claude native JSONL 补充源之间选定稳定方案 | Bugfix | 2026-06-10 | ⬜ 未实现（遗留问题已记录,待后续开发） | —（待补） |

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
