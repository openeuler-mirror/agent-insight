# Trace Bundle 导入导出：需求设计

## 数据契约

V1 Bundle 顶层字段：

- `format`: 固定为 `agent-insight.trace-bundle`
- `version`: 固定为 `1`
- `exportedAt`: ISO 时间
- `rootExecutionId`: 根 Execution ID
- `executions`: 节点数组，每项包含 portable Execution 和对应 Session 快照

Portable Execution 只承载 Trace 页面和筛选所需的标量、指标、Agent/Skill 信息及父子字段。Session 承载 query、start/end time、model 和 canonical interactions。评测、诊断、标签、Infra 关联不进入 Bundle。

## 接口

### `GET /api/observe/traces/export`

参数：`executionId`、`user`。服务端校验归属，将子 Agent executionId 归一到 root，并返回完整 Bundle。响应设置 JSON 下载文件名。

### `POST /api/observe/traces/import`

请求：`{ user, fileName, bundle }`。服务端解析当前用户、校验 Bundle、分配冲突 ID、写入 Trace 树，返回包含 `originalRootExecutionId` 与导入后 `rootExecutionId` 的导入摘要。

## ID 映射

所有 `Execution.id` 和非空 taskId 进入统一 identity 集合。对每个原值同时检查：

- 是否已是目标库中的 `Execution.id`
- 是否已是某条 `Execution.taskId`
- 是否已是 `Session.taskId`

任一命中即生成 `import_<uuid>`；否则保留原值。随后更新：

- Bundle `rootExecutionId`
- `Execution.id/parentExecutionId/rootExecutionId`
- `Execution.taskId/agentSessionId`
- `Session.taskId`
- interactions 中已知 Session 引用键及 JSON 形式的工具参数/输出

OTel trace/span 标识不更新。

## 写入和回滚

校验和冲突预检全部在写库前完成。节点按父节点优先排序写入。每个节点创建 Execution 和 Session，再重建 ExecutionSkill。异常时按逆序删除本轮创建的 Execution 和 Session；唯一约束竞争不会覆盖已有记录。

## UI

- 详情页原“保存 trace”改为请求导出接口并下载 Bundle。
- 列表页 `AppTopBar.actions` 放置“导入 Trace”按钮和隐藏 file input。
- 成功后使用 Dialog 展示文件名、原/新 Trace ID、节点数和 ID 重映射数量，不展开完整 ID 重映射明细；失败使用错误 toast，文件 input 清空以允许重选同一文件。

## 限制

- V1 仅接受 JSON，前端限制 50 MiB。
- V1 最多 500 个 Execution 节点。
- 不把导入动作当作实时 ingest，不触发结果评测或 AgentDebug。
