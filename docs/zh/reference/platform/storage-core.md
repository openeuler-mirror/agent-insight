---
title: "新存储核心、IAM 与安全迁移"
description: "SQLite、PG、openGauss 控制面、ClickHouse 授权访问和旧库迁移输入。"
---

# 新存储核心、IAM 与安全迁移

**产品兼容状态（2026-11-14）**：原前端已恢复为重构前版本，Trace旧接口由服务端兼容。完整功能数据接管与回归仍未完成，不能作为生产切库结果；本页配置只用于隔离验证。

`services/storage/` 是 Python 3.11+ 独立存储基础库。SQLite/IAM/ClickHouse 使用标准库；PG 与 openGauss 通过显式 DB-API 连接工厂接入。Next在显式core模式接管Trace采集、列表、Span和正文，保持原登录与界面；其他领域尚未整体接管。未设置开关保留旧路径，离线命令不会切换运行库。启用和启动步骤见[隔离运行指南](../../how-to/platform/storage-core.md)。

表的职责、主键/索引速查与总览/关联图见[核心表关系导读](../../../../design/platform/analytical-transactional-storage/core-table-dictionary.md#表关系总览与阅读顺序)，包括IAM、版本资产、任务结果、Trace正文及数据集/评测。

## 已实现范围

- `001_core.sql`：21 张事务表、13 张 ClickHouse 表；原始字节与 checksum 保持不变。
- `002_iam.sql`：10 张 IAM 表，003另增2张项目目录/归属表，004再增2张采集/实体版本表，005新增4张旧ID/标注/标签表，006增加2张诊断会话/消息表，007增加2张报告运行/当前指针表，008新增2张数据集兼容head/操作回执表，009新增1张Trace生成任务表，010新增8张实验索引、011新增2张诊断来源绑定、012新增5张Benchmark表、013兼容空证据且不新增表、014新增1张Issue解决注解表，015新增3张统计控制索引，016新增1张首次采集准备封存表，017新增3张Thread控制关系表，CH002新增2张统计事实表，合计 **69 张事务表 + 15 张 CH 表 = 84 张**。完整字段、类型、约束和索引见仓库 `design/platform/analytical-transactional-storage/core-table-dictionary.md`。
- 三种事务后端共享资产 release/依赖封存、别名/草稿 CAS、冻结 RunPlan、任务领取/续租/fence/取消、制品校验，以及结果回执和 Outbox 同事务提交。
- ClickHouse 支持可信 canonical Span 批量写、最新态筛选、单 Span/分页结构读取、精确 bundle revision 的多 section 正文、正文块与清单 hash 校验，以及受限范围的最新态聚合。请求上限 4MiB，正文 bundle 上限 64MiB。
- `observations.py`可靠接收完成OTLP Span、冻结准备计划、全局强序Outbox worker及幂等CH物化；`trace_service.py`提供loopback HTTP查询/接收，Next服务端原接口兼容及旧身份显式映射。
- 一致性旧SQLite清点、原始导出和校验；`trace_import.py`已提供Session/Execution允许字段的显式映射、dry-run/隔离报告及经同一接收链路apply。尚未完成全部96模型语义迁移、在线增量追平或生产切换。

### 当前项目：default

003新增`projects`和`project_workspaces`，把已有workspace保持原ID/权限映射到default项目。新workspace同事务加入default；业务数据通过workspace间接归属项目，CH事实和排序键无需逐条改写。项目目录不产生Owner/成员授权，不合并不同用户或组的数据。

`AuthorizedStorage(iam, facts)`默认使用default，也可显式传`project_id='default'`；空字符串、空白和其他项目ID拒绝。`service.project_context(credential, workspace_id)`返回经workspace授权校验的不可变上下文。`AccessScope`以及列表/聚合响应包含project_id，缓存指纹也包含项目；单条CH事实仍保持原workspace键。

新初始化应用001–017。已有001/002/003前缀只校验，不自动升级；IAM/项目上下文要求003，服务启动要求迁移到当前017（基础Trace最低007、Dataset最低008、Trace生成最低009、实验最低010、DiagnosisRun最低011、Benchmark最低013、派生Issue解决最低014、统计消费者最低015、私有采集准备最低016、采集图和Thread最低017），均须先显式迁移。此批没有项目切换UI、邀请或项目Owner服务，也未改变现有客户端上传配置。后续项目管理按[设计§4.3](../../../../design/platform/analytical-transactional-storage/phase2-requirements-design.md#43-项目预留当前统一归属-default)扩展。

### IAM 与统一授权

`IAMStore` 的建账号、改密、建组、绑定空间及名称含 `for_provisioning` 的方法是可信配置端口，不能直接暴露为未鉴权 Web API。账号使用稳定 principal_id，登录名先 NFKC/trim/casefold，再限定 1..128 个 ASCII 登录字符。密码为 15..1024 字符，采用独立随机 32 字节盐与 PBKDF2-HMAC-SHA256，600000 次；只保存派生 hash 与参数。参数依据 [OWASP 密码存储指南](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)。

登录产生可撤销随机会话；API 凭据独立签发，绑定单 workspace、能力集合与到期时间，只存令牌摘要。会话最长 24h，API 凭据最长 365 天。改密、停用账号增加 auth_version；退出组永久撤销该组既有 API 凭据，重新入组不会使旧 Key 复活。读取时检查当前成员关系、组/空间状态和凭据版本。IAM密码/API基础协议保留，但本次不改变原登录页面。旧Key经原认证核验后，必须通过服务端私有映射取得当前IAM凭据；旧用户名不会自动成为IAM身份。账号恢复、完整统一身份迁移及跨实例限流仍待扩展。

`AuthorizedStorage` 是面向请求的统一门面：

- 会话/API 令牌经过服务端校验后生成不可变 `AccessScope`；客户端传 workspace 仅表示选择，不能提交自造 scope 获得权限。空范围始终拒绝。
- 组 owner/admin 可读取组下所有 workspace 的业务资源；member 默认仅本人或明确共享资源，删除要求独立delete能力且只允许本人资源；viewer 只读。读取共享资源不授予编辑能力。管理员不能读取密码、Key 明文或私有评测 gold。
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
python3 -m services.storage schema --backend postgresql --version 5
python3 -m services.storage schema --backend opengauss --version 5
python3 -m services.storage schema --backend clickhouse
python3 -m services.storage init-sqlite --database /absolute/path/to/new-core.db
python3 -m services.storage migration-plan --backend sqlite --database /absolute/path/to/core.db
python3 -m services.storage migrate-sqlite --database /absolute/path/to/core.db --backup /absolute/path/to/new-backup.db
```

`schema` 只输出 SQL。新目标初始化应用001–007；已有已知001/002/003只校验，不隐式升级。IAM/项目上下文要求003；Trace HTTP服务启动要求已应用当前007，需先显式迁移。未知版本、历史缺口或 checksum 漂移拒绝操作。已有 Prisma 库不会被原地改表。

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

`trace_service.py`只监听127.0.0.1，32个并行请求槽，过载503。`--config`指定0600普通JSON文件；control选择sqlite(database)或postgresql/opengauss(dsn/schema/artifacts)，clickhouse指定endpoint/database/user/password，另含cursor_secret_hex、controller_key_file、default_workspace、port、worker_enabled。先显式初始化/迁移全部控制schema与CH，启动不会建表升级。配置示例和可信账号/Key配置见[操作指南](../../how-to/platform/storage-core.md)。

Web使用仅服务端`AGENT_INSIGHT_TRACE_STORAGE=core`、`AGENT_INSIGHT_STORAGE_CORE_URL`及`AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE`，配置变更后重启。旧public flag只保留服务端兼容别名。`DATABASE_URL`仍为隔离旧业务库，不能指向core.db；原前端Key保存/登录行为不改。映射文件0600且绑定验证过的旧Key摘要、旧用户名、IAM主体、workspace及read/write/execute/delete代理凭据。错误不回落旧Trace库，未迁移领域仍有既有路径。

### 原接口兼容与005

`trace_legacy_ids`保存不可变task/execution别名；`trace_annotations`保存版本化标注和显式空值覆盖；`trace_tags`和`trace_tag_links`保存用户标签及多对多关联。均在控制库，受当前IAM与删除屏障约束。001–004不变。新OTLP路由同接收事务登记native ID别名；旧路由需明确回填，不按同名猜测。

兼容入口为旧`/api/observe/data`、`/api/observe/session`、`/api/tags`、execution tags及Trace bundle import/export。列表支持旧记录/统计/筛选合同；含 taskId、executionId 或非空 taskIds 的准确定位先按当前 IAM 解析旧别名/内部 ID 并取交集，只物化所选 Trace，保留来源、当前 Outcome、权限及删除屏障的前后复核。缺失或无权的选择返回空集，仍校验空结果请求的筛选参数；skills/values/tags 全局 facet 保持原范围。普通列表仍枚举授权范围，超过100000条明确拒绝；尚未完成通用索引下推和千级并发容量验证。普通结构读取所有轻量Span、最多100000条/16MiB；后端按200条读取，不在结构请求中加载正文。点击单Span按固定索引和精确payload revision装载。完整会话/导出128MiB上限；原Langfuse节点协议需完整正文，单独作为兼容例外。

Trace bundle v1导入50MiB/500 execution、全树预检、ID/引用重映射，同一receipt可恢复，全部batch indexed才返回原成功DTO。兼容元数据写不回写采集原文；final_result编辑关联评测交接尚未实现，当前明确冲突。Trace回流、普通实验/评测结果/RunPlan及DiagnosisRun消费者已使用下述新存储协议；infra和非OTLP既有写入口仍有未接入范围，不能把页面恢复视为全部功能迁移完成。

此为单队列/控制写锁正确性基线，不是分片事件日志、HA或1000采集端吞吐认证。封存快照与评测投影已接入；超大数据规模和千级并发仍需独立容量验证。

## 旧库迁移输入

```bash
python3 -m services.storage inspect-legacy --database /absolute/path/to/source.db
python3 -m services.storage export-legacy --database /absolute/path/to/source.db --output /absolute/path/to/new-export
python3 -m services.storage verify-export --directory /absolute/path/to/new-export
```

导出读取单一 SQLite 只读事务快照，包含 WAL 中已提交数据；不使用忽略 WAL 的 `immutable=1`。完整性/FK 检查失败时拒绝，不自动修复。导出包含原始行及敏感凭据；目录 0700、文件 0600，目标已存在时拒绝覆盖。stdout 仅摘要，不输出行、建表 SQL 或默认值。

每表类型化 JSONL 保留重复行、物理列与 SQLite 值类型；manifest 包含行数、字节摘要和内容根。未完整写入、截断、篡改、多余/缺失文件、symlink、路径穿越均拒绝。hash 证明内部完整性，不提供签名认证。大表会扫描全部行，应选择维护窗口或一致性备份。

历史 User 映射稳定 principal，不能推导明文密码或创建通用默认密码。组、角色及资源归属须有显式迁移映射；不按同名/邮箱域自动归组。未绑定 workspace 和未映射资源对普通成员保持关闭。原始导出不代表96个旧模型已经完成语义迁移。Trace专用`import_legacy_traces`仅转换验证过的Session/Execution允许字段，需明确user→credential/workspace映射；默认dry_run，部分/未知sender结果用同source_id/导出/receipt重放，隔离/不支持字段写报告。它不恢复旧密码/Key、不自动归组，也不执行生产切换。


### 只读语义计划（不执行导入）

`migration-plan`只检查新核心DDL升级；旧数据使用独立的`plan-legacy`：

```bash
python3 -m services.storage plan-legacy \
  --database /absolute/path/to/isolated-legacy.db \
  --source-id stable-source-name \
  --bindings-file /private/owner-bindings.json
```

当前只支持显式SQLite `--database`，不支持`--directory`或目标库参数。owner映射文件须0600、非symlink、最多1MiB，形如`{"legacy-alice":{"principal_id":"principal-a","workspace_id":"workspace-a"}}`；不接受密码/Key，不凭同名自动合并账号。映射仅声明目标ID，不连接目标库验证其存在或实时授权。

版本化目录覆盖当前96模型、1250个物理列及Prisma表/字段别名。报告只输出结构、计数、处置类别和摘要；检测未知/缺列、类型/主键/唯一/FK漂移、真实与目录已声明的逻辑孤儿、owner缺失/冲突及IAM登录名归一化碰撞。`sourceExecutionId`作为framework原生身份检查复合键歧义，不当作Execution外键。JSON保留为私有待转换，嵌套业务引用检查尚未完整实现。

默认预算为100000行、64MiB原始行字节、单行8MiB、512表、每表256列、256条问题明细、15秒及SQLite VM步数上限；CLI可调整`--max-rows/--max-bytes/--max-issues/--max-seconds`，时间最多120秒。字节限制不等于进程RSS，SQL/循环边界检查不是可中断每个哈希操作的硬实时期限；最终超时仍标不完整。扫描不完整时不从缺失父表缓存推断语义孤儿，完整内容摘要为null。仅一个只读事务捕获数据，保留已提交WAL。

所有结果均为`mode=planning-only`、`status=blocked`、`full_migration_ready=false`，不连接目标、不复制行、不apply。CLI退出0只表示诊断命令成功，不能当作可切库；自动化必须核对状态字段。有限Trace转换候选不代表整行完整迁移。内容摘要使用`legacy-plan-typed-row-multiset/v1`，与原export摘要不可互换；source_id只用于稳定来源身份，内容/目录/映射摘要绑定本轮计划。原inspect/export/verify严格行为保持，FK违例仍阻止原导出。完整迁移清单及依赖见[实施设计](../../../../design/platform/analytical-transactional-storage/phase7-consumers-and-legacy-migration.md)。

## 验证入口与边界

```bash
python3 -W error::ResourceWarning -m unittest discover -s services/storage/tests -v
```

真实引擎测试使用显式隔离目标：`STORAGE_TEST_PG_CONTAINER` 供 psql DDL 测试；`STORAGE_PG_DSN` 供 PG 事务合同；`STORAGE_TEST_PG_CONFIG`、`STORAGE_TEST_OPENGAUSS_CONFIG` 指向含 `dsn` 的私有 JSON 文件；`STORAGE_TEST_CLICKHOUSE_URL` 指向测试CH；`STORAGE_OBSERVATIONS_PG_CONFIG`为采集合同的私有PG JSON配置（dsn或连接参数）。未提供时对应项明确跳过。原生 openGauss 驱动须在匹配的 Linux/Python 环境运行同一套合同。

测试会创建并删除随机 schema/数据库，仅可指向隔离实例。已验证迁移保留/回滚、组/成员/凭据/正文/聚合隔离、真实事务及万 Span 链路；结果不证明 HA、生产迁移、千级容量或浏览器验收。004已实现观测Span同源版本冲突隔离和强序Outbox自动物化；分片Durable Event Log、其他领域投递、固定快照与完整评测工作流仍在后续范围。最新测试数字及实际发行版证据见仓库 `design/platform/analytical-transactional-storage/implementation-status.md`。

### 评测与诊断使用的完整 Trace 取证

私有`/v1/compat/observe/evidence`与server-only `readTraceEvidence`冻结授权范围、别名/owner、路由代次、注解版本及Span/Trace head向量，核对CH当前集合与精确revision/正文hash，读取后重核。它与普通页面full读不同：prepared head不等于CH已就绪，读取途中变化409、未追上/缺失/损坏503、超过16MiB/100000 Span413；不截断、不回落旧库为空轨迹。非法UTF8在传输边界拒绝。

原trace-drafts core分支使用这份完整证据，保留原DTO、Claude Code规范化、子Agent推断和空输入/输出warning。草稿可通过已接入的backflow保存到版本化Dataset；实验执行、DiagnosisRun、重测及结果消费者采用下述typed协议，诊断会话/SSE及Trace报告采用独立协议。证据manifest/hash不含凭据和绝对路径；Next仍使用既有JS Number语义，精确大整数扩展应以字符串上报。诊断自身运行Trace必须一并保留，不能通过停用其recorder简化迁移。


### 诊断 Agent、自身 Trace、聊天与报告

006的`trace_diagnosis_sessions/messages`保存聊天事务；007的`diagnostic_report_runs/heads`保存AgentDebug与SkillsAnalysis的报告运行及当前选择。原故障页、报告页和原SSE事件格式保留；未设置core开关时继续原模式。请求中的`user`与`executionBrief`不授予权限，模型配置取当前已验证账号；兼容映射显式保留旧模型配置用户名，不能借组管理员身份使用成员的模型凭据。

- 原诊断session GET/POST、stream路由保持。task/execution/internal Trace ID在同一权限范围内解析，歧义409；user/assistant每轮原子分配连续seq。消息全文checkpoint提交后才发送text，最终回复与自身Trace均持久化后才发送done。
- 自身Trace通过`AgentTraceRecorder`接入同一durable batch/outbox/CH管道；成功、模型失败与中断均保留实际provider messages、工具参数/结果、错误和原公开session ID。稳定message/tool身份与源revision使重复完整快照不重复历史/token，修正内容才推进版本；部分投递失败可用同snapshot重试。
- 私有`POST /v1/compat/observe/agent-traces`等待全部batch indexed，返回不可由布尔值替代的receipt。finish再次核验其actor/workspace/task/parent/session/request及完整批次，防止用其他Trace或其他轮次的receipt完成聊天。accepted/prepared不算done。
- 同Trace每次仅一轮持lease/fence，失权、删除、旧fence及过期租约拒绝更新并中止Agent。状态响应丢失对同body有限重投，不重新启动模型。消息1MiB、助手8MiB、历史16MiB/10000条、流式待处理64项/16MiB，超限明确失败且不截成完整结果。revision/fence/seq通过HTTP使用十进制字符串。
- `sessionId:null`新建上游对话；已登记历史ID仅同一实际actor可续聊。组管理员可以查看已授权成员历史，并新建自己的上游；当前不支持跨actor复用同一个OpenCode session，因为其运行数据和凭据按用户隔离。不会通过共享用户运行目录绕开此限制。
- AgentDebug与SkillsAnalysis沿原分析器/Skill/Agent运行，完整TraceEvidence冻结输入。每次运行持独立head/revision及私有lease，串行持久化进度，force重跑/删除后旧job不能覆盖新结果。报告正文与进度为私有hash制品，读取仍检查当前Trace权限；无正文时不从旧Prisma同名报告兜底。

评测`DiagnosisRun`与实验/重测闭环已接入下述消费者协议。这不包含旧聊天/报告自动导入、生产迁移或千级并发容量证明。旧库历史保留，需显式actor/Trace映射后单独迁移。模型服务仍为原Next/OpenCode运行器，没有新增Python评测服务。

原Skill部署入口通过typed DiagnosisRun和TraceEvidence确定本人来源、client及唯一opaque Skill origin，不读取旧动态Trace影子。预检前后及WSS派发前重验来源；持久化命令入队即成为可轮询的授权边界，入队后派发前复核失败将命令标为投递失败并拒绝制品领取，已在途或已领取命令不承诺跨库原子回收。隔离模拟设备闭环验证了真实存储、命令及回执链路，不代表真实客户端安装验收。

原诊断请求通过既有apiFetch补齐同源Key请求头，保留原登录/退出/切换行为和全部页面源码；不引入额外Cookie或登录态。

结构读取保留工具骨架及Task/Skill白名单链接，正文按需读取。单工具（或无carrier的整组工具）紧凑投影上限2KiB，超限结构明确413，完整正文不丢弃；已有旧投影不通过相同source revision重放自动改写。早期Task/Skill缺失的派生链接需显式重建，完整视图仍读原文。


### 数据集版本、Trace 回流与批量生成（008/009）

原 `/api/agent-datasets`、单数据集、backflow、generation-options、trace-generation、generation/cancel 和 deletions 接口在 core 模式使用新存储。可见页面与文案保留；定义、行、字段与批量编辑仅增加隐藏的草稿版本状态和 If-Match 请求头。未进入可信请求上下文的实验/评测等 Dataset 消费者明确503，不读取旧表冒充已完成迁移。

008的 `dataset_compat_heads` 保存归属、生命周期、当前release与单调revision；`dataset_operation_receipts` 保存主体/空间/操作绑定的精确重试结果。样例和扩展字段复用不可变资产release及hash制品，Unicode键、小数、false保持原值。执行输入与私有答案/trajectory分开；作者读回需当前gold权限，组管理员不能据此绕过gold限制。根因缓存为私有覆盖层，不推进资产版本。

- 读取响应带ETag；PATCH/DELETE缺基线返回428、陈旧基线409。历史版本ETag不同于head，不能用于覆盖当前版本。组件保存打开草稿时的基线。`GET /api/agent-datasets/:id?view=versions` 返回摘要，`?version=1` 读历史全文，`?view=case&caseId=...` 只读该样例，`?view=items` 读预览。
- 普通写入每次产生私有不可变版本；相同主体/操作/请求的网络重投返回原回执。Trace回流先冻结并重新校验来源权限与hash，冲突时有限重读去重后追加；纯重复回流不制造新版本。删除为生命周期屏障，旧worker不能复活数据。
- 兼容列表最多2000项、历史最多1000版；完整列表/历史响应有64MiB总预算，超限明确拒绝。样例预览600字符是显示投影，原始完整内容仍在制品中。普通下载不能访问dataset gold/cache命名空间。
- Dataset发布与Outbox同事务；后台先写 `dataset_samples` 后写 `dataset_release_members`，使用冻结批次/版本重试。`indexed` 表示投影已确认，不能把事务接收成功视为CH已经可见。

009的 `dataset_generation_jobs` 保存配置/成员/进度制品引用、实际actor、30秒租约、epoch fence、取消删除与结果回执。生产worker沿用原normalizer、采样和content processor；来源Trace头与正文摘要冻结，完整工具大正文不跨到JS。单Span Python验证预算64MiB、事件响应16MiB、JS答案特征64MiB、最终样例32MiB；超限拒绝而非伪造截断成功。目录最多10000条授权Trace。Next每进程最多2个活动生成任务、20个排队项，这是有界正确性实现，不是千级吞吐保证。

重启后只在原actor的当前有效进度请求中恢复，旧租约到期后重新领取并增加epoch；不持久化Bearer，也不由管理员冒充owner恢复。源分页在慢制品读取后再次校验权限/租约/生命周期；完成时同事务发布Dataset版本、任务终态及回执。系统FI目录仍是只读动态视图，不能当作新封存release；RunPlan须冻结有效目录。普通实验/评测结果、RunPlan及受控Benchmark导入已接入下述协议；旧Dataset语义导入及生产切换仍待实施。


### 实验、评测结果与 RunPlan 消费者（010–014）

原实验与结果页面沿用原DTO、聚合和评分算法。实验容器、Case、结果槽、checkpoint、人工评分和评论使用typed领域操作；不把远程CRUD拼成Prisma事务。评估器定义、Dataset、Skill与实际模型选择在启动前封存，每次重评保留原RunPlan、机器回执及其来源。人工0分有效且只作用于对应机器回执，不能漂移到重评后的新结果。

控制服务内部入口为`POST /v1/compat/experiments`、`/evaluators`、`/diagnosis-runs`和`/benchmarks`；领域内校验真实actor、workspace、操作能力、lease/fence及来源生命周期。`read_view`只装载目标实验，历史趋势单独走`baseline_view`。`lookup_operation`精确匹配actor、kind、key及原请求hash，在读取最新资源前恢复既有回执；诊断使用`lookup_submission`。网络丢响应不等于失败，不据此重发Agent命令或生成新评分。

`AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE`须指向绝对路径、非符号链接、权限0600的常规文件，内容为64位小写hex随机值；仅服务端持有，不写入页面、数据库或RunPlan。证明绑定purpose、真实principal/workspace及精确HTTP body hash。执行/清理事实、私有资产封存、Workbench验证和Issue解决分别使用受控用途，公开body自称可信无效。模型`model-connection/v2`仅保存配置ID、脱敏URL和连接指纹；指纹包含有效自定义headers但不保存其明文。旧v1指纹仅在当前headers为空且原连接完全一致时兼容，避免配置漂移。

普通业务本地执行Trace可供组管理员按业务ACL读取；Judge与诊断Agent自身Trace为私有记录，管理员不能因此读取参考答案或私有gold。已封存来源内容推进不改变旧输入；来源撤权、删除、incarnation或路由epoch变化会阻止继续读取、领取、完成和CH发布。CH accepted与published分开检查。凭据撤销后的既有未发布事件保留等待处理，目前没有公开重新授权该事件的操作。

评分事实、指标与选择完成后，投影器在同一受租约保护的Outbox事件中保存精确的索引进度。整个RunPlan仍在等待执行终态或其他结果时，事件按1–60秒退避保留pending；恢复时不重复写已确认事实。多Case人工评分分别确认指标与选择，随后共同发布，不能互相等待对方整批发布。早期已sent但缺发布成员的历史事件需显式受控回填，不自动改写旧事件。

Benchmark专用Case重跑以旧执行job和选定机器结果CAS建立新执行身份、RunPlan及递增attempt，复用父计划冻结模型、release和配置；imported提交禁止Agent重跑。pending准备意图可由原actor后台独立恢复，只有未封存外部请求的纯准备可在租约过期后提升fence重领；未知派发不会另起外部attempt。未知清理的Agent/Harness持续占额度，exact cleanup receipt确认后才能释放或重跑。

Benchmark回调使用有限期、任务/attempt/fence/epoch绑定的capability，执行回调还要求真实设备身份及精确body证明。公开cap不能领取内部私有工作，内部`load_*`、规范化和评测计划需要控制器证明。013保留012 checksum并允许空stdout/stderr制品。014派生Issue解决为独立只追加注解，不改变机器证据。Benchmark、Workbench剩余链路与实测范围以实施状态为准，不由表结构存在推定全部功能已接管。


### Workbench、A/B 与候选验证消费者

原 Workbench、触发分析、灰度 A/B、实验复测页面和字段保持不变。Experiment/Case、机器结果选择和 RunPlan 使用 core；Skill/模型、WorkbenchTask、GrayscaleTask、OptimizationRecord 与静态质量评估暂保留所属独立控制域，不能把这一边界描述为全部旧表已迁移。所有跨域请求使用已验证的真实 actor/workspace，Task 中保存的实验 ID 也必须属于该 actor。

创建使用签名的 prepared Task intent → typed core 精确创建回执 → Task CAS ready；中断后重放原冻结配置，不重新读取最新资产。后置会话/优化记录关联独立 CAS 恢复。原 Task JSON 的分数仅是当前 Case、实际执行身份与 selected machine receipt 的派生投影，重评和新执行等待期间不复用旧缓存分数。

执行、基线验证与候选复测读取实验封存的 Dataset release，后续编辑评测集不会更换既有实验的输入或标准答案，也不会覆盖编辑态缓存。独立灰度任务显式新一轮启动时先读取当前评测集并封存本轮版本；同配置克隆仍继承来源版本。全局取消只约束当时的 RunPlan，显式新计划不继承旧全局屏障；样例删除的逻辑 tombstone 持续有效。

版本分析的原比较和版本详情 API 使用已验证 actor，从新 Trace/版本标签与当前选中机器结果计算原指标；人工分 0、无分覆盖率、root 筛选和问题下钻口径保持不变。即使管理员可读其他成员，也只纳入自己的版本标签、Trace 和实验结果，查询参数 `user` 不扩大范围。内部通过真实 canonical Trace 身份关联 native/legacy alias，不查询旧 Execution/Tag/评测结果表，内部身份不加入原公开 DTO。来源删除或撤权后不再返回对应 Trace/分数。

客户端与本机 Agent 都先保留真实执行目标/attempt，只有业务 Trace 真正完成并 indexed 后才提交评分。原本机 Agent 运行器保留；取消等待真实进程组清理证明，跨实例/重启后未知的本机目标保持 pending。丢失完成响应只查询或重投精确回执，不重新运行 Agent。

候选行为验证沿用原筛选和判分算法，验证证明另以 `workbench-verification/v1` 绑定 actor/workspace 与 source/candidate/hash 签名。临时验证实验归档只更新优化记录的可见性引用，普通实验列表和 Workbench 都隐藏它，真实事实与合法证据仍可复用；真正删除或来源撤权则使证据失效。静态质量评估旧域、生产数据导入、跨实例本机执行恢复与千级容量仍须各自验证。
## 实验优化点与 FI 收集

core 模式保留原优化点与优化计划入口。动态/触发问题来自当前选中的机器结果及其不可变派生注解；静态扫描与用户反馈仍在原控制域，页面读取不会补写旧动态结果。普通用例和触发评测沿原归因与去重规则生成问题，纯输入评测没有 Trace 时，详情明确返回空的执行/轨迹引用。

FI 收集回调只确认收集事实。实验的 Trace 就绪与 Case 关联由实际执行 worker 在新观测存储读取真实业务轨迹后完成，不以回调内的 interactions 替代采集数据，也不回填历史旧数据库 Case。

切换后的迁移前指令晚到回执仍正常完成原客户端控制指令，但不再更新旧 ExperimentTraceAttempt；新 core 指令和历史未标记指令均受此保护。legacy 模式保留原回填规则，core 的业务 Trace 绑定只由新存储 attempt 的精确回执完成。

同 Skill 版本的触发问题默认只显示最近一次已完成机器评测的发现；新一轮成功且没有问题时，旧问题退出当前待处理视图。该替代前沿只读计算，不新增解决注解；历史视图中的解决时间仍只表示真实解决记录。静态 Evaluation 详情仅在明确的静态、无 Execution 控制域及原 Skill/owner 可见范围内读取，其他详情严格走 typed 来源，故障或拒绝不会回退旧动态表。

## Trace 流程匹配与归因

原 `analyze-match` GET/POST 与页面 DTO 保留。core 模式从已授权的新 TraceEvidence 冻结业务输入、Skill 正文和版本、ParsedFlow 与模型选择，以内部 `trace-flow-analysis` Experiment/RunPlan 分别保存匹配和可选归因；该容器不出现在普通实验/Workbench 列表或分页总数中。原匹配、抽步骤、归因、质量维度优先级和评分算法继续使用。静态 Skill/ParsedFlow 留在原控制域，动态 ExecutionMatch、TrajectoryEvalResult 和 Evaluation/Issue 不再影子写入旧表。

同请求恢复使用封存资产和实际机器回执。模型请求先记录 intent，确认响应及 indexed 录制后记录 observed；恢复复用 observed，未知 intent 保持 pending、不自动重发或反复创建 attempt。可选归因 pending 时，来源与当前匹配 selection 重新验证成功后仍返回已完成匹配；归因结果仅关联其精确来源 match。Trace 后续增长不改历史输入，GET 的更新提示仍按当前 interaction 数量计算。来源删除、撤权或 Skill 范围失效后拒绝读取/恢复。固定 Mock 的真实链路验收不代表实际模型质量或生产容量。

原通用`POST /api/experiments/:id/run`在core模式通过typed Benchmark启动，保留`202 {status, runId, alreadyRunning?}`；Case重跑仍返回`202 {kind:"benchmark", status, runId}`，不在公开响应返回后台Promise。


### 统一授权统计接口（015 / CH002）

上层 `readCoreAnalytics` 按已验证 workspace 调用私有 `/v1/compat/analytics`，统一提供窄 Execution/Session 统计投影、真实 RAS 事件与当前结果富化。Dashboard、Fleet、Task Insight/Stats、Quality 三个原接口继续复用原聚合、DTO及前端。Quality 沿用现有账号 Key，通过原 apiFetch 自动携带；查询 user 不再是授权凭据。注册配置限定当前真实账号（Quality 保留公共 NULL 配置），不会因共享 Trace 展开整个 owner 的配置目录。原生 Agent 可由已授权观测事实补充平台，不造注册行。

`prepare` / `publish` / `prepare_sources` / `ras_ingest` 要求 actor 和 `trace-analytics/v1` 私有控制器证明。`read` 支持绑定游标的时间/Agent选择；已有摘要严格匹配真实行和 Session 时间，未就绪源只在权威时间边界可证明不相关时跳过，否则保守 pending。`validate`、`validate_enrichment`、`validate_ras` 在最终返回前重新核对源、当前机器选择/问题解决/诊断头、资产 ACL 和 RAS 当前回执。统计读不读完整 Trace、Span 正文或 RunPlan。后台构建从哈希与版本已核验的 prepared source artifacts 取真实交互，沿用原 callStats、错误分类和 Agent 树算法；默认其他 TraceEvidence 读取仍核对 CH 正文。

首次未就绪返回 503、`code=ANALYTICS_INDEXING`、`Retry-After: 1`。原 apiFetch 只对该标记的 GET 在15秒内重试，退出、切换账号或取消时停止；成功 DTO 与页面布局不变。后台同一源版本任务合并，瞬时失败退避，确定的正文/摘要预算错误不会被每秒重新解析；新源版本重新建立任务。

保持原接口的不同统计口径，包括 Dashboard 的原始 cost/答案正确率、Fleet 的价格重算/工具失败判定，以及当前 latency 原值与接口解释；本批不顺带修正历史 Fleet 单位差异。明确的 Trace 级 legacy 指标可保留，未声明的原生逐 Span cache/reasoning 不假定为 Trace 总量；冲突来源明确失败。

预算：每 Trace 构建128MiB/100000 Span，持久摘要2MiB；页超限自适应缩小，总枚举100000 Trace。这些上限是读取护栏，不是本版容量验收指标。构建要求稳定的 prepared source 版本；持续高频更新可能使 CAS 重试并暂时 pending。第一版以原有功能等价为目标；万级Span专项、增量统计、水位快照与千级混合负载优化统一放到第二版，不把本批消费者接通当作容量目标已经验收。旧库全量迁移仍只有只读计划，没有 apply；RAS 事件 POST 与 Fleet 读取已接入，RAS 专题页的其余旧控制消费者按剩余清单推进。


第一版后续消费者：Skill列表和版本页的调用量、成功率、P95及趋势，以及Agent管理页的调用统计与自动发现，已改用授权新存储。静态Skill/版本/静态评估/RegisteredAgent仍由原控制域保存。版本页仅为显示的执行记录读取完整输出；原有无Session执行仍可展示，不伪造轨迹。

内部取证端口`/v1/compat/observe/evidence?view=execution`返回`agent-insight.trace-execution`，包含原Execution、来源清单及独立内容摘要，不含Session；默认完整Evidence仍要求真实Session。Agent元数据通过现`analytics`端口只读`agent_metadata`动作读取（每批最多200个Trace/boundary），只发送真实身份及注册必需小字段；根身份不从后代Span猜测。旧登录映射的静态Owner与IAM规范用户名分别保留：只对本人来源补注册，不把共享Trace变成本人的Agent。没有新增表或迁移，现015/parser1保持。

### 运行记录、可靠性与答案评测

Skill runs/logs沿用原筛选、版本、分页、状态与评测快照算法，从授权摘要选定真实执行，再读取完整Execution；无需Session的执行记录仍可展示。已知历史主版本不因重评或最新Skill定义变化而覆盖，实际调用版本单独保留；未知版本不做读时回填。

RAS专题读取通过现analytics端口的`ras_read`/`validate_ras_read`读取真实事件，包含先于Trace到达的事件；按真实Owner、task及当前授权匹配，组内管理权限不能读取他人的私有Judge轨迹。专题保留原倒序，Trace可靠性详情保留最早200条的升序窗口和中英文DTO。读取核验receipt、CH正文hash及当前来源，返回前复核执行Evidence和事件选择；原完整字段超预算明确413。事件页最多10000条，类型筛选最多扫描100000条回执、共享60秒预算，签名读取token最多3MiB；这些是护栏，不是容量验收指标。FI Trace页面的动态Session/RAS也使用新存储，FI控制记录和原模型/marker优先级继续保留，FI marker不会变成真实RAS事实。

独立rejudge、Final Result编辑与取消复用内部`trace-outcome` Experiment/RunPlan。编辑和持久任务同事务交接，取消/替换通过现lease/fence阻止迟到结果；首个无任务取消也保存精确操作回执。模型选择与实际来源封存，observed响应恢复复用，未知投递保持pending。仅专属Outcome结果可覆盖答案字段，普通实验分数不会当成答案分；真实0分与未知null分开。Trace列表、Skill记录和统计读取同一当前选择，并复核其签名边界；统计读取不加载完整RunPlan或Session。

Query编辑不启动模型：同事务保存新query、按原算法重算的路由标量/快照、清分标记及取消事实；新一代成功结果才覆盖该标记。无真实Skill调用时，原路由标量可为null而快照触发率为0，保留两者含义。上述操作以真实凭据授权，仅Trace本人可重评、编辑答案或取消；查询/正文中的user不扩权。没有新增表、迁移或前端布局，其他控制域及完整历史导入仍按剩余清单推进。


### Batch Trace 用例分析

原 `debug/batch-tasks` 的 Trace 模式 evaluate、单条 retry-evaluate、abort 与进度读取已接入 typed Experiment/RunPlan/worker。凭据解析的兼容账号限定 Batch 控制记录，Trace 来源必须属于同一主体，Skill 必须使用明确版本。启动成功前会持久记录 backing Experiment/Case 绑定并建立 durable 工作；读取只投影当前 typed 结果凭据，保留原扁平状态和数值均分口径，0 分仍表示评测已完成。取消保留已经完成的兄弟结果，重试只替代所选 Case；取消后仍可评测新 Trace。

Trace 启动/重试使用 `idempotency-key` 标识一次操作；客户端仅保存最多 32 个请求哈希、操作键及时间。网络或响应体丢失会保留该键，收到可解析且 `ok: true` 的完整 JSON 确认后清除，下一次明确操作使用新键。服务器以持久操作键恢复原 start 回执及工作，不重复封存或发模型。原 `startedAt` 来自当前工作创建时间，完成时间来自当前工作/attempt metadata；内部 `coreWork` 不进入公开 Experiment DTO。

BatchEvalTask、Skill/版本仍使用原静态控制存储。Dataset 执行与评测链路见下文 Dataset Batch 一节；完整旧库语义导入仍未完成。

Batch 请求还会通过现有私有 Experiment RPC 的 `batch_scope` 固定动作核验凭据的实时权限：读取需 read，创建/配置更新/取消需 read+write，执行/评测及重试需 read+write+execute。身份相同或 workspace 角色相同不能替代凭据权限。读取绑定时仅在实时 owner 校验证实 backing 已删除后隐藏该项；不存在、未迁移或属于他人的绑定继续明确失败。


### 普通 Trace 的主 Skill 与历史评测字段

原 Trace/Case 列表从已校验来源补齐 `skill/skill_version`、`root_skill/rootSkill`、`invokedSkills/invoked_skills`、历史答案/Skill评分、原因、失败、Skill issues、路由正确性与原可选 token 指标。根执行自身主 Skill 优先，之后仅接受显式 ExecutionSkill primary，再用自身真实引用兜底；未知版本保持 null，版本0有效，不查最新版本回填。当前专属 Outcome 在源历史字段之后覆盖，Query reset再清答案；一般 Experiment 的分数不能充当答案评分。

现 analytics 私有RPC的 `execution_metadata` 每批接收1..200个 Trace/boundary，保留 IAM 和来源版本前后校验。响应连封装最多8MiB，同次列表所有分页实际读取的工件文件字节累计最多128MiB，超限413而不返回部分成功。只发送字段白名单，不返回 Session/query/output 或组装完整Trace/RunPlan；原失败与Skill issues业务内容仍保留。读取不可变 carrier 工件可能反序列化包含Session的字节，并枚举Span元数据，不能称为零正文读取。既有parser1无法证明缺字段等于空值，故本片没有把旧摘要直接当完整历史字段缓存。没有新表、迁移、parser版本或前端变化。

Skill筛选区分明确的关系空数组与未捕获关系：前者不匹配任何关系Skill，后者按真实主引用降级；facet仅在整个可见关系集合无Skill时按主引用降级。当前Outcome明确投影调用引用时，列表、facet和版本筛选使用同一当前值。缺失的源集合不覆盖已捕获的compact集合，未知值不补当前版本；私有Judge仍在授权列表SQL中排除。


性能验证边界：本片隔离环境32条可见Trace的原列表在本任务全量门禁结束后读取约4.1–4.9秒；多套全量测试同时运行时曾触及原15秒请求上限并返回502，原页面错误处理显示空列表。未扩大请求超时或放宽来源一致性，也未完成混合并发容量验收；这一成本与后续优化需求须与功能接通分别看待。

### 第一版 Dataset Batch 执行与评测

Dataset 模式的原 start、retry-execute、retry-evaluate、abort 与平面进度已走现 Experiment/RunPlan、本地执行和可信 Trace recorder；原页面、状态名与响应形状保留。Batch shell、Skill/版本仍在原静态控制域，动态执行/评分不回写旧 Execution/Session。可信 Agent 录制把明确的 skill_version 映射为 Trace 的 skillVersion，保留版本 0；缺失/null 不补最新版本，也不改写已录制历史。

- 新逻辑 start 可在同 Task 选择新增用例或当前 Dataset 版本；多个 Dataset 在一次 typed 读取中固定各自 release、输入与 gold，再封存本次 RunPlan。未选中 Case 与旧 RunPlan 保留。单行重试使用该 Case 当前 execution slot 绑定的原 execute RunPlan，不能转到全局最新 Dataset/模型/评估器。
- 返回成功前，shell prepared 意图和全部选中 execute work 已持久存在；只读校验固定版本及全部选中 Case 后，先 CAS 预留 Task，再更新定义并事务性批量 upsert Case，其他请求不能覆盖准备中的状态。明确失败仅在未提交 Case 批次时释放本次准确空预留；不清理其他意图，未知投递仍保留预留。相同操作先查准确回执；丢响应或最终 shell ACK 失败仍恢复原 run，不再启动 Agent。只读 GET 仅投影进度，不领任务或启动模型。
- autoEval=false 的执行完成停在 executed；未建立评分 work 的占位槽为 skipped，不冒充正在评测。之后 retry-evaluate 仅评原 Trace，保留执行耗时；0 分是有效完成，null 不补为 0。各 Case 使用自己冻结的评估器列表，后续全局配置变化不抹掉未选中 Case 的旧结果。
- 现私有 start/execute_start 的 source_execution_run_id 仅接受选中 Case 当前绑定的 execute run，服务端重新校验 owner、来源、权限与版本，再从原计划取配置和输入；派生计划记录 parent_execution_run_id。已有 purpose 的 controller proof 绑定该引用及 runtime 起止 checkpoint；普通 API 调用不能伪造可信运行时长。
- 自动评测子计划使用父 execute plan 的固定 input/gold/context，加上实际 ready Trace/输出；当前 Case 的用户编辑继续保留。coreExecution 是私有投影，按当前 slot/work/attempt 派生，默认公开 Experiment DTO 不包含它；同次快照按 run 缓存已校验计划，保留 0、空串、null。
- 取消先写持久 fence，再核实物理退出；完成兄弟结果保留。已完成本机进程的丢失 checkpoint/完成回执可在同实例复用已观测 Trace，先按原键和原时间戳重放 waiting_trace checkpoint，再提交完成，不重跑 Agent。有界本机恢复表仅淘汰已结清项，未确认回执保留，满时在领任务/模型执行前返回 503。硬重启后缺失旧进程退出证明时仍 pending/503，不能以租约过期代替清理证明；queued 未启动工作可由原操作 POST 恢复。
- 客户端为 start/retry-execute 复用现有摘要/UUID 意图；只有严格 ok=true 的 abort ACK 才清理同账号、同 Task 的待确认意图，随后相同用例可显式启动新任务。存储仅保存有界 hash/key/时间与 scope 摘要，不保存正文或凭据；失败、坏 JSON 和其他账号/Task 不清理。

本片的最终真实 HTTP、本机运行器、原界面与全量/三库验收由实现状态页记录。没有新表、迁移、parser 或前端布局变化；静态控制域与全部旧库语义迁移尚未完成。


### 第一版原 Trigger 评测主链路（已隔离验收）

原 Trigger API 在访问静态配置前校验实际 IAM，兼容账号仅供静态归属和原 DTO 展示，请求 user 不授权。每次 Run 使用独立私有 Experiment 和一个聚合 evaluate work，成功返回前已持久建立。重复操作恢复准确回执；同主体/Skill/版本 active 返回原 409+run；不同版本可独立运行。通用 Experiment 列表/统计不包含内部 head。latestOnly 仅取完成 Run。

计划固定测试集版本/查询、目标 Skill 版本和完整内容、竞争 Skill 启动时内容、被测历史、模型摘要和参数。执行沿用原多查询/多采样/重试与 description-only 物化，不改路由判定和原零值语义。每个样本先保存 intent，真实 Session 消息全部 indexed 后才删除 Session 并保存 observed，物理退出确认后关闭运行；决策延迟不含录制等待，恢复沿原完成顺序且不重采样。未知投递或硬重启缺退出证明返回 pending/503，不能因租约过期重跑；明确未 send 且确认退出保留 failed。读取结果检查实际采样 Trace 的当前授权和来源，GET 不启动模型。

取消使用持久 fence 和准确 attempt 清理证明。原 success=true ACK、原 DTO 和页面保留；客户端仅按可信操作摘要清除对应的待确认启动意图，不清其他版本。未配置模型 key 时不新增空/占位认证。

A–E 已完成独立复核及隔离验收，包含起草/删除；未切生产。静态 Skill/版本、UserSettings、TriggerSet 及旧历史语义迁移继续按原边界；最终原 HTTP/原生 Mock/界面和三库门禁见[实施状态](../../../../design/platform/analytical-transactional-storage/implementation-status.md)。

Trigger 启动的私有 RPC 序列化包含原 HTTP 幂等 key/request，网络重试不更换意图。客户端仅收到 success=true 及对应 Skill/请求版本/测试集的完整 Run 或有效版本 Set 后清理待确认操作；仅 ID、不完整 DTO、坏 JSON 或响应丢失均保留。取消 ACK 还须匹配准确 Run ID。内部 Trigger 在通用 list 默认和按 ID read_view 中同样隐藏，专用 Trigger 历史/详情保持授权读取。


### 原 Trigger 聚合优化点与解决记录

原 Trigger 每次最多生成一条聚合问题，沿用原 summary、evidence 和 suggestedFix，包含实际测试版本的 description 和其他被测版本历史。dedupKey 为 trigger:<skillName>，generator 为 trigger-evaluator@1.0，runId 为原 Trigger 历史 ID；ruleId、dimension、reasoning 仍为 null。全通过且无竞争不创建新问题；全通过但仍有竞争 Skill 会生成 low 问题。

机器完成、新问题和旧 typed trigger 问题的自动解决同事务提交。解决状态使用正式幂等回执与 014 注解，保留 resolvedAt、resolvedRunId 和 includeResolved 历史；失败/取消/迟到结果不清旧问题。派生列表、详情、当前 frontier 与手动解决均检查实际 sample Trace 的当前授权和来源。原优化点入口继续读取合法旧 static/feedback，旧动态 Trigger 历史需单独语义迁移，不作普通查询回退或读时补造。AI 起草及测试集删除清理见下方 E 复核切片；本片未切生产。


### 原 Trigger AI 起草与测试集删除

起草继续使用原 direct 模型调用和提示：要求18条，但原解析只要求合法非空，合法两条也可 ready；新版本不合并旧 user-edited 条目。稳定占位与独立 typed work 在确认前建立，固定 Skill 正文/版本及模型摘要。真实 direct JudgeTrace indexed 后才保存已观察响应/失败；未知提交和5分钟旧占位不触发盲目重投，恢复不会再次调用模型。原成功、冲突和版本 DTO 保留。

完成以 owner/版本/状态/原时间和原字节作精确 CAS；重复完成确认同一 ready/failed，用户编辑冲突保留原数据。typed 结果与静态投影分别幂等，不承诺跨库原子；授权 POST 可恢复确认，GET 只读。

Set DELETE 保留原行为：只删测试集版本，已有 Run/Evaluation/SkillIssue 历史不删除，在飞 Run 沿封存测试集继续。仅缺失占位对应的 draft 被精确 fence 并确认停止；迟到激活重新检查占位，完成仅 update 原行，不会重建已删占位。新起草保留既有 ready 版本；显式 DELETE 按原行为删除所有 Set 版本。原页面不变，无新 schema/purpose/parser，最终隔离验收通过前不切生产。


原 Trigger 历史读取遇到明确的 head 版本瞬时变化时，helper 仅通过白名单代码 TRIGGER_READ_CHANGED 传递精确重试标记。客户端只对 GET /trigger/:name/runs 的该409在原15秒预算内最多重试3次，核对当前凭据/账号并尊重 Abort；耗尽或其他读取错误进入原页面错误分支，保留已显示历史，不把错误数据当作空列表。普通409、权限/删除/来源错误不重试；启动/取消等写入冲突与其他路由不变。


起草 ready 确认使用稳定的 Item 结构比较，避免 Python JSON 对象键排序导致同一结果误报409。对象键顺序和线上不存在的 optional undefined 不影响确认；数组顺序、真实字段值和 null 保留，用户编辑仍冲突。原 SQL CAS 条件及 JSON 存储格式不变。


### 公共采集身份预检

`resolveCoreCollectorIdentity` 验证实际 API 凭证或 OpenCode 注册设备凭证，生成只在服务端有效的冻结身份。请求正文的 user、authenticatedUser 或 clientId 声明不授予权限。现有私有映射保留旧用户名与 IAM 主体名称的区别；设备归属须唯一映射到当前 principal/workspace，匹配归属的映射凭证全部核验，其他归属的撤销不影响本次身份。每归属至多16个不同映射凭证，超额明确失败。直接 core API 未提供可信旧别名时保留 IAM 用户名。

`POST /v1/compat/collector-source?workspace_id=…` 的 `scope` 动作仍只接受不超过4096字节的 `{action:"scope", operation:"snapshot"|"complete"}`。服务端校验 API 类型、当前凭证 capability 与 workspace 角色均允许 write，返回对应主体/空间/操作的授权声明；不写 source/Trace/receipt，也不接收工作或诊断上下文。仅查看 `/auth/me` 的角色不能证明 API 有写权限。

API 与设备均有效时须指向同一主体/空间，旧别名允许不同，实际 token 仍由 API 提供，旧静态归属取已核验设备映射。无效 API 的401可由有效设备补足；已认证 API 的403不借其他凭证绕过。无效设备可由有效 API 补足，但不绑定其 clientId；已核验设备的旧别名映射缺失、歧义或不可用则拒绝。上游不可用不降格成无效凭证。proxy 调用方须显式使用 `authorizationKind:"provider"` 将供应商 Authorization 排除于用户鉴权之外，另以 x-witty-api-key 表达采集身份。

身份通过品牌检查，复制对象不能充当可信身份；token 只保存在私有闭包，不出现在身份 JSON。`withCoreCollectorIdentity(identity, (actor, options) => …)` 的私有调用方须将第二参数的固定 origin `options.fetcher` 用于后续 RPC；接收端仍在真正写入事务内重新检查 IAM，预检不是持久授权。`revalidate()` 与私有回调入口在接受数据前重查原凭证、设备撤销、映射和当前 write 权限，主体/空间/别名/绑定变化拒绝，配置的 core origin 变化也在每次实际请求边界拒绝，避免跨实例发送旧凭证。原 upload、completion、proxy、logs 的开发接线见本页末节；幂等/成功 ACK 闭环、旧 spool 身份清点与迁移清单见[实施计划](../../../../design/platform/analytical-transactional-storage/phase7-consumers-and-legacy-migration.md)。


### 公共 Source 快照与完成意图

同一私有端口新增 `reserve / commit / complete / status / reject_preparation`，均要求实际 API write 能力，以及绑定请求原始字节、实际 principal/workspace 的 `collector-source/v1` 控制器证明；普通 OTLP 不能声明保留的 `collector.source.v1` namespace。没有新增表或通用 OTLP 删除属性。公共入口复用此私有基础，接线与集中验收边界见本页末节；前端界面保持原状。

- `reserve` 封存原请求、默认接收/完成时间、基准 Source revision 和独立 task/首个 canonical execution 别名；已有 task 的新 upload ID 不替换 canonical execution。相同 key 的原请求变化409；当前设备凭证变化不改变既有意图，私有响应返回第一次封存的设备/账号来源，当前 IAM 仍重查。较新请求可先恢复同 owner/source 的旧持久意图，不追溯授权旧 spool。
- `commit` 接受原 portable `{execution, session}`，按准确 revision CAS 保存快照、实际分包及 Outbox；快照零值、nullable framework、完整原消息和扩展字段保留。先按原 commit 请求哈希识别重放，再读取当前完成状态，因此旧 ACK 重试不改写新快照。设备绑定只来自首次封存证明或先前可信绑定；已有设备保留原先优先规则。工作/诊断上下文和特权来源不能由公共快照声明。
- 完成通知先到时仅持久化 locator/ACL/别名和固定时间，不创建伪 LLM、Tool 或 CH 交互。bucket 一次确定，后到跨日快照复用。已有 Session 的完成变化仍需实际分包 indexed；缺失 interactions 与已有 Execution 无 Session 时的原空 Session 创建/default clock 语义，由公共适配保留原语义。
- 私有回执会区分 reserved/accepted/prepared/indexed/failed。公共上传必须等所有分包 indexed 才返回原成功 ACK，不能把私有 RPC 200 或空 completion 意图的 durable 状态当作普通消息已入库。
- 允许缩小的快照使用更高 revision 的 source 专属墓碑，保留旧 head/工件。当前 Evidence、生成、RAS 和兼容读取只排除经过私有 ledger、head hash 及不可变 `is_deleted` 来源核验的退役实体；完整 head vector 继续作为来源变化 fence。稳定实体 ID 与当前消息顺序分开，原 index 校验后排序；缺失/重复顺序不回退猜测。原 Langfuse 次要交互、主节点及原 portable 导出保留，导出采用实际校验过的 capsule/原条目并尊重人工覆盖，不从 compact 摘要补造原值。
- 完成消息不意味着会话结束：Source Session endTime 为空时保留 running 状态，完成通知索引后再变更。缩小后重新计算当前计数、边界和元数据 provider，移除旧模型/技能/错误来源；元数据与真实工具 carrier 不冒充额外主交互。多包未全量 indexed 的当前摘要/读取返回503，实际来源在读期间变化409；仅 reserved 的下一意图不遮蔽旧已索引视图。通用 OTLP 流式读取保持原规则。
- `reject_preparation` 只终止尚无提交/分包的 reserved 意图，要求原封存 input hash 与 `INVALID_SOURCE_INPUT` 或 `SOURCE_BUDGET_EXCEEDED` 枚举，保留原文/失败回执并 fence 迟到提交。模型/配置暂不可用、网络/CH 故障及权限失败不能借此丢弃意图；旧失败重放不能清除新 pending。

输入/单快照为16MiB、私有计划64MiB、每包256实体、每 Source 最多100000个保留实体及4096操作回执；超限明确拒绝，不剪裁正文。它们是当前正确性边界，不是容量认证。原业务静态选择、消息合并/派生子 Agent/线程、异步分析 fencing 及原入口 ACK，继续按[迁移计划](../../../../design/platform/analytical-transactional-storage/phase7-consumers-and-legacy-migration.md)实施，旧数据和生产未切换。

已发布且具有非空 head 的 Source 必须存在匹配的真实 CH 摘要。合法 status/agent/search 筛选可能排除该行：只对缺失的已知 Source ID 做一次有界、去掉这些筛选的存在性查询，校验空间、namespace、native ID、bucket 与 revision，并在查询后再次核对来源边界。真实摘要缺失返回503，不能伪装 accepted 或空列表；存在性查询的行不加入筛选结果。没有 head 的空 completion/未提交意图仍允许没有摘要。

原私有 Span Session 传输继续服务普通core Trace；collector公共Session另从source读取原Node表示并运行原payload version与结构交互投影。原portable导出保留完整原快照；原DTO、缓存和原界面的完整等价性仍待集中验收。


### 公共采集的共享准备

原 upload 的 quick Skill/version 选择与 legacy save 现在共用确定性准备函数：保留原 adapter 归一化、单调合并/允许缩小、query 保护、显式 label 版本重写、版本0、OpenCode 指标与 Langfuse 原树。legacy 入口仍使用原持久化与分析副作用；公共采集接线复用这些共享逻辑，前端不变。

`captureCoreCollectorPreparation` 只接受服务端品牌采集身份，在当前权限复核下捕获本次相关 Skill/必要版本、实际命中的 routing/outcome 配置、这些配置真正需要的静态 ParsedFlow、相关注册 Agent、单个 Skill 分数及 autoEvaluation 开关。模型仅保留既有 `freezeModelSelection` 的非秘密连接摘要；API key、Authorization、自定义鉴权头及完整 UserSettings 不进入准备产物。没有遍历全部 Skill 版本读取 ParsedFlow。

`prepareCoreCollectorSnapshot` 使用捕获值、原请求和 Source 前态，计算 root/Session、逐层子 Agent 及各层 Skill、Thread/event 计划与具名后置处理。计算阶段不读取数据库/当前配置、不调用模型，也不选择新的当前时间；默认 Execution/Session 时钟来自第一次封存的 received_at_ms，显式时间保持原值。绑定校验包含 task/canonical execution、operation/input hash、base revision，以及原请求和接收时间/完成时间/来源/前态的独立摘要；改包、换前态或默认时间不得沿旧准备继续。该绑定用于完整性校验，本身不授予权限。

threadOnly 保留真实线程计划且没有 Execution/伪 Span；更小快照被原护栏拒绝时，仍保留原先在护栏之前产生的线程写计划。completion 的纯准备保留已有 Session 字段，缺失时给出原 label=opencode、空 interactions 和首次默认 startTime 的 Session 计划；无 Execution 时不补造 Execution。未关联父级的 Codex pending 单元也不转成普通根执行。

016已封存首次capture/plan及独立Session，017继续接通私有子Agent图和Thread/event/member控制效果。实际 `execution_match` 的typed Flow生产者、原公共Session DTO/handler/异步分析仍待C2/C3；这些输入不允许回落旧动态表。原界面与公共采集入口尚未切换，新片段只完成逻辑和快速专项，完整验收待剩余接入后集中执行。

共享 Session 准备区分旧存储表示与已验证的 canonical 表示：旧 interactions/graph JSON 可以损坏，正常 metadata 或消息更新不得额外解析、清洗或覆盖无关旧字段；只有确有 incoming Langfuse nodes 数组时，才沿原条件尝试解码旧 graph 并合并。core 直接传入已校验的数组，不借共享准备自动迁移旧坏 JSON。框架能力按实际字段覆盖语义选择：未传 framework 继承前态，显式 null/空串保持 Generic，不能用逻辑或回退。

静态捕获先读取仅含 name/id/activeVersion 的轻量账号目录，按原 JavaScript 大小写匹配及原先后选择 ID，再读取选中 ID 的轻量版本号和必要版本正文；不通过旧 findSkill 连带装载全部正文。routing 的精确名称版本回退另用定点轻量元数据，不与业务 Skill 的折叠大小写选择混用。Thread 计划仍按原 raw 阶段的 framework/身份条件生成：incoming 自然线程使用对应可信 lookup ID 或稳定新 ID，不能无条件复用旧 Thread ID；复用已有线程时，projection.threadId 必须来自该 incoming 自然键的受信读取。缩小护栏前真实发生的 Thread 计划仍保留，但不改变被拒快照的 Root 关联或新增后置 reconcile；pending-parent 更早停止，不产生 Thread。


### 016 私有采集准备

`collector_preparation_receipts` 仅封存首次原 Node 输入字符串、读取前态、capture 与完整 plan；实际接收/物化状态继续由原 Source ledger 和 ingest_batches 决定。私有 `collector-source/v1` proof 仍绑定实际 API 主体、空间与精确正文，管理员不能代采他人 Source。begin、capture、plan 的重试返回首次封存值，Session 的原序列化表示仅从当前 revision 对应的已提交计划恢复；旧 A 或未准备写入明确标记 `legacy_canonical`。

空 completion 独立保存原 Session 元数据，不制造 Execution 或 CH Span；后到 snapshot 使用可信 previous_session 保留首次时钟。人工标注继续保留。C1a 只执行根 Source 与空 Session，非空 child/Thread/retirement 图明确 pending；ThreadOnly 可保留准备回执而无 Trace locator。私有回执的 `public_ready` 保持 false，集中验收通过前不表示生产可切换。016 必须显式升级，不重写旧 A 回执，不是生产切换。

接管旧 A 的未提交 reserved 操作时，包括恢复旧 pending 意图或已有准备回执，begin 在同事务持久化封存守卫，旧 commit/complete 不能绕过计划。失败时准备回执和守卫一起回滚；已经 committed 的旧历史保留原状态与回放兼容性，仍标记 `legacy_canonical`。


### 017 私有采集图与原Thread控制

017增加 `collector_trace_threads`、`collector_trace_thread_events`、`collector_trace_thread_executions`，保存原自然Thread身份、事件和Execution成员；不增加CH表或新的graph ledger。普通成员保留原source turn规则与undefined字段更新语义，不为sourceExecutionId加唯一约束。ThreadOnly沿既有snapshot写权限应用并通过现inbox幂等，无Trace/Execution/Span；公共pending Codex应由原上层先拦截，私有准备不能代替该入口护栏。

服务端typed `capture_graph_context` 捕获候选child前态、独立Session原表示及Skill来源；`seal_capture`同事务通过A pending预留实际候选/待退休意图，捕获失败全回滚。普通child输入不能接管parent graph的derived操作，须待图完成后重试。首次sealed plan原子提交root/child/Thread/member、退休墓碑和既有Outbox；各source保留自身batch refs，immutable descriptor只绑定完整vector，实际worker indexed才确认整图可读。旧indexed ACK不会重放或回退后续单独上报。

派生退休只作用于同root的真实派生集合，保留locator/alias、Session、工件及回执；可信墓碑隐藏Execution/列表，普通缺事实仍失败。每个child独立封存Session字符串，缺显式start保留首次Session时间；子Execution未写的旧评分/label/cost/sourceKind保留。Skill/origin复用原版本/dedupe/locator规则纯准备，完整投影存Source工件，小范围检索字段沿现Span属性输出；不新建技能关联表。

私有回执 `public_ready` 仍false；原公共API的core开发分支已接线，原UI与生产数据保持。当前为逻辑完成、待剩余链路接入后集中完整回归/三库/CH/迁移与原界面验收，不能将快速专项解释为全功能迁移完成。

### 公共采集原功能接线（开发实现，集中验收待完成）

core 模式下原 upload、OpenCode complete、proxy start/chat/end、OTLP logs/traces 和 Claude context 入口已接到同一可信 collector source。公共 OTLP traces 保留原解码、框架过滤、归一化、聚合与 Jiuwen 多桶缝合，避免同一客户端的 OTLP/snapshot 分别占用两种互不兼容的 task alias；专用 native core 入口不变。原 handler 的 ACK/flags、ThreadOnly、pending Codex、OpenCode 进行中及删除护栏继续保留。普通非collector core Trace仍走原已接读取兼容。

Session 页面仍调用原 Node 的 Claude/subagent/OpenCode/Dify/Goal/collaboration/payloadVersion 与各view流水线；`GET /v1/compat/observe/session-source`、`session-relations`、`session-sources`仅按当前read与Trace IAM返回原Session/Thread来源，允许合法组管理员读取、保留无Execution的Session；不使用采集write RPC替代公开read。详情/Skill部署读取完整source Skill/origin关系。懒query模型需要实际owner与execute；发布时再次核source/annotation/delete fence。

异步分析与proxy end复用既有Outbox和首次capture/plan，原Prompt/parser/模型算法保持，模型投递保存intent/observed checkpoint；只有显式配置的品牌owner后台主体具备当前execute时才能执行模型。上传者的write凭据足以接收/准备，ACK/capture不包含模型密钥。模型请求只发送显式认证配置。OpenClaw本地watcher/Skill-generation CLI需要显式可信default主体；SkillGenerator的OpenCode桥仍使用其同owner身份上报，独立owner spool，不能继承其他人的全局key。

日志先保存当前owner/controller证明及原包，再用原聚合器消费；确认游标必须绑定所有输出和退休事实的真实indexed回执，明确discard保留原因，pending/retry不确认。core启动不自动运行旧无证明spool consumer或旧全局backlog uploader，旧spool/cursor保持原样等待映射迁移。上述为开发接线；完整套件、真实三库、原UI、真客户端和迁移保留演练仍由最终集中验收覆盖，未切生产。

## Infra 原功能适配（018，逻辑完成待集中验收）

018增加infra_sources/session_infra_links两张事务表，CH另显式应用schema/clickhouse/003_infra.sql（或ClickHouseStore.initialize_infra_schema），总计71事务表+16CH；服务启动不会隐式改已有CH目标。升级沿既有显式备份/迁移流程，当前不迁默认库。原source CRUD、pull/push、概览、历史、导出、检测及Trace树自动/人工关联保持API/DTO和界面。原prom/OTLP规范化、直方图Infinity往返、counter窗口/重置、诊断和导出计算继续复用。

Infra概览、源管理/详情及Trace关联组件通过apiFetch逐次携带当前登录凭据，保留原API路径、请求体及取消信号。CSV/Markdown导出同样经鉴权请求后下载，沿用服务端文件名与原始字节；浏览器会先接收完整Blob，下载后释放临时URL，凭据不进入下载链接。界面展示与操作保持原样。

源按workspace/owner授权，组管理员可读组内源，写入要求实际owner和当前凭据能力。authHeaders只保存在私有artifact，Node侧经infra/v1证明读取，浏览器仅headernames/hasAuth；省略凭据不清除，null/空串显式清除。删除保留源/样本及人工关联物理历史，但已删源不可读；重新登记产生新sourceID，旧样本不复活。

core后台poller只使用私有身份映射中显式配置的各owner，并检查read/write；不会以管理员身份为他人拉取入库。无凭据metrics只有明确DEFAULT_INGEST_USER及其唯一私有映射可写；未配置或无法授权时仍保持原best-effort accepted/attachedTo:null且不写。该ACK不是durable/indexed证明；实际accept先同事务记录inbox/outbox和私有样本，worker完成CH发布后才是indexed，同次重试不重复样本，不同接收不按时间/内容合并。

Infra关联补读当前授权Trace boundary内的真实endpoint元数据，兼容旧已发布但无endpoint字段的v1统计投影，不改旧publication/parser版本，不将root endpoint猜给虚拟子Agent。SQL018与CH003及本批逻辑尚待最终集中三库/真实CH/全量/原界面及迁移演练；已做的快速专项不代表生产可切换。


RAS 删除保留历史事实并以 owner/task 删除屏障阻止迟到复活；关联 Trace 按当前 delete 权限退休。FI 使用019三个固定控制kind及私有领域动作，claim、停止和collect绑定实际owner、worker与当前lease，业务Session始终来自独立采集器。独立rejudge接口继续返回410，评测使用原实验评估器。

FI claim响应附加claimToken，新业务客户端将其透传collect；既有字段和UI不变。旧客户端首次当前lease可继续无token回调，重领后的不明旧回执返回409。独立Session即使无Execution也按原表示计数并随Trace删除屏障隐藏，RAS-only任务删除后首次迟到采集也被拒绝。所有逻辑接入后的三库、ClickHouse、完整测试、浏览器与迁移演练仍统一执行。

### 019 原控制数据与统一仓储

019新增`platform_control_records`，当前目标72张事务表、16张CH表。40种固定原领域DTO的488个字段、nullable/default、原唯一组和父子关系见[核心字段字典](../../../../design/platform/analytical-transactional-storage/core-table-dictionary.md#019固定payload完整字段)。Skill版本复用既有不可变release及稳定external-version alias；外部版本0和修改旧版本的原流程保持。二进制文件与mode存私有工件，授权后按core origin/workspace/principal物化真实目录。列表/计数先读轻量目录，仅选中的版本下载正文/文件，不回落旧Prisma库。

`db`及固定控制kind的`prismaRaw`方法每次读取AsyncLocal实际请求作用域；全局实例只缓存仓储。user参数只过滤/核验，不能换取映射token；兼容username与IAM principalUsername分别保存。记录CAS加实际读取kind的集合revision保留原事务，心跳不会使设置/Skill事务失效。仅固定kind/id/parent/元数据选择和受限批次经过controller协议，不提供任意Prisma where或SQL。正常读/write-prior/collector-preparation使用不同私有目的，服务端逐次核验实际权限；collector准备可在write-only上传身份下冻结相关静态依赖和非秘密模型摘要，不能替代execute。

Settings/SDK key保持私有owner范围，管理员Trace可见权不扩大模型或凭据读取。普通User读取只能回显当前提供的凭据。local用户名登录沿原standalone可信入口；organization/IDaaS仍先验证真实身份。新主体只有personal workspace，既有主体/key/权限不重置，不推断首用户为管理员。原客户端安装token一次消费，dc实际hash/owner/撤销/client绑定逐次验证。跨owner重绑须证明旧dc并原子撤销；无旧证明仍可独立注册新client，旧owner记录不变。设备不会收到owner SDK/API key。

原工作台、优化/生成会话、消息/blocks/VFS、候选、评测任务壳和调试结果使用固定控制记录，动态Experiment/评测/诊断继续用既有typed库。Agent删除提交既有Trace删除屏障及Agent软删除，工件保留；新用户原示例使用typed Dataset和既有Trace bundle导入。公开URL/DTO和界面保持，4个TSX仅加入请求封装导入，其中runtime provider另接动态header回调；不改JSX/CSS/文案/布局。SSE、AbortSignal和FormData沿原请求处理。

单次固定kind读最多20000记录、载荷128MiB、写批次2000操作；超限明确失败，不截断结果。这些是当前有界正确性保护，不是容量认证。019之后已进入集中验证；实际后端完整套件、PG/openGauss专项、真实CH领域读写及原界面部分流程已有隔离证据，完整覆盖和来源快照见设计实施状态，仍不切生产。历史任务的状态/时间由迁移保留；已有历史marker的控制记录不会进入自动执行选择、设备/install鉴权或Infra抓取，Experiment/Benchmark/FI同样核验运行保护。诊断/report及历史转换的运行保护已汇总，当前HISTORY_FENCE_VERSION=1允许显式惰性历史导入；旧版本、未知owner、缺附件或来源/目标冲突仍阻断，不能据此切库。

## Goal Plus、协作和用量兼容（020，逻辑完成待集中验收）

原 Goal Plus 快照上报、来源/目标/Run详情、重关联与完整性计算，以及协作事件、绑定、图和 Trace 投影沿用原API、响应和界面。固定投影目录只允许八种Goal Plus与四种协作记录；Node保留原算法，线上服务不接收任意SQL或Prisma过滤表达式。元数据与关系在事务库，快照/协作事件正文在CH；实际Trace关联使用新库alias与实时IAM，不创建旧Execution占位记录。组管理员可显式读取组内数据，写入必须实际owner；来源fingerprint、事件正文和绑定一经建立不能被不同内容覆盖。

020新增5张事务表；CH显式应用schema/clickhouse/004_semantic_usage.sql或ClickHouseStore.initialize_semantic_usage_schema，至020累计77事务表+19CH。服务不自动升级已有CH。CH事实只有与当前事务目录hash一致时可读；跨库回滚留下的孤儿、缺失或被改动的事实不能伪装为成功。

用量队列保留原容量、丢弃、202和重试语义。每条事件携带认证时的私有主体范围，混合用户分开写；body.user不参与授权。永久eventID回执防止同批、跨批、原始事件清理后的重放重复计数；清理只删除原始事实，不删除日报或去重凭据。管理员统计按当前组范围，普通成员不能访问管理接口；关闭统计保持原有无需存储操作的响应。

旧数据迁移需显式manifest映射实际owner，先父后子并保留原ID/JSON/日期。历史raw事件与原日报分别导入，raw不再次累计daily；不会从历史状态启动任务或模型。该批已完成开发接线，完整测试、原生三库、真实CH、原界面和迁移演练留待统一验收，当前未切生产。


### 原生User后台恢复

新建原生User无需再手写identity映射才能自动分析。后台通过现私有bootstrap controller枚举/精确重验真实User/API凭据，核对工件hash、record/legacy username/lookup hash、实际active principal/workspace/owner、当前权限、有效期、撤销及历史marker；不签发新key，不采用记录中任意token或旧迁移key。接口只接受`platform-control-bootstrap/v1`签名和固定`platform-background`主体，普通SDK/API/session不能枚举。

显式私有映射继续支持旧凭据与legacy用户名；IAM principalUsername单独保存。Node每次恢复并按来源重验，品牌对象记录origin与User引用，复制对象无效，不靠进程内remember维持重启。Collector snapshot/hooks仍要求write；自动分析仍要求真实同owner actor当前execute、原model_scope及每次job检查。write-only上报不能自升execute，read-only或已撤销/过期/错owner不能充当执行者，管理员Trace权限不扩大个人模型权限。Session GET懒模型恢复仍先验证请求者自身owner/can_execute。

原upload中的generator tag查询已改为已品牌collector下的私有投影，仅当前owner+明确opencodeSessionId，返回agentName/agentTraceSkill/user，不读取Session正文或全部列表。无新增DDL、前端、cookie或模型协议。当前验证限隔离SQLite+内存facts及loopback Mock模型，完整/真实引擎/CH/UI验证集中进行。

## 离线旧库语义导入契约（第一版）

`legacy_import.py` 在已校验的私有原始导出之上提供独立 `plan-legacy-import`、`apply-legacy-import`、`verify-legacy-import`；原 `plan-legacy` 仍为严格只读诊断，不放宽未知列、所有权或资产缺失门禁。固定转换器目录覆盖 96 个旧模型；这表示模型有明确处理入口，不表示任意旧行、所有客户库或生产切换已验收。无新增迁移 DDL，复用 `migration_checkpoints`、`inbox_receipts`、现有私有制品与各领域真实表；当前目录的总表数由正式表字典统计。

三个命令均要求 `--directory`、稳定 `--source-id`、`--bindings-file`、显式隔离目标 `--config`；apply/verify 还要求 `--actors-file` 与 `--migration-id`。源导出、目标配置、主体映射、凭据必须是受信私有文件。命令不寻找默认旧库、不初始化业务服务、不执行生产切换。可用 `--model` 明确选择部分模型，但部分范围永不代表全库迁移完成。用户先通过正式 IAM 建立真实 principal/workspace，再将旧用户名显式映射；null/未知/歧义 owner 使用 `--row-bindings-file` 按稳定实体键映射，不能按名称猜归属。旧 User API key 仅在私有原始制品留档，目标使用明确提供的当前 API 凭据；不会激活旧密码或旧 key。

实体身份是 `source_id + 物理表 + 带类型主键` 的 SHA-256，正文摘要只用于版本/收据。迁移 ID 固定源快照和映射/文件清单；每行领域写入、私有原始行、检查点和成功收据在同一事务提交。CH 未索引时保留 pending 检查点，重试核验实际目标后才完成收据。重放相同内容幂等；同实体内容变化、目标被用户修改、碰撞或证明缺失明确 Conflict，不覆盖目标。verify 检查真实目标字段/修订、私有字节摘要、当前 IAM、关联及可读事实，而非只数导出行。

Trace 使用实际采集领域和事实流水；保留旧 Execution/Session/子 Agent/Thread/Skill origins/手工字段、原日期与业务 ID。原 Session 字符串及 Node JSON 语义保留，只有 Session 的记录不伪造 Execution。评估器、数据集、Skill 版本进入真实 private/public release、alias 和正文/附件制品。`--files-file` 以实体键提供 base64 字节；`--skill-directories-file` 只读取显式提供的目录并捕获实际字节/模式，不把旧路径当正文；缺文件、软链接、不安全路径或 hash/size 不符拒绝。只有没有外部 assetPath 且文件声明为空或仅根 `SKILL.md` 的纯正文版本可以由真实 SQL content 生成该文件。诊断消息相同时间戳不能推断先后，需 `--message-order-file` 按 sessionId 提供完整 message ID 顺序。

历史 running/pending/busy、控制凭据/命令、基础设施来源、实验、Benchmark job、诊断/报告和生成任务必须 inert：原状态/时间保持，历史租约无执行权，不发模型、worker、采集或外部任务。当前 `HISTORY_FENCE_VERSION=1` 允许通过显式计划校验的惰性历史导入；低于1的旧实现仍在 plan 中明确阻断相关行，运行marker保护不会因版本1而解除。历史 DatasetGenerationJob 存在固定私有历史目录而不进入可领取队列；进度/原 receipt 可以读取，显式删除仍按当前 IAM 作用于真实数据集。Usage raw 仅导原始事件和永久去重收据，Daily 直接导原 count/first/last，不由 raw 二次累计。评测写真实 machine receipt/selected result/human annotation，迁移 work phase=migrate 且终态，不伪造有效评估租约。

旧诊断可只读；显式复测须有 verified 导入收据、原 snapshot 字节、仍一致的真实 Trace/Session、实验/结果、数据集/评估器及 Skill 正文基线，并再次通过当前 IAM。核验从当前真实证据重建快照与旧快照逐项比较；缺证据或来源变化 Conflict，不能臆造旧模型证明。通过后冻结当前真实新模型和新资产，创建全新复测实验/RunPlan，保留历史 diagnosis ID/inputHash origin；绝不恢复旧 lease 或修改旧运行。内部 historical 标志由 Node 消费后剥离，不改变原前端 DTO/界面。

本模块开发快检使用全新临时 SQLite 与内存事实，覆盖重放、目标漂移、事务中断恢复、真实领域读回、历史不执行及来源变更拒绝。三库原生、真实 ClickHouse、原界面和完整旧数据迁移演练由整合阶段集中验收；这些检查未完成前，任何输出的 `production_cutover_ready` 均为 false。


控制请求嵌套在已验证请求内时，未显式传入 transport 才继承当前范围的 pinned options；每次仍重新校验实际凭据、workspace 和能力。后台主体解析保留匹配来源的401/503，未知用户名不受其他owner的失败状态影响；私有目录的failure_owners只包含来源标签及状态，不返回失效key。Trace草稿入口在读取证据前把鉴权失败转换为原公开401/403响应。

设备FI使用独立的固定TASK/RUN/WORKER owner投影；其前置dc校验、clientId绑定与历史inert过滤保留，不扩展通用设备可读kind。Benchmark取消指令通过既有私有Benchmark接口的cancel_control操作处理，仅接受当前pending取消记录中的冻结client目标；实际owner和当前delete、任务request hash、确切已绑定commandId、设备未解绑及历史marker逐次校验。仅可lookup/create/sent该CANCEL_EXPERIMENT_RUN指令，原TTL、重试与迟到回调fence保留；delete-only不获得普通read/write能力。

登录前的 `GET /api/eval/config/status?check_login=true`（以及兼容的 `check_org=true`）仅返回登录模式和组织登录跳转地址，不要求用户凭据。查询具体评测配置仍进入统一授权范围，未登录不能读取配置内容。


历史运行的永久marker只限制恢复旧执行，不改写原pending/running/enabled状态。普通Experiment取消记录仍可只读查到原pending和targets；运行扫描排除历史Experiment，cancellation_route在任何指令创建前拒绝历史来源，Node协调器也对historical_inert只读返回，后置CAS/execute检查继续保留。新live取消记录沿原命令/设备poll链路处理。

历史InfraSource允许读取和显式修改配置，但ensure同endpoint仍返回带marker的旧Source，修改enabled不清marker，也不恢复抓取。pollable与accept_sample均在副作用前拒绝历史Source；不会新增采样artifact、接收回执或outbox。恢复采集要求明确的新live Source身份，本版不隐式promotion；专用离线历史样本导入不经过live采样入口。HISTORY_FENCE_VERSION=1允许显式导入这些惰性历史记录，运行保护仍独立按marker校验。实际导入仍须解决plan中的owner、附件和来源问题，production_cutover_ready保持false；该版本不恢复任何旧租约或旧凭据。


collector.source.v1适配原上传协议时，不为未提供、null或空agentName合成service.name；其列表DTO按原readRecords省略agent和agentName。明确给定的名称（包括collector、unknown）原样保留。该缺省处理只针对collector命名空间，原生OTLP的真实service.name、agent.name优先级及既有未知值行为不变。原Execution导出的null/字段缺省不改。已捕获的prepared计划及同operation回执继续重放原内容，不自动重写旧行；明确的新快照按既有source revision/hash协议接续，此后相同实体不重复递增，旧回执重放不会回退当前数据。


原 `/api/settings` 与 `/api/settings/test` 别名也通过apiFetch携带当前凭据，仍由真实actor及当前owner/capability授权。原Skill管理、工作台及生成会话的ZIP下载复用鉴权Blob传输，优先沿用服务端Content-Disposition文件名，保留原字节；不将凭据放入链接，不按query user授权。页面JSX/样式保持，完整Blob缓冲的边界同Infra导出。
