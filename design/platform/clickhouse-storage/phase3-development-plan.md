# ClickHouse 存储支持开发计划

前置：设计评审确认 [需求分析](phase1-requirements-analysis.md) 的待确认项，尤其是规模前提、分层方案与依赖引入许可。未对齐前不动 Prisma schema、不写运行时代码。

## 阶段 1：后端开关与能力收敛

1. 新增 `DB_TYPE=sqlite|opengauss|clickhouse` 解析与冲突校验（`DB_HOST` + 不一致的 `DB_TYPE` 启动失败），补齐 `.env.example` 的变量名与说明（只写通用名，不写真实地址与凭据）。
2. 新增 `src/lib/storage/backend.ts`，定义后端与能力标志；把 10 个文件里 23 处 `process.env.DB_HOST` 判断改为能力查询，保持现有 SQLite / OpenGauss 行为不变。
3. 未实现的适配方法统一抛 `UnsupportedBackendError`，API 层映射为 501 + 功能名；删除 `prisma.ts` 中「返回 null + 告警」的静默分支。
4. 验收：默认 SQLite 全量回归通过；OpenGauss 契约测试行为不变；新增开关解析与冲突校验的单测。

## 阶段 2：表结构与初始化

1. 按设计编写 `scripts/init_clickhouse.ts`：`executions`、`execution_skills`、`sessions` 三张表的幂等 DDL，含排序键、分区、`_version`/`_deleted`/`_expireAt` 列与跳数索引。
2. 启动链路接入：`scripts/start.js`、`postinstall`、`docker-entrypoint.sh` 在 `DB_TYPE=clickhouse` 时执行建表并校验连接，失败即退出；`DB_HOST` 的镜像报错逻辑保持不变。
3. 验收：空库首次启动可建表；重复启动幂等；连接不可用时以明确错误终止，不进入服务。

## 阶段 3：写入链路

1. 实现 `ClickHouseAdapter` 的 `upsertExecution` / `updateExecution` / `deleteExecution` / `deleteExecutions` 与 `upsertSession`，接入进程内批量队列（500 行或 100 ms、`wait_for_async_insert=1`、有界队列）。
2. 实现键列「首写固定」与归属迁移的墓碑 + 新行路径；同批重复 id 取最高版本。
3. 验收：并发 ingest 压测下无丢失、无版本回退；写后可读；重复上报幂等；归属迁移不产生重复行；删除返回行数与 SQLite 一致。

## 阶段 4：读链路

1. 实现分页查询（扩展 `findExecutions` 签名或新增 `findExecutionPage`，where/orderBy/limit/offset 全部下推）、`findExecutionById`、`findSessionByTaskId`，读路径统一 `FINAL` + `_deleted=0`。
2. 在 `execution-list-sql.ts` 增加 ClickHouse 版聚合与 id 选择，保持现有统计口径；`data-service.ts` 的 `readRecords` 在 ClickHouse 模式走真实分页，不再全量内存切片。
3. 实现筛选算子白名单与翻译测试矩阵；标签/评测跨库按页 hydrate 与两段式筛选，超限明确拒绝。
4. 验收：列表、详情、统计与 SQLite 结果对齐（同一数据集逐字段比对）；不支持的筛选返回明确错误；深分页在压测基线内。

## 阶段 5：迁移、回填与回滚

1. 编写回填工具（SQLite → ClickHouse，分页读、批量写、断点续跑）与校验脚本（行数、时间范围、按 id 字段哈希抽样）。
2. 编写回滚补写工具，覆盖「切换窗口内只写入 ClickHouse」的记录。
3. 验收：在脱敏样本库完成一次完整迁移、校验、切换、回滚演练，并留存对比报告。

## 阶段 6：运维与文档

1. docker-compose 可选 ClickHouse profile；备份与保留期脚本；监控指标接入与告警阈值。
2. 同步文档：`docs/zh/reference/platform/configuration.md`（变量与选择规则）、`docs/zh/explanation/platform/architecture.md`（存储分层与能力矩阵）、`docs/zh/how-to/platform/backup-and-restore.md`（两套存储分别备份）、`docs/zh/how-to/platform/deploy-docker.md`（可选 profile）；英文页跟随中文更新。
3. 更新 [需求清单](../../README.md) 的「是否实现」状态。

## 验证与交付

- 每阶段至少覆盖：适配层契约测试（复用 `test/usage-analytics/storage-contract.test.ts` 的 OpenGauss 契约测试写法，按 `DB_TYPE` 跳过）、`npm run test`、相关 lint 与类型检查。
- ClickHouse 实机用例依赖外部服务，默认跳过并写清跳过原因；不在 CI 中静默假绿。
- 默认不启动 dev server；如需浏览器验收，按 AGENTS.md 先与维护者确认，再走 golden path 与边界用例，并明确说明是否已在浏览器中验证。
