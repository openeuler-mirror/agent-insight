# Phase 1：Langfuse Trace 完整展示需求分析

## 问题

Agent Insight 当前把 Langfuse OTLP observation 投影为 `Session.interactions`。真实 fixture `f706ac20fcf3e8fbe0fc3ecbe71c8c1e` 含 19 个唯一 span，标准化阶段完整得到 19 个事件，但 adapter 仅生成 6 个 interactions，通用 Agent Trace 最终只显示根 Agent 与 `qa_agent` 两个节点。业务 CHAIN、独立 TOOL 和完整时序因此不可见。

## 范围

- 仅处理 `framework=langfuse` 或 `framework=langfuse-langgraph` 的 OTLP Trace。
- 保留现有 `interactions`，不改变评估、诊断和 Skill 归因口径。
- 新增 Langfuse 专用完整节点快照，供 Trace 页面展示。
- 支持折叠 LangGraph 包装节点，但任何节点都不能从事实层删除。
- 非 Langfuse adapter、Session 和 UI 路径行为保持不变。

## 验收基线

- fixture：4 个 protobuf 批次、19 个唯一 span。
- 类型分布：14 CHAIN、3 LLM、1 TOOL、1 AGENT。
- `summarizer` 虽为 0ms，但有独立 input/output，必须可见。
- `knowledge_retrieve` 的对象型 output 必须保留并与对应 LLM tool call 关联。
- Root、`qa_agent`、`knowledge_retrieve` 分别保留约 88.065s、82.663s、49.544s 的真实时间。

## 非目标

- 不把 Langfuse 节点模型推广为所有框架的统一模型。
- 不改变现有 OTel consumer spool 和 retention 策略。
- 不修改通用 `buildAgentCallTree()` 或其他框架的计时、工具匹配逻辑。
