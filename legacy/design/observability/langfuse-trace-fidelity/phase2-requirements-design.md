# Phase 2：Langfuse Trace 完整展示需求设计

## 数据模型

在 `Session` 增加可空文本列 `langfuseTraceNodes`，内容为 `LangfuseTraceNode[]` JSON。只有 Langfuse adapter 产生和写入该字段；历史数据及非 Langfuse Session 保持 `null`。

节点保留原始 `spanId`、`sourceParentSpanId`，同时计算 UI 使用的 `displayParentSpanId`。节点包含 kind、name、时间、input/output、status、model/usage、visibility、collapseReason 和工具关联信息。

## 写入链路

`normalizeLangfuseOtlpTraces` 继续输出完整 `OtelTraceEvent[]`。`langfuse-langgraph` adapter 在保留现有 interactions 投影的同时，遍历所有事件生成 `langfuseTraceNodes`。`saveExecutionRecord` 仅在 Langfuse framework 下按 `spanId` 保存当前完整快照。

## 展示链路

Session API 增加可选 `langfuseTraceNodes`。Trace 页面和 TraceDrawer 在该字段存在时传给 `AgentTraceView`；组件使用 Langfuse 专用建树函数，否则回退现有 `buildAgentCallTree(interactions)`。

默认可见：LLM、TOOL、AGENT、业务 CHAIN、错误节点和包含独立业务内容的节点。`LangGraph`、`model`、`tools`、`RetrievalSession.as_tools` 等包装节点可默认折叠，但仍保存在事实层并可通过原始父子关系还原。

业务 CHAIN 在原 `AgentTraceView` 中使用独立 CHAIN 类型，并通过 `sourceSpanId` / `parentSourceSpanId` 保留折叠后的可见层级。折叠包装层只提升其子节点，不把所有 observation 压平到最近 Agent。`f7` 中 `knowledge_retrieve` 必须包含 `RetrievalSession.retrieve_async` 与 `RetrievalSession.make_short_chunk`；`88` 中 `query_agent` 与 `qa_agent` 必须为同级分支，`answer_composer` 必须留在主链。

## 兼容性

- `interactions` 契约不变。
- Session API 新字段可选。
- 非 Langfuse 写入不更新 `langfuseTraceNodes`。
- 历史 Langfuse Session 没有新字段时沿用原 UI。
- SQLite 与 OpenGauss 均增加可空文本列。
