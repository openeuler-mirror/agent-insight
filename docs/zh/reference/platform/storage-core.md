---
title: "新存储核心、IAM 与安全迁移"
description: "SQLite、PG、openGauss 控制面、ClickHouse 授权访问和旧库迁移输入。"
---

# 新存储核心、IAM 与安全迁移

`services/storage/` 是 Python 3.11+ 独立存储基础库。SQLite/IAM/ClickHouse 使用标准库；PG 与 openGauss 通过显式 DB-API 连接工厂接入。现有 Next.js/Prisma 应用尚未接管这些入口，执行离线命令不会切换运行库。

表的职责、主键/索引速查与八张总览/关联图见[核心表关系导读](../../../../design/platform/analytical-transactional-storage/core-table-dictionary.md#表关系总览与阅读顺序)，包括IAM、版本资产、任务结果、Trace正文及数据集/评测。

## 已实现范围

- `001_core.sql`：21 张事务表、13 张 ClickHouse 表；原始字节与 checksum 保持不变。
- `002_iam.sql`：10 张 IAM 表，003另增2张项目目录/归属表，合计 **33 张事务表 + 13 张 CH 表 = 46 张**。完整字段、类型、约束和索引见仓库 `design/platform/analytical-transactional-storage/core-table-dictionary.md`。
- 三种事务后端共享资产 release/依赖封存、别名/草稿 CAS、冻结 RunPlan、任务领取/续租/fence/取消、制品校验，以及结果回执和 Outbox 同事务提交。
- ClickHouse 支持可信 canonical Span 批量写、最新态筛选、单 Span/分页结构读取、精确 bundle revision 的多 section 正文、正文块与清单 hash 校验，以及受限范围的最新态聚合。请求上限 4MiB，正文 bundle 上限 64MiB。
- 一致性旧 SQLite 清点、原始导出和校验；尚无逐模型转换/目标 apply、在线增量追平或生产切换。

### 当前项目：default

003新增`projects`和`project_workspaces`，把已有workspace保持原ID/权限映射到default项目。新workspace同事务加入default；业务数据通过workspace间接归属项目，CH事实和排序键无需逐条改写。项目目录不产生Owner/成员授权，不合并不同用户或组的数据。

`AuthorizedStorage(iam, facts)`默认使用default，也可显式传`project_id='default'`；空字符串、空白和其他项目ID拒绝。`service.project_context(credential, workspace_id)`返回经workspace授权校验的不可变上下文。`AccessScope`以及列表/聚合响应包含project_id，缓存指纹也包含项目；单条CH事实仍保持原workspace键。

新初始化应用001+002+003。旧001/002核心初始化只校验，不自动升级；启用当前IAM/项目上下文须先显式迁移003。此批没有项目切换UI、邀请或项目Owner服务，也未改变现有客户端上传配置。后续项目管理按[设计§4.3](../../../../design/platform/analytical-transactional-storage/phase2-requirements-design.md#43-项目预留当前统一归属-default)扩展。

### IAM 与统一授权

`IAMStore` 的建账号、改密、建组、绑定空间及名称含 `for_provisioning` 的方法是可信配置端口，不能直接暴露为未鉴权 Web API。账号使用稳定 principal_id，登录名先 NFKC/trim/casefold，再限定 1..128 个 ASCII 登录字符。密码为 15..1024 字符，采用独立随机 32 字节盐与 PBKDF2-HMAC-SHA256，600000 次；只保存派生 hash 与参数。参数依据 [OWASP 密码存储指南](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)。

登录产生可撤销随机会话；API 凭据独立签发，绑定单 workspace、能力集合与到期时间，只存令牌摘要。会话最长 24h，API 凭据最长 365 天。改密、停用账号增加 auth_version；退出组永久撤销该组既有 API 凭据，重新入组不会使旧 Key 复活。读取时检查当前成员关系、组/空间状态和凭据版本。账号恢复、Web Cookie/CSRF、登录限流、登录页面及外部身份绑定流程仍需在 Web 接入批次实现。

`AuthorizedStorage` 是面向请求的统一门面：

- 会话/API 令牌经过服务端校验后生成不可变 `AccessScope`；客户端传 workspace 仅表示选择，不能提交自造 scope 获得权限。空范围始终拒绝。
- 组 owner/admin 可读取组下所有 workspace 的业务资源；member 默认仅本人或明确共享资源；viewer 只读。读取共享资源不授予编辑能力。管理员不能读取密码、Key 明文或私有评测 gold。
- Trace、资产、运行、快照和制品使用独立归属/共享记录。Span 与正文继承 Trace 权限。新 Trace 路由与归属同事务创建，不能通过重用 ID 抢占他人数据。尚未接入的领域写入口也必须在业务写事务中建立归属。
- `read_resource`、`list_resources`、单 Span、正文、聚合及有界制品下载均校验同一策略；private-gold 等未批准制品 namespace 不进入普通下载/元数据端口。
- CH 慢请求前后重新校验权限，HTTP 期间不占事务写锁。组策略、成员 etag、空间绑定 revision、主体和凭据限制共同进入 scope 指纹；缓存键必须包含当前指纹及查询条件。
- Trace 非 active 时详情/列表/正文拒绝或排除。聚合使用事务库删除屏障，即使 CH 尚未完成删除也排除这些 Trace；查询期间权限或屏障变化时拒绝结果，调用方重新请求。

普通成员聚合目前要求显式选择每空间 1..1000 个已授权 Trace；管理员可按有界 workspace 集合分析。单查询最多 4096 个绑定参数、每空间最多 1000 条删除屏障，超过时拒绝并要求缩小范围。大范围 ACL/删除字典与流式制品端口属于后续扩展，不能将此接口描述为无限制全量分析。

### 事务并发与驱动

SQLite 写事务使用 `BEGIN IMMEDIATE`；PG/openGauss 写事务暂通过 `schema_meta` 基础行锁串行协调，保证跨进程领取、回执和 fence 正确。只读事务分别使用 WAL 读取快照和 `REPEATABLE READ READ ONLY`，不占控制写锁。密码派生与 CH HTTP 在写事务外执行。此粒度是正确性基线，尚不证明 1000 采集端混合读写吞吐；细粒度 CAS/队列分片和容量验证仍需后续批次完成。

PG 可安装 `services/storage/requirements-relational.txt` 固定测试驱动。openGauss 必须按部署版本使用兼容驱动/libpq，不把 PG 协议兼容当作认证兼容。此次真实验证涵盖 PG 15.19 与 openGauss 7.0.0（PG 兼容模式）：后者使用官方 Linux ARM64 Python 包与原生 SHA256 认证；macOS 的普通 psycopg2-binary 在原生认证上不兼容。兼容 MD5 的隔离测试只用作补充，不作为生产配置建议。通过 `OpenGaussControlStore(connection_factory, schema=..., artifact_directory=...)` 注入认证过的驱动；`from_dsn` 使用当前环境导入的 psycopg2。

## 显式初始化与版本迁移

所有目标显式提供，无默认用户数据库路径。以下示例路径均需替换为隔离目标；父目录必须存在。

```bash
python3 -m services.storage schema --backend sqlite
python3 -m services.storage schema --backend postgresql --version 3
python3 -m services.storage schema --backend opengauss --version 3
python3 -m services.storage schema --backend clickhouse
python3 -m services.storage init-sqlite --database /absolute/path/to/new-core.db
python3 -m services.storage migration-plan --backend sqlite --database /absolute/path/to/core.db
python3 -m services.storage migrate-sqlite --database /absolute/path/to/core.db --backup /absolute/path/to/new-backup.db
```

`schema` 只输出 SQL。新目标初始化应用 001+002+003；已有已知 001/002 只校验，不隐式升级。当前IAM/项目上下文在003之前拒绝启用，需先显式迁移。未知版本、历史缺口或 checksum 漂移拒绝操作。已有 Prisma 库不会被原地改表。

SQLite 迁移先生成同目录的新私有备份并检查完整性/FK/hash，再持写锁重核源与备份内容，防止备份后的并发写入被遗漏；变化时拒绝并保留备份。待执行迁移及版本登记同事务成功或回滚，不覆盖旧备份、不删除原数据。新目标启用 WAL/FULL，不能将 SQLite 文件放在 NFS 跨主机共享写入。

关系库入口为 `init-relational`、`migration-plan`、`source-evidence`、`migrate-relational`，需要 `--backend postgresql|opengauss --dsn-file /private/connection.txt --schema isolated_schema --artifacts /private/artifacts`。DSN 文件必须为私有普通文件，凭据不得写命令行。迁移另需 `--backup-manifest`：先在维护窗口停止写入，完成外部 dump 与恢复核验，再提供备份字节 hash、源身份/历史/内容证据和操作声明。工具不能自动证明外部 dump 可恢复；源证据与当前锁内状态不符会拒绝。具体证据接口见 `PostgreSQLControlStore.source_evidence()`，不能用一个空文件或 `restore_verified=true` 代替真实备份。

## 旧库迁移输入

```bash
python3 -m services.storage inspect-legacy --database /absolute/path/to/source.db
python3 -m services.storage export-legacy --database /absolute/path/to/source.db --output /absolute/path/to/new-export
python3 -m services.storage verify-export --directory /absolute/path/to/new-export
```

导出读取单一 SQLite 只读事务快照，包含 WAL 中已提交数据；不使用忽略 WAL 的 `immutable=1`。完整性/FK 检查失败时拒绝，不自动修复。导出包含原始行及敏感凭据；目录 0700、文件 0600，目标已存在时拒绝覆盖。stdout 仅摘要，不输出行、建表 SQL 或默认值。

每表类型化 JSONL 保留重复行、物理列与 SQLite 值类型；manifest 包含行数、字节摘要和内容根。未完整写入、截断、篡改、多余/缺失文件、symlink、路径穿越均拒绝。hash 证明内部完整性，不提供签名认证。大表会扫描全部行，应选择维护窗口或一致性备份。

历史 User 映射稳定 principal，不能推导明文密码或创建通用默认密码。组、角色及资源归属须有显式迁移映射；不按同名/邮箱域自动归组。未绑定 workspace 和未映射资源对普通成员保持关闭。当前工具保留迁移输入，不代表 96 个旧模型已经完成语义迁移。

## 验证入口与边界

```bash
python3 -W error::ResourceWarning -m unittest discover -s services/storage/tests -v
```

真实引擎测试使用显式隔离目标：`STORAGE_TEST_PG_CONTAINER` 供 psql DDL 测试；`STORAGE_PG_DSN` 供 PG 事务合同；`STORAGE_TEST_PG_CONFIG`、`STORAGE_TEST_OPENGAUSS_CONFIG` 指向含 `dsn` 的私有 JSON 文件；`STORAGE_TEST_CLICKHOUSE_URL` 指向测试 CH。未提供时对应项明确跳过。原生 openGauss 驱动须在匹配的 Linux/Python 环境运行同一套合同。

测试会创建并删除随机 schema/数据库，仅可指向隔离实例。已验证迁移保留/回滚、组/成员/凭据/正文/聚合隔离、真实事务及万 Span 链路；结果不证明 HA、生产迁移、千级容量或浏览器验收。当前实体同 revision 内容冲突隔离、Durable Event Log、自动 Outbox 投递、固定快照与完整评测工作流仍在后续范围。最新测试数字及实际发行版证据见仓库 `design/platform/analytical-transactional-storage/implementation-status.md`。
