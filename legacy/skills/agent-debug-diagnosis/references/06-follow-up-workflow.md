# 普通追问流程

用户问题未命中任何 `detectors/*/detector.json` 的症状关键词时，保持现有诊断追问行为：基于执行记录、已有 AgentDebug 报告、历史对话和 trace 资料包直接回答。

普通追问不运行 AgentDebug 五模块，也不调用专项诊断器。
