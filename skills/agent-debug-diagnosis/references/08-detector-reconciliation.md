# 专项诊断结果查重与关联协议

该阶段发生在 AgentDebug 主诊断已经完成之后。输入中的 `coreFindings` 是冻结结果；不得因为看到专项诊断结果而删除、吞并或重建机制和修复方向不同的 core finding。

## 重复判定

只有同时满足以下条件，专项结果才能合入某条 core finding：

1. 故障对象相同；
2. 故障机制相同；
3. 主要证据范围相同；
4. 修复方向相同。

仅存在触发、前后因果或上下游关系不算重复。修复方向不同必须保留为独立发现，可以使用 `relatedFindingId` 记录关联。

## 决策输出

本阶段只输出决策，不重新输出完整报告：

```json
{
  "decisions": [
    {
      "detectorFindingId": "trajectory-5-15",
      "action": "merge",
      "targetFindingId": "finding-repeat-loop",
      "reason": "故障对象、机制、证据范围和修复方向均相同",
      "patch": {
        "severity": "high",
        "impact": "quality_degrading",
        "confidence": 0.84
      }
    }
  ]
}
```

`action` 只能是：

- `merge`：与某条 core finding 重复，`targetFindingId` 必填。
- `independent`：不重复，保留为独立发现；若只有因果关联，可填写 `relatedFindingId`。

`patch` 只能建议提升严重度、影响和置信度，不得改写冻结 core finding 的标题、证据和修复建议。计数、区间、比例、锚点、诊断器名称等字段不得进入 patch；它们由通用代码从原始专项结果无损应用。
