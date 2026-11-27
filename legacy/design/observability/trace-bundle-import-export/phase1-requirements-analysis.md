# Trace Bundle 导入导出：需求分析

## 背景

链路追踪详情页已有“保存 trace”按钮，但当前下载的是展示格式化后的 Session JSON，只包含 `taskId`、查询和 interactions，缺少 Execution 元数据、父子关系与格式版本，无法直接重新导入平台。

## 目标

- 改造现有详情页导出按钮，导出可移植、可版本演进的完整 Trace Bundle。
- 在链路追踪列表页右上角增加“导入 Trace”按钮。
- 单 Agent 和多 Agent 均以 root Trace 树为导入导出单元；从子 Agent 详情导出时仍导出整棵树。
- 导入后 Trace 出现在链路追踪中，父子下钻、Session 加载、指标和 Skill 筛选保持可用。

## 核心规则

1. Bundle 使用 `agent-insight.trace-bundle` + `version=1` 标识格式。
2. 原始 ID 无冲突时保留；目标库中已存在同值时，仅为冲突 ID 生成新值。
3. `Execution.id`、`Execution.taskId` 与 `Session.taskId` 参与冲突检查；父子和 Session 引用按映射同步更新。
4. OTel `traceId`、`spanId`、`parentSpanId`、消息 ID、工具调用 ID 不参与冲突映射。
5. 导入归属取当前用户，不信任文件中的源用户。
6. 不导入评测、智能诊断、Infra 关联和用户标签；不自动触发 LLM 评测。
7. 文件校验失败不得写库；写入中途失败时回滚本轮新建的 Execution 和 Session。

## 用户流程

### 导出

1. 用户进入任意 Trace 详情。
2. 点击现有“保存 trace”。
3. 平台解析 root Execution，导出 root 与全部子 Agent Execution/Session。

### 导入

1. 用户在链路追踪列表页右上角点击“导入 Trace”。
2. 选择 `.json` 文件。
3. 平台校验格式、树结构和 ID，完成冲突映射并写库。
4. 列表刷新，弹窗展示文件名、原 Trace ID、新 Trace ID、节点数和 ID 重映射数，并提供“打开 Trace”；不展开完整 ID 重映射明细。

## 验收标准

- 单 Agent Trace 可往返导入导出。
- 两个并行子 Agent、三层嵌套 Agent 均能恢复父子关系。
- 从子 Agent 详情导出得到完整 root 树。
- 无冲突 ID 原样保留；仅冲突 ID 被替换。
- 重映射后子 Agent页面跳转到导入后的 Session。
- 非法版本、重复节点、缺父节点、循环关系和超限文件不会产生残留记录。
