# 需求清单（agent-insight 设计文档索引）

本目录收录 agent-insight 的所有需求设计。**每个需求一个子目录**,内部按三阶段组织:
`phase1 需求分析` → `phase2 需求设计` → `phase3 开发计划`。

> 说明:子目录里的设计文档**只描述设计意图,不记录实现进度**。「是否实现」这类执行状态统一在本清单跟踪。

## 清单

| 需求名称 | 目录 | 需求描述 | 类型 | 创建时间 | 是否实现 | 对应 issue |
|-|-|-|-|-|-|-|
| Hermes 平台适配（OTel/OTLP 接入） | [hermes-otel-adapter](hermes-otel-adapter/) | 让运行在 hermes 平台的 Agent 通过标准 OpenTelemetry(OTLP)协议把链路数据上报到 agent-insight,被解析、按会话归并、标记 `framework=hermes` 并在观测看板呈现;子 Agent 与 skill 对齐 opencode 成为一等公民(可评测/注册/A-B) | Feature | 2026-06-02 | ⬜ 未实现（设计完成,待开发） | —（待补） |
| Framework 适配器注册表 | [framework-adapter-registry](framework-adapter-registry/) | 把散落在数十处的「按框架走分支」收进统一的 `FrameworkAdapter` 注册表;第一刀治理三块:skill 抽取重复(4~5 份拷贝)、claude 入库归一化(5 个调用点)、框架名值域不统一(`claude`/`claudecode`) | Refactor | 2026-06-04 | 🟡 实现中（注册表骨架已落地,旧调用点切换与验证待开发） | —（待补） |

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
