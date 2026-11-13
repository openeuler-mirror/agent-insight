# ClickHouse 存储支持需求

平台默认用 SQLite（Prisma，`prisma/schema.prisma` 共 96 张表）承载全部业务数据；另有一个 OpenGauss 适配层，仅在 `DB_HOST` 非空时启用，`DatabaseAdapter` 只覆盖 41 个方法，其余功能显式降级。issue #374 指出 SQLite 只适合演示、希望支持 ClickHouse 这类高性能数据库以支撑高并发。

本需求要回答两件事：**ClickHouse 在 agent-insight 里应承担哪一层存储**，以及**以什么范围落地，既能缓解并发瓶颈、又不破坏单机默认路径和现有 OpenGauss 部署**。本轮只产出设计，不改 Prisma schema、不新增 API 路由、不改运行时代码；按 AGENTS.md 先对齐设计，再进入开发。

## 现状与约束事实

- ClickHouse 是列式 OLAP 数据库，不提供唯一约束、外键和跨表事务；`UPDATE`/`DELETE` 是异步 mutation，单行高频更新不是它的设计目标。Prisma 5.22 没有 ClickHouse connector。
- 业务代码约 1000 处直接调用 `prisma` / `prismaRaw`，共 290 个 API 路由、98 处 `$transaction`；现有适配层只覆盖 41 个方法，说明「用适配层平替全部表」不可行。
- OpenGauss 模式下列表分页退化为「全量取回再内存切片」（`src/lib/storage/data-service.ts` 的 `readRecords`），高并发下并没有真正下推；这是本次设计要避免重演的教训。
- 适配层未实现的方法目前返回 `null` 或打印告警（`src/lib/storage/prisma.ts`），调用方会把「后端不支持」误读成「没有数据」。新后端必须改成显式失败。
- 后端选择目前散落在 9 个文件的 22 处 `process.env.DB_HOST` 判断里，语义是「外部库 / 少功能」，而不是「当前后端具备某能力」。新增第三种后端后必须收敛为能力开关。
- 默认 Docker 镜像 SQLite-first，`scripts/docker-entrypoint.sh` 遇到 `DB_HOST` 直接报错；`scripts/db_archive.sh` 与备份指南只覆盖 SQLite 文件，外部数据库仅提示「另行处理」；启动脚本负责 Prisma 建库和 OpenGauss 初始化。新后端需要同等明确的开通、备份与回滚路径。
- 仓内已有 Langfuse 相关设计记录，其生产形态是 Postgres 元数据 + ClickHouse 观测数据的分层组合，可作为参考，但 agent-insight 是自托管单机优先，不能照搬其重型基建。

## 需求

- **G1 写入与查询**：Trace 数据（Execution、ExecutionSkill、Session）可通过 ClickHouse 读写，列表、详情、统计和删除在 ClickHouse 模式下语义与 SQLite 一致（允许明确的产品可见差异，不允许静默错数据）。
- **G2 默认路径不变**：未设置 ClickHouse 配置时，配置项、数据位置、行为与测试基线保持现状；OpenGauss 路径不受影响。
- **G3 显式选择与可回滚**：后端通过显式配置选择；冲突配置启动即失败；不支持的功能返回明确错误或明确的降级标记，不返回空结果冒充「无数据」。
- **G4 可运维**：给出建表、迁移回填、校验、备份、保留期与监控方案，并同步配置、架构与备份文档。

## 非目标

- 不把 ClickHouse 作为 96 张表的通用 OLTP 主库，也不追求 Prisma schema 的逐表映射。
- 不改变默认部署形态，不让 ClickHouse 成为安装前置依赖。
- 不替换 OpenGauss 适配层，不改写 Skill 资产、评测、实验、可靠性控制面等事务型业务。
- 不做跨库实时事务、双写强一致或多租户隔离改造。
- 不引入托管云服务；保持全栈自托管与数据主权约束。

## 适用场景与规模假设（待确认）

设计按「单个平台实例、日增 10 万～百万级 Trace 行、列表查询 P95 目标 500 ms 内、保留期 30～180 天」估算容量；真实规模、峰值写入 QPS、HA 要求和是否强制信创环境需维护者确认。若实际规模远低于此，PostgreSQL（或现有 OpenGauss）加索引与分区即可满足，引入 ClickHouse 的运维成本并不划算。

## 验收口径

- 设计评审通过对齐后，按 [开发计划](phase3-development-plan.md) 分阶段实施；每阶段以「默认路径回归全绿 + ClickHouse 模式专项契约测试通过」为完成条件。
- ClickHouse 模式下，写入吞吐与列表 P95 有可复现的基线对比数据；不支持的能力有文档化的降级矩阵，且接口返回明确错误码而非空数据。
- 回滚演练通过：配置切回 SQLite 后，历史 Trace 可读，期间新增数据有明确的补写或丢弃说明。

## 待确认（对齐点）

1. 生产规模：日增 Trace 行数、峰值写入 QPS、保留期、列表 P95 目标；是否已有 ClickHouse 集群可复用。
2. 是否接受**分层方案**：ClickHouse 只承载 Trace 数据面，元数据与控制面继续留在 SQLite（或 OpenGauss），而不是「ClickHouse 唯一数据库」。
3. 部署形态：单节点 ClickHouse 是否可接受；是否要求多个平台副本共享同一份 Trace 数据。
4. 依赖引入：是否允许新增 `@clickhouse/client`（官方 Node HTTP 客户端，Apache-2.0）。
5. 备份与保留期责任方：由平台提供统一脚本，还是交由部署方按 ClickHouse 原生工具自理。
