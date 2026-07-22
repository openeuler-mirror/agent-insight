# 一键诊断流程

一键诊断运行现有 AgentDebug 五模块流程，同时接收服务端通用运行时已经执行和富化的专项诊断结果。

完成 Phase 2 后，对 `findings` 与专项结果做语义查重和关联：

- 若是同一个问题，将专项结果中有效的事实和证据并入对应 AgentDebug finding，并从 `detectorFindings` 删除该专项结果；合并后的用户可见内容不保留专项来源。
- 若不是同一个问题但存在因果关系，在 finding 的 evidence 或修复建议中建立关联。
- 只有不重复且具有独立诊断价值的结果才写入 `detectorFindings`。
- 不得改写专项结果里的确定性计数、区间、比例和证据锚点。

这里不增加新的结果编排 Agent；查重和关联是现有 AgentDebug Phase 2 的最后一步。
