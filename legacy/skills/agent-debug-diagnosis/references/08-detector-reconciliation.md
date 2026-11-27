# 专项诊断结果查重与关联协议

该阶段发生在同一次 AgentDebug Skill 执行中，主诊断已经写入 `.agent-insight/agent-debug-core.json`，专项原始结果已经写入 `.agent-insight/agent-debug-detectors.json`。当前 Agent 直接生成完整最终报告，不返回中间决策，也不等待服务端二次调用。

## 通用富化

由当前 Agent 基于原始 `facts`、`anchors`、`details` 和必要的 trace 样本补充 `summary`、`mechanism`、`faultChain`、`correctionGuidance`。这不是独立模型或服务端富化器。不得改变计数、区间、比例、锚点和其他结构化事实，不得新增无证据原因。

## 重复判定

只有同时满足以下条件，专项结果才能合入某条 core finding：

1. 故障对象相同；
2. 故障机制相同；
3. 主要证据范围相同；
4. 修复方向相同。

仅存在触发、前后因果或上下游关系不算重复。修复方向不同必须保留为独立发现，可以使用 `relatedFindingId` 记录关联。

## 直接写入最终报告

- `merge` 不再作为中间 JSON 输出。判断为重复时，保留原 core finding，并把专项结果写入其 `supplementalEvidence`。
- `supplementalEvidence` 必须包含富化后的说明，以及从原始结果无损复制的 `facts`、`anchors`、`details`；不得包含 `detector` 来源字段。
- 判断为独立时，把结果写入顶层 `detectorFindings`；若与某条 core finding 相关，可填写有效的 `relatedFindingId`。
- 每条原始专项 finding 必须恰好被独立保留或合入一次。
- 冻结 core finding 的 `id`、`summary`、`evidence`、`issueRefs` 和 `correctionGuidance` 不得改写。

最终必须使用 `agentdebug_validate.py --core ... --detectors ...` 校验上述约束。
