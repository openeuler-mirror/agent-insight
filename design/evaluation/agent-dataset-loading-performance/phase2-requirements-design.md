# Phase 2：需求设计

## 数据模型

在 `AgentEvalDataset` 增加：

- `caseCount Int @default(0)`：数据集样本数。
- `referenceCasesJson String @default("[]")`：仅保存评测选择所需的
  `{ id, input, expectedOutput, evaluationFocus, tags }[]`，不保存轨迹和自定义大字段。
- `projectionReady Boolean @default(false)`：区分尚未回填与合法空数据集。

所有写路径从规范化后的 `cases` 统一构造三个持久化字段，避免调用方分别维护。

## 读取契约

`GET /api/agent-datasets` 增加 `view`：

- `view=summary`：返回元数据、fields、`caseCount`，不返回 `cases`。
- `view=reference`：返回元数据和轻量 `cases`，cases 仅含
  `id/input/expectedOutput/evaluationFocus/tags`。
- 未传 `view`：保留完整响应，兼容旧调用方。

单数据集 `GET /api/agent-datasets/:id?view=items` 返回完整元数据和数据项，但将
`trajectory/trace` 限制为每条 600 字符的前缀预览；数据项页首屏使用该视图。点击轨迹单元格、编辑、删除和批量导入前再读取完整记录，
并以完整 cases 为基础写回，避免轻量视图覆盖原轨迹。

`GET /api/agent-datasets/:id?view=case&caseId=:caseId` 仅返回指定完整 case。点击轨迹或编辑时使用该视图，
避免为了查看一条轨迹传输整个数据集；集合级写操作仍读取完整记录后写回。

`summary/reference` 均直接使用 Prisma `where: { user, targetSkill? }`，不得调用 `readAllAgentDatasets()` 后过滤。

## 历史回填

首次读取某用户的轻量视图前，查询该用户 `projectionReady=false` 的记录，解析其 `casesJson`，批量写入投影。回填幂等；空数据集也会标记 ready。回填失败时接口返回错误，不把不完整投影伪装成有效结果。
回填必须显式保留记录原有的 `updatedAt`，避免只读列表操作改变业务更新时间和排序。

先在本机数据库副本执行增量迁移和回填，核对所有原表行数及原始
`casesJson` 校验值不变。远端部署前备份 3000 正在使用的数据库，再对同一数据库执行仅新增列的迁移；
不停止 3000 服务，不删除或重写原始数据。

## 兼容与回滚

- 完整详情响应不变。
- 旧客户端未使用 `view` 时行为不变。
- 回滚代码时新增列可保留，不影响旧版本读取。
- 不执行删列或重建表，不使用 `--accept-data-loss`。

## 风险控制

- 投影一致性：集中封装 `buildAgentDatasetProjection()`，所有创建和更新路径复用。
- 并发首次回填：重复计算结果确定且 update 幂等。
- OpenGauss/SQLite：只使用 Prisma 标准查询与更新，不依赖数据库 JSON 函数。
