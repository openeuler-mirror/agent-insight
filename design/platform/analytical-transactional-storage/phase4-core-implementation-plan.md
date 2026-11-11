# Core Storage Implementation Plan

日期：2026-11-11。用户已授权：先细化核心表，然后在同步最新代码的新分支开始实施；其间无需等待回复。大规模重构分批交付，本文件是第一批的执行清单，不将第一批标记为全平台完成。

**Goal:** 固定核心物理表契约，并实现可离线验证的事务/分析存储与旧库迁移基础。

**Architecture:** 业务控制与不可变事实分离；Python 标准库先实现 SQLite 控制仓库、ClickHouse HTTP 事实访问和旧 SQLite 一致性清点/导出。PG/openGauss 使用专属核心 DDL，真实实例认证后再启用对应运行适配；不伪装为已支持线上切换。不修改现有默认存储入口，不写入现有运行数据库。

**Tech Stack:** Python 3.11+ 标准库、SQLite、ClickHouse HTTP；当前 Next.js/Prisma 全量测试作为既有应用回归。基线为 upstream/master 298d1d5b（96 models），新分支 codex/storage-core-refactor。

## Task 1：核心表字典与 SQL 基线

- Files: `core-table-dictionary.md`；`services/storage/schema/{sqlite,postgresql,opengauss,clickhouse}/001_core.sql`；`services/storage/tests/test_schema.py`。
- 先补完整字段/类型/NULL/default/PK/FK/唯一约束/索引/immutability、跨租户与同资产约束。
- 先写真实 SQLite 测试并验证红灯，再写迁移 SQL，验证建表、跨租户拒绝、发布版本不可变、唯一版本标签。
- 不用模拟 SQL 执行替代 PG/openGauss/CH 真库认证。

## Task 2：迁移旧库清点与一致性导出

- Files: `legacy-migration-design.md`；`services/storage/legacy.py`；`services/storage/tests/test_legacy.py`。
- 对96旧模型逐个分类到目标领域；源库只读，一个读事务建立一致性视图，不能用 immutable=1 忽略 WAL。
- 测试 WAL 内数据、源文件不变、FK/完整性、任意表名安全、权限和重复/中断导出；再实现清点、私有目录 JSONL 与 manifest。
- 本阶段只提供可恢复迁移输入，不自动解释所有框架旧 JSON 或对目标库全量 apply；无法转换的数据后续由独立转换器隔离。

## Task 3：真实事务控制基础

- Files: `services/storage/control.py`、`services/storage/tests/test_control.py`。
- 新目标初始化、已识别 schema 的重入校验；拒绝把现有 Prisma DB 当新库执行建表。
- 资产身份、不可变版本、同资产 alias CAS；任务 claim/fence 与结果回执/Outbox同事务；测试多连接并发与回调冲突。
- 先红灯，实施后绿灯；目标DB和工作区均用临时目录。

## Task 4：ClickHouse Span/正文链路

- Files: `services/storage/clickhouse.py`、`services/storage/tests/test_clickhouse.py`、真库 integration 测试。
- 固定 SQL 的参数绑定、批量 canonical Span/正文写入、最新态读取、workspace隔离和正文按精确revision读取。
- 验证实际CH：旧失败→新成功筛选、重复/乱序版本、跨租户、正文hash、冷读取指定Span。
- 该访问层不接管尚未实现的 Kafka entity materializer，不声称满足千级并发。

## Task 5：CLI、说明与审查

- Files: `services/storage/__main__.py`；中英公开开发指南，原设计与索引交叉链接。
- CLI提供SQL输出、新隔离目标初始化、legacy inspect/export；任何读/写目标均显式传参，无默认用户数据库路径。
- 执行Python专项、真实数据库集成、仓库npm run test；区分未覆盖与基线失败，独立审查并修复。
- 不推送远端或创建PR；用户未授权远端写。未启动dev，不声称浏览器验收。

## 后续批次

补齐PG/openGauss运行适配、durable ingest/Outbox publisher和entity materializer、固定Trace快照、Dataset发布、Evaluator/Benchmark链路、其余领域、逐模型转换器、影子读/回退和混合压测。每项以真实功能与恢复证据验收，不能把目录骨架当完成。

当前交付、验证和未覆盖项见 [实施状态](implementation-status.md)；不得仅据本任务清单推断已实现。
