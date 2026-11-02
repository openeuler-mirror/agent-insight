# Phase2：需求设计 — drop 废列

## 数据模型变更

`FaultInjectionRun`：

- 删除 `injectionEvidenceJson String?`
- 删除 `artifactDir String?`

其余 FI Run 字段不变。API `CollectPayload` 已无 `injectionEvidence`（Phase1）。

## 回滚

从 git 恢复 schema 字段后 `db push`；无需数据回填。
