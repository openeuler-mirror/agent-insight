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
- `002_iam.sql`：10 张 IAM 表，003另增2张项目目录/归属表，004再增2张采集/实体版本表，005新增4张旧ID/标注/标签表，006增加2张诊断会话/消息表，007增加2张报告运行/当前指针表，008新增2张数据集兼容head/操作回执表，009新增1张Trace生成任务表，合计 **46 张事务表 + 13 张 CH 表 = 59 张**。完整字段、类型、约束和索引见仓库 `design/platform/analytical-transactional-storage/core-table-dictionary.md`。
- 三种事务后端共享资产 release/依赖封存、别名/草稿 CAS、冻结 RunPlan、任务领取/续租/fence/取消、制品校验，以及结果回执和 Outbox 同事务提交。
- ClickHouse 支持可信 canonical Span 批量写、最新态筛选、单 Span/分页结构读取、精确 bundle revision 的多 section 正文、正文块与清单 hash 校验，以及受限范围的最新态聚合。请求上限 4MiB，正文 bundle 上限 64MiB。
- `observations.py`可靠接收完成OTLP Span、冻结准备计划、全局强序Outbox worker及幂等CH物化；`trace_service.py`提供loopback HTTP查询/接收，Next服务端原接口兼容及旧身份显式映射。
- 一致性旧SQLite清点、原始导出和校验；`trace_import.py`已提供Session/Execution允许字段的显式映射、dry-run/隔离报告及经同一接收链路apply。尚未完成全部96模型语义迁移、在线增量追平或生产切换。

### 当前项目：default

003新增`projects`和`project_workspaces`，把已有workspace保持原ID/权限映射到default项目。新workspace同事务加入default；业务数据通过workspace间接归属项目，CH事实和排序键无需逐条改写。项目目录不产生Owner/成员授权，不合并不同用户或组的数据。

`AuthorizedStorage(iam, facts)`默认使用default，也可显式传`project_id='default'`；空字符串、空白和其他项目ID拒绝。`service.project_context(credential, workspace_id)`返回经workspace授权校验的不可变上下文。`AccessScope`以及列表/聚合响应包含project_id，缓存指纹也包含项目；单条CH事实仍保持原workspace键。

新初始化应用001–009。已有001/002/003前缀只校验，不自动升级；IAM/项目上下文要求003，本批完整兼容接口要求当前009（基础Trace服务最低007，Dataset最低008，Trace生成最低009），均须先显式迁移。此批没有项目切换UI、邀请或项目Owner服务，也未改变现有客户端上传配置。后续项目管理按[设计§4.3](../../../../design/platform/analytical-transactional-storage/phase2-requirements-design.md#43-项目预留当前统一归属-default)扩展。

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

`trace_service.py`只监听127.0.0.1，32个并行请求槽，过载503。`--config`指定0600普通JSON文件；control选择sqlite(database)或postgresql/opengauss(dsn/schema/artifacts)，clickhouse指定endpoint/database/user/password，另含cursor_secret_hex、default_workspace、port、worker_enabled。先显式初始化/迁移全部控制schema与CH，启动不会建表升级。配置示例和可信账号/Key配置见[操作指南](../../how-to/platform/storage-core.md)。

Web使用仅服务端`AGENT_INSIGHT_TRACE_STORAGE=core`、`AGENT_INSIGHT_STORAGE_CORE_URL`及`AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE`，配置变更后重启。旧public flag只保留服务端兼容别名。`DATABASE_URL`仍为隔离旧业务库，不能指向core.db；原前端Key保存/登录行为不改。映射文件0600且绑定验证过的旧Key摘要、旧用户名、IAM主体、workspace及read/write/delete代理凭据。错误不回落旧Trace库，未迁移领域仍有既有路径。

### 原接口兼容与005

`trace_legacy_ids`保存不可变task/execution别名；`trace_annotations`保存版本化标注和显式空值覆盖；`trace_tags`和`trace_tag_links`保存用户标签及多对多关联。均在控制库，受当前IAM与删除屏障约束。001–004不变。新OTLP路由同接收事务登记native ID别名；旧路由需明确回填，不按同名猜测。

兼容入口为旧`/api/observe/data`、`/api/observe/session`、`/api/tags`、execution tags及Trace bundle import/export。列表支持旧记录/统计/筛选合同，当前需枚举授权范围，超过100000条明确拒绝；尚未完成索引下推和千级并发容量验证。普通结构读取所有轻量Span、最多100000条/16MiB；后端按200条读取，不在结构请求中加载正文。点击单Span按固定索引和精确payload revision装载。完整会话/导出128MiB上限；原Langfuse节点协议需完整正文，单独作为兼容例外。

Trace bundle v1导入50MiB/500 execution、全树预检、ID/引用重映射，同一receipt可恢复，全部batch indexed才返回原成功DTO。兼容元数据写不回写采集原文；final_result编辑关联评测交接尚未实现，当前明确冲突。评测回流、infra、DiagnosisRun下游等跨领域功能以及非OTLP既有写入口仍待接管，不能把页面恢复视为全部功能迁移完成。

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

### 评测与诊断使用的完整 Trace 取证

私有`/v1/compat/observe/evidence`与server-only `readTraceEvidence`冻结授权范围、别名/owner、路由代次、注解版本及Span/Trace head向量，核对CH当前集合与精确revision/正文hash，读取后重核。它与普通页面full读不同：prepared head不等于CH已就绪，读取途中变化409、未追上/缺失/损坏503、超过16MiB/100000 Span413；不截断、不回落旧库为空轨迹。非法UTF8在传输边界拒绝。

原trace-drafts core分支使用这份完整证据，保留原DTO、Claude Code规范化、子Agent推断和空输入/输出warning。当前仅构建草稿，backflow保存、实验执行与DiagnosisRun下游仍待迁移；诊断会话/SSE及Trace报告采用下述独立协议。证据manifest/hash不含凭据和绝对路径；Next仍使用既有JS Number语义，精确大整数扩展应以字符串上报。诊断自身运行Trace必须一并保留，不能通过停用其recorder简化迁移。


### 诊断 Agent、自身 Trace、聊天与报告

006的`trace_diagnosis_sessions/messages`保存聊天事务；007的`diagnostic_report_runs/heads`保存AgentDebug与SkillsAnalysis的报告运行及当前选择。原故障页、报告页和原SSE事件格式保留；未设置core开关时继续原模式。请求中的`user`与`executionBrief`不授予权限，模型配置取当前已验证账号；兼容映射显式保留旧模型配置用户名，不能借组管理员身份使用成员的模型凭据。

- 原诊断session GET/POST、stream路由保持。task/execution/internal Trace ID在同一权限范围内解析，歧义409；user/assistant每轮原子分配连续seq。消息全文checkpoint提交后才发送text，最终回复与自身Trace均持久化后才发送done。
- 自身Trace通过`AgentTraceRecorder`接入同一durable batch/outbox/CH管道；成功、模型失败与中断均保留实际provider messages、工具参数/结果、错误和原公开session ID。稳定message/tool身份与源revision使重复完整快照不重复历史/token，修正内容才推进版本；部分投递失败可用同snapshot重试。
- 私有`POST /v1/compat/observe/agent-traces`等待全部batch indexed，返回不可由布尔值替代的receipt。finish再次核验其actor/workspace/task/parent/session/request及完整批次，防止用其他Trace或其他轮次的receipt完成聊天。accepted/prepared不算done。
- 同Trace每次仅一轮持lease/fence，失权、删除、旧fence及过期租约拒绝更新并中止Agent。状态响应丢失对同body有限重投，不重新启动模型。消息1MiB、助手8MiB、历史16MiB/10000条、流式待处理64项/16MiB，超限明确失败且不截成完整结果。revision/fence/seq通过HTTP使用十进制字符串。
- `sessionId:null`新建上游对话；已登记历史ID仅同一实际actor可续聊。组管理员可以查看已授权成员历史，并新建自己的上游；当前不支持跨actor复用同一个OpenCode session，因为其运行数据和凭据按用户隔离。不会通过共享用户运行目录绕开此限制。
- AgentDebug与SkillsAnalysis沿原分析器/Skill/Agent运行，完整TraceEvidence冻结输入。每次运行持独立head/revision及私有lease，串行持久化进度，force重跑/删除后旧job不能覆盖新结果。报告正文与进度为私有hash制品，读取仍检查当前Trace权限；无正文时不从旧Prisma同名报告兜底。

这不包含旧聊天/报告自动导入、评测`DiagnosisRun`与实验/重测闭环、生产迁移或千级并发容量证明。旧库历史保留，需显式actor/Trace映射后单独迁移。模型服务仍为原Next/OpenCode运行器，没有新增Python评测服务。

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

重启后只在原actor的当前有效进度请求中恢复，旧租约到期后重新领取并增加epoch；不持久化Bearer，也不由管理员冒充owner恢复。源分页在慢制品读取后再次校验权限/租约/生命周期；完成时同事务发布Dataset版本、任务终态及回执。系统FI目录仍是只读动态视图，不能当作新封存release；后续RunPlan须冻结有效目录。完整Benchmark导入、实验/评测结果与RunPlan消费者、旧Dataset语义导入及生产切换仍待实施。
