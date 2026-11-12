---
title: "新存储核心、IAM 与安全迁移"
description: "SQLite、PG、openGauss 控制面、ClickHouse 授权访问和旧库迁移输入。"
---

# 新存储核心、IAM 与安全迁移

**产品兼容状态（2026-11-12）**：本页记录内部存储技术样例。当前core模式尚未保留全部原有功能/界面，不是原产品切库的使用方式或验收结果。目标要求保留现有全部能力，仅替换数据支持；恢复原界面及逐领域数据接管仍待完成。下文配置仅用于隔离技术验证。

`services/storage/` 是 Python 3.11+ 独立存储基础库。SQLite/IAM/ClickHouse 使用标准库；PG 与 openGauss 通过显式 DB-API 连接工厂接入。Next在显式core模式接管Trace采集、列表、Span和正文，并使用独立密码登录；其他领域尚未整体接管。未设置开关保留旧路径，离线命令不会切换运行库。启用和启动步骤见[隔离运行指南](../../how-to/platform/storage-core.md)。

表的职责、主键/索引速查与八张总览/关联图见[核心表关系导读](../../../../design/platform/analytical-transactional-storage/core-table-dictionary.md#表关系总览与阅读顺序)，包括IAM、版本资产、任务结果、Trace正文及数据集/评测。

## 已实现范围

- `001_core.sql`：21 张事务表、13 张 ClickHouse 表；原始字节与 checksum 保持不变。
- `002_iam.sql`：10 张 IAM 表，003另增2张项目目录/归属表，004再增2张采集/实体版本表，合计 **35 张事务表 + 13 张 CH 表 = 48 张**。完整字段、类型、约束和索引见仓库 `design/platform/analytical-transactional-storage/core-table-dictionary.md`。
- 三种事务后端共享资产 release/依赖封存、别名/草稿 CAS、冻结 RunPlan、任务领取/续租/fence/取消、制品校验，以及结果回执和 Outbox 同事务提交。
- ClickHouse 支持可信 canonical Span 批量写、最新态筛选、单 Span/分页结构读取、精确 bundle revision 的多 section 正文、正文块与清单 hash 校验，以及受限范围的最新态聚合。请求上限 4MiB，正文 bundle 上限 64MiB。
- `observations.py`可靠接收完成OTLP Span、冻结准备计划、全局强序Outbox worker及幂等CH物化；`trace_service.py`提供loopback HTTP查询/接收，Next显式桥接与独立密码Cookie。
- 一致性旧SQLite清点、原始导出和校验；`trace_import.py`已提供Session/Execution允许字段的显式映射、dry-run/隔离报告及经同一接收链路apply。尚未完成全部96模型语义迁移、在线增量追平或生产切换。

### 当前项目：default

003新增`projects`和`project_workspaces`，把已有workspace保持原ID/权限映射到default项目。新workspace同事务加入default；业务数据通过workspace间接归属项目，CH事实和排序键无需逐条改写。项目目录不产生Owner/成员授权，不合并不同用户或组的数据。

`AuthorizedStorage(iam, facts)`默认使用default，也可显式传`project_id='default'`；空字符串、空白和其他项目ID拒绝。`service.project_context(credential, workspace_id)`返回经workspace授权校验的不可变上下文。`AccessScope`以及列表/聚合响应包含project_id，缓存指纹也包含项目；单条CH事实仍保持原workspace键。

新初始化应用001–004。已有001/002/003前缀只校验，不自动升级；IAM/项目上下文要求003，Trace HTTP采集/读取服务要求当前004，均须先显式迁移。此批没有项目切换UI、邀请或项目Owner服务，也未改变现有客户端上传配置。后续项目管理按[设计§4.3](../../../../design/platform/analytical-transactional-storage/phase2-requirements-design.md#43-项目预留当前统一归属-default)扩展。

### IAM 与统一授权

`IAMStore` 的建账号、改密、建组、绑定空间及名称含 `for_provisioning` 的方法是可信配置端口，不能直接暴露为未鉴权 Web API。账号使用稳定 principal_id，登录名先 NFKC/trim/casefold，再限定 1..128 个 ASCII 登录字符。密码为 15..1024 字符，采用独立随机 32 字节盐与 PBKDF2-HMAC-SHA256，600000 次；只保存派生 hash 与参数。参数依据 [OWASP 密码存储指南](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)。

登录产生可撤销随机会话；API 凭据独立签发，绑定单 workspace、能力集合与到期时间，只存令牌摘要。会话最长 24h，API 凭据最长 365 天。改密、停用账号增加 auth_version；退出组永久撤销该组既有 API 凭据，重新入组不会使旧 Key 复活。读取时检查当前成员关系、组/空间状态和凭据版本。core已提供独立用户名/密码页面、HttpOnly/SameSite=Strict Cookie、变更同源Origin检查及单实例登录限流；账号恢复、外部身份绑定和跨实例限流仍待扩展。旧自动用户名注册/旧Key不成为新IAM凭据。

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
python3 -m services.storage schema --backend postgresql --version 4
python3 -m services.storage schema --backend opengauss --version 4
python3 -m services.storage schema --backend clickhouse
python3 -m services.storage init-sqlite --database /absolute/path/to/new-core.db
python3 -m services.storage migration-plan --backend sqlite --database /absolute/path/to/core.db
python3 -m services.storage migrate-sqlite --database /absolute/path/to/core.db --backup /absolute/path/to/new-backup.db
```

`schema` 只输出 SQL。新目标初始化应用001–004；已有已知001/002/003只校验，不隐式升级。IAM/项目上下文要求003；Trace HTTP服务启动要求已应用当前004，需先显式迁移。未知版本、历史缺口或 checksum 漂移拒绝操作。已有 Prisma 库不会被原地改表。

SQLite 迁移先生成同目录的新私有备份并检查完整性/FK/hash，再持写锁重核源与备份内容，防止备份后的并发写入被遗漏；变化时拒绝并保留备份。待执行迁移及版本登记同事务成功或回滚，不覆盖旧备份、不删除原数据。新目标启用 WAL/FULL，不能将 SQLite 文件放在 NFS 跨主机共享写入。

关系库入口为 `init-relational`、`migration-plan`、`source-evidence`、`migrate-relational`，需要 `--backend postgresql|opengauss --dsn-file /private/connection.txt --schema isolated_schema --artifacts /private/artifacts`。DSN 文件必须为私有普通文件，凭据不得写命令行。迁移另需 `--backup-manifest`：先在维护窗口停止写入，完成外部 dump 与恢复核验，再提供备份字节 hash、源身份/历史/内容证据和操作声明。工具不能自动证明外部 dump 可恢复；源证据与当前锁内状态不符会拒绝。具体证据接口见 `PostgreSQLControlStore.source_evidence()`，不能用一个空文件或 `restore_verified=true` 代替真实备份。

## Trace 接收、物化与查询契约

`ObservationIngest(control,facts)`提供`accept(credential,workspace_id,body,receipt_key=None)`、`work_once(worker_id,lease_ms=30000)`及`batch_status`。可靠接收先校验全包和当前写权限，私有原始制品fsync后才同事务写locator、ACL、batch、Outbox。幂等键按空间/主体隔离；同键不同包冲突。accepted不等于indexed，write-only采集凭据可查本人回执。

| 边界 | 当前合同 |
|---|---|
| 输入 | 完成的OTLP Span；4MiB JSON包、4096 Span，归一化展开总预算64MiB |
| Web协议 | `/api/ingest/otel/v1/traces`接收JSON/protobuf/gzip，解码后转JSON；后端HTTP只接JSON/API凭据 |
| 来源/路由 | 默认`otlp`，service.name仅显示；跨service同原生Trace合并，显式`agent_insight.source_namespace`隔离；UUID5/首个bucket固定 |
| 源版本 | `agent_insight.revision`默认1；旧版本忽略，同版本不同内容失败；内部head版本独立分配 |
| 队列 | 复用Outbox事件`observability.otlp.accepted.v1`，全局最早未完成事件强序，活动租约/退避不被越过 |
| 正文 | 每128 Span批量；每HTTP≤4MiB；chunk≤256KiB、单bundle≤64MiB；先全部chunks再manifests |
| 完成 | 冻结计划/head先提交，随后正文→Span→Trace摘要；重试固定版本；全部sink成功且fence有效才indexed/sent |
| 汇总 | 最新Span差量计数/Token；未知Token总数NULL并保留覆盖度，不叠加累计快照；状态done/failed/running/unknown |
| 页面 | Trace默认50/最大200；Span默认/最大200；正文默认/最大4块，按精确payload_revision读取 |

底层可信CH适配器仍支持最多1000结构行、32正文块的有界kernel调用；HTTP/UI限制更小，不能混用两层上限。缺少section返回`available=false`，不回退其他正文版本。列表最多扫描2000授权路由候选，游标绑定scope/过滤条件并签名；不虚报无法确定的全局total。

`trace_service.py`只监听127.0.0.1，32个并行请求槽，过载503。`--config`指定0600普通JSON文件；control选择sqlite(database)或postgresql/opengauss(dsn/schema/artifacts)，clickhouse指定endpoint/database/user/password，另含cursor_secret_hex、default_workspace、port、worker_enabled。先显式初始化/迁移全部控制schema与CH，启动不会建表升级。配置示例和可信账号/Key配置见[操作指南](../../how-to/platform/storage-core.md)。

Web配置`NEXT_PUBLIC_AGENT_INSIGHT_TRACE_STORAGE=core`与仅服务端的`AGENT_INSIGHT_STORAGE_CORE_URL=http://127.0.0.1:4319`；前者改变后需重建/重启。`DATABASE_URL`是独立旧壳库，不能指向core.db。core认证Cookie与旧身份分开，JS不持有会话token；开关未设置保留旧模式，已启用故障不回落旧库。

此为单队列/控制写锁正确性基线，不是分片事件日志、HA或1000采集端吞吐认证。固定快照和完整评测物化仍属后续范围。

## 旧库迁移输入

```bash
python3 -m services.storage inspect-legacy --database /absolute/path/to/source.db
python3 -m services.storage export-legacy --database /absolute/path/to/source.db --output /absolute/path/to/new-export
python3 -m services.storage verify-export --directory /absolute/path/to/new-export
```

导出读取单一 SQLite 只读事务快照，包含 WAL 中已提交数据；不使用忽略 WAL 的 `immutable=1`。完整性/FK 检查失败时拒绝，不自动修复。导出包含原始行及敏感凭据；目录 0700、文件 0600，目标已存在时拒绝覆盖。stdout 仅摘要，不输出行、建表 SQL 或默认值。

每表类型化 JSONL 保留重复行、物理列与 SQLite 值类型；manifest 包含行数、字节摘要和内容根。未完整写入、截断、篡改、多余/缺失文件、symlink、路径穿越均拒绝。hash 证明内部完整性，不提供签名认证。大表会扫描全部行，应选择维护窗口或一致性备份。

历史 User 映射稳定 principal，不能推导明文密码或创建通用默认密码。组、角色及资源归属须有显式迁移映射；不按同名/邮箱域自动归组。未绑定 workspace 和未映射资源对普通成员保持关闭。原始导出不代表96个旧模型已经完成语义迁移。Trace专用`import_legacy_traces`仅转换验证过的Session/Execution允许字段，需明确user→credential/workspace映射；默认dry_run，部分/未知sender结果用同source_id/导出/receipt重放，隔离/不支持字段写报告。它不恢复旧密码/Key、不自动归组，也不执行生产切换。

## 验证入口与边界

```bash
python3 -W error::ResourceWarning -m unittest discover -s services/storage/tests -v
```

真实引擎测试使用显式隔离目标：`STORAGE_TEST_PG_CONTAINER` 供 psql DDL 测试；`STORAGE_PG_DSN` 供 PG 事务合同；`STORAGE_TEST_PG_CONFIG`、`STORAGE_TEST_OPENGAUSS_CONFIG` 指向含 `dsn` 的私有 JSON 文件；`STORAGE_TEST_CLICKHOUSE_URL` 指向测试CH；`STORAGE_OBSERVATIONS_PG_CONFIG`为采集合同的私有PG JSON配置（dsn或连接参数）。未提供时对应项明确跳过。原生 openGauss 驱动须在匹配的 Linux/Python 环境运行同一套合同。

测试会创建并删除随机 schema/数据库，仅可指向隔离实例。已验证迁移保留/回滚、组/成员/凭据/正文/聚合隔离、真实事务及万 Span 链路；结果不证明 HA、生产迁移、千级容量或浏览器验收。004已实现观测Span同源版本冲突隔离和强序Outbox自动物化；分片Durable Event Log、其他领域投递、固定快照与完整评测工作流仍在后续范围。最新测试数字及实际发行版证据见仓库 `design/platform/analytical-transactional-storage/implementation-status.md`。
