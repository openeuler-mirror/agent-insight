---
title: "新存储核心与旧库导出"
description: "独立存储基础库、隔离目标初始化、核心 DDL 和只读旧库迁移输入。"
---

# 新存储核心与旧库导出

`services/storage/` 是完整存储重构的首批 Python 基础库与离线入口，Python 3.11+，仅使用标准库。当前平台默认 Next.js/Prisma 读写路径没有切换；运行这些命令不会为现有平台自动启用 ClickHouse。

## 当前范围

- 核心表的完整字段/约束/索引：21 张事务表和 13 张 ClickHouse 表，其中包括 4 张新增基础表；不代表全部领域迁移完成。
- SQLite 控制仓库：新目标初始化、schema checksum、资产身份/不可变 release/依赖封存、别名与草稿 CAS、冻结运行输入、任务领取/续租/fence/取消、结果回执与 Outbox 原子提交。
- 本地结果制品写入私有目录并 fsync；任务完成前校验实际文件与 hash。外部 ArtifactStore 的凭据和认证适配另行实现。
- ClickHouse HTTP 适配器：受控 canonical Span 批量写入、最新态查询、单 Span 查询、共享 bundle revision 的多 section 正文、分块与清单完整性校验；单次编码请求上限 4MiB，正文 bundle 上限 64MiB，超过时使用后续流式 ArtifactStore。
- PostgreSQL / openGauss 专属核心 DDL；PG 有真实引擎合同测试。两者的业务运行适配器尚未接入；openGauss 未实机认证。
- 旧 SQLite 一致性清点、导出和校验。没有全量转换/目标导入、在线增量追平或生产切换命令。

ClickHouse 适配器接收由可信实体物化器产生的完整 canonical 版本；当前不会自行解决同一实体同一 revision 的不同内容冲突，不能直接替代具备归一化/所有权/重放机制的 Ingest API。多批写入可能部分成功，只有所有 sink 确认后才允许推进消费 checkpoint；完整实体物化器与自动 Outbox 发布仍属后续范围。

当前workspace外键仅保护数据引用归属，不等于已实现请求鉴权。账号密码、用户组与组管理员的授权层尚未实现，Web接入前须由服务端生成并校验访问范围。

## 离线命令

在仓库根目录执行。所有数据库路径必须显式提供，没有默认指向用户运行库的路径。

```bash
python3 -m services.storage schema --backend sqlite
python3 -m services.storage schema --backend postgresql
python3 -m services.storage schema --backend opengauss
python3 -m services.storage schema --backend clickhouse
```

以上只输出 SQL，不连接或修改数据库。新 SQLite 目标初始化：

```bash
python3 -m services.storage init-sqlite --database /absolute/path/to/new-core.db
```

目标父目录需要存在。初始化只创建新文件；已有文件必须具有精确匹配的 core schema 版本与 SQL checksum，旧 Prisma 数据库会被拒绝，不会自动改表。SQLite 新目标启用 WAL/FULL，所有连接启用外键；事务服务仍是单主机单写者，不能将文件放 NFS 供跨主机共享写入。

只读旧库清点及一致性导出：

```bash
python3 -m services.storage inspect-legacy --database /absolute/path/to/source.db
python3 -m services.storage export-legacy --database /absolute/path/to/source.db --output /absolute/path/to/new-export
python3 -m services.storage verify-export --directory /absolute/path/to/new-export
```

导出读取单一 SQLite 事务快照，包含 WAL 中已提交数据；不使用会忽略活跃 WAL 的 `immutable=1`，不改写源库。完整性和 FK 检查失败则拒绝导出，不自动修复。导出包含原始行（含凭据等敏感字段），不是脱敏报告；目录 0700、文件 0600，目的目录已存在时拒绝覆盖。CLI stdout 只输出清点摘要，不输出行数据、建表 SQL 或默认值。

每表 JSONL 保留 SQLite 值类型和重复行，manifest 包含有序物理列信息、schema 指纹、每表行数/字节摘要及内容根摘要；全部写入和同步成功后才发布 complete。`.incomplete`、缺失/多余文件、symlink、路径穿越、损坏或元数据指纹不一致会校验失败。hash 证明内部完整性，不提供签名或可信来源认证。清点/导出会扫描全表，大表应在维护窗口或一致性备份上运行。

## 版本与完整性规则

- `manifest-json/v1`：ASCII 键排序、UTF-8、不做 Unicode 归一化、不允许浮点；定点和超 JS 安全范围整数用十进制字符串，内容以 SHA-256 标识。
- release 及依赖封存后不可修改；别名只能指向同 workspace、同 asset 的已封存版本。修改发布内容需要新 release。
- RunPlan 离开 draft 后，输入集合、plan hash、manifest 和分母不可修改，也不能退回 draft；Case/evaluator 槽在任务创建时冻结。
- 回调需要匹配未过期 attempt/fence，结果制品验证通过后才提交回执和 Outbox；accepted 不是 CH indexed 或实验 published。
- revision/fence/etag 共享 1..2^63-1 范围。CH 物理 UInt64 不扩大 wire 契约。
- 正文 manifest 包含 Schema 版本、所有 section 的字节数、根摘要和逐块摘要，最后写入；读取精确 bundle revision，不拼接两个版本。
- 内部 Trace ID 删除后不复用。旧表逻辑、引用与级联不能直接跨库搬迁。

## 测试入口

```bash
python3 -W error::ResourceWarning -m unittest discover -s services/storage/tests -v
```

PostgreSQL 合同测试使用显式隔离测试容器，在临时 Schema 中执行并回滚：

```bash
STORAGE_TEST_PG_CONTAINER=your-isolated-postgres-container python3 -m unittest discover -s services/storage/tests -p test_schema.py -v
```

ClickHouse 真库项需要显式测试地址：

```bash
STORAGE_TEST_CLICKHOUSE_URL=http://127.0.0.1:your-test-port python3 -m unittest discover -s services/storage/tests -p test_clickhouse_integration.py -v
```

该测试会在显式目标创建和删除随机命名的隔离数据库，只能指向测试实例。不设置对应变量时 PG/CH 实机项明确跳过。测试结果不证明 openGauss、HA、千级混合容量或浏览器验收。完整目标、当前核心字段和 96 个旧模型迁移分类见仓库 `design/platform/analytical-transactional-storage/`；后续功能必须先补合同与真实验证，再切换业务入口。
