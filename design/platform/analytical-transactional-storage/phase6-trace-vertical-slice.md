# 采集到Trace页面的隔离垂直链路

日期：2026-11-12。用户授权按采集可靠入库、Trace API/页面接管、旧格式隔离导入、浏览器验收的顺序实施，并要求保留现有数据、交付可打开的验收环境。本批使用已有独立分支，新建数据目录/数据库/端口；不迁移默认业务运行库。

当前状态：**存储/HTTP与精简界面技术验证已完成；产品验收未通过，原有全部功能保留待落实**。以下为当前合同；新增验收记录见[实施状态](implementation-status.md#004-trace垂直链路技术验证历史专项证据)。此前001–003/IAM历史证据保留，不以本批结果覆盖。

## 用户纠偏与本切片的定位

2026-11-12用户明确：原有功能应全部保留，变化只是功能背后的数据支持。本切片替换`/trace`页面、缩减导航、改变登录后落点并对未接管操作返回501，超出了正确的存储重构范围。此前HTTP/CH/恢复/权限专项与浏览器操作证据保留为技术验证；不能据此宣布原产品可正常使用或数据库切换验收完成。

后续以[修正后的实施顺序](phase3-development-plan.md#修正后的实施顺序与兼容清单)为准：复用原有界面与业务合同，在原数据访问层逐领域接入；恢复导航同时必须接回其功能。下文保留已实现技术样例的具体行为，不作为认可精简产品范围的依据。

## 1. 交付范围与接线

- 新模式显式配置`NEXT_PUBLIC_AGENT_INSIGHT_TRACE_STORAGE=core`；未设置沿用全部旧路径。配置`AGENT_INSIGHT_STORAGE_CORE_URL`指向仅环回监听的Python服务。配置缺失、鉴权失败或后端故障不得退回旧库读写。
- 标准OTLP采集入口`/api/ingest/otel/v1/traces`在core模式解码JSON/protobuf/gzip后转到新后端。只有完成文件fsync和事务提交才返回接收成功；接收与已索引分别报告。
- Python标准库HTTP服务组合IAM、default项目、事务库、Outbox与真实CH适配器。当前验收用SQLite控制面+CH，持久端口保留PG/openGauss扩展。
- `/api/observe/data`与`/api/observe/session`在core模式桥接新读接口，`/trace`在同模式展示分页列表、Span结构、单Span与精确正文版本。新模式不把旧全Trace JSON组件接到新ID上。
- 账号沿用已实现IAM密码服务。新模式独立HttpOnly会话，旧本地用户名自注册/API Key不作为新IAM身份凭证。当前core验收仅开放Trace工作流，其他领域不宣称接管。

## 2. 持久接收、版本与恢复

追加`004_observations.sql`，保留001/002/003原始字节。新增2表，核心总计35事务表+13CH表=48表：

- `ingest_batches`：workspace/batch主键、principal、幂等key、原始包hash/ref、状态、不可变准备计划引用、Trace ID集合、接收/索引时间及错误码。unique(workspace,principal,receipt_key)。
- `obs_entity_heads`：workspace/trace/kind/entity主键，当前内部revision、源revision、规范内容hash/ref及时间；仅保存版本分配/恢复元信息，不存正文大JSON。

原始OTLP包通过私有、不可变、fsync的内容制品保存；Outbox仅存引用。规范manifest不接收浮点，原始协议包用明确encoding的JSON文本封装，保持源浮点/大整数表示规则独立。包上限4MiB/4096个完成Span，归一化展开总预算64MiB，防止共享resource属性被逐Span重复展开至无界。结构attributes_json有界，完整属性/输入/输出放正文bundle；单bundle沿用64MiB/256KiB分块限制。

认证后的workspace、principal和default项目由服务确定，客户端user属性不授予权限。一个接收事务预检全部Trace所有权，创建稳定原生ID映射/ACL、batch及Outbox。新私有资源的创建不改变授权策略revision；成员/共享撤销仍改变策略，数据缓存需另带数据水位。

Span原生trace_id/span_id使用OTLP十六进制格式。默认source_namespace为otlp，service.name仅用于显示；跨service同一原生Trace聚合，显式resource.agent_insight.source_namespace可隔离来源。内部Trace ID按workspace/source/native ID稳定映射（当前incarnation=1）；首次bucket固定，后续Span不能改变路由。已删除原生映射不偷偷复活。

完成的OTLP Span默认源revision=1；显式修订使用`agent_insight.revision`。同源版本不同内容进入冲突失败，旧版本忽略；内部CH revision单独单调分配。Trace可通过多个包持续增加Span。不能把重复累计Token相加，未知Token保留覆盖度。

Worker按全局最早未完成Outbox事件领取并持租约/fence；一个早期活动事件不被后续事件越过。先冻结准备计划并提交head/plan，再写正文块、清单、Span，最后写Trace摘要。每128 Span批量写正文，每HTTP≤4MiB，先全部chunks后manifests；每批续租并检查Trace路由。慢准备在仍持控制写锁时续租，重试始终重用相同计划/revision；全部sink成功后才标indexed/sent，过期worker不能推进完成状态。瞬时故障重试，永久冲突显式失败。已确认接收的历史数据按冻结归属继续物化，账号撤销阻止新请求及后续读取，不造成已确认数据丢失。

此单Worker/控制写锁是本批正确性基线，不代表1000采集端吞吐认证；后续可替换日志与实体所有者实现，不改变读写契约。

## 3. 后端HTTP合同

仅环回监听，无CORS公开授权。所有数据端点验证Bearer并重新求当前scope；读取CH或正文I/O后再次验证。请求/响应体有界，日志不含凭据或Trace正文。

| 方法/路径 | 请求 | 响应 |
|---|---|---|
| POST /v1/auth/login | username,password | session_token与profile；Next消费token，不下发给JS |
| GET /v1/auth/me | Bearer | username/principal_id/display_name/project_id/workspace_id/workspaces |
| POST /v1/auth/logout | Bearer | 撤销会话；不依赖项目仍active |
| POST /v1/ingest/otlp | Bearer采集凭据；OTLP JSON；可选X-Workspace-Id/Idempotency-Key | batch_id,state,trace_ids,duplicate |
| GET /v1/batches/:id | workspace_id；本人或组Owner/Admin | 接收/索引/失败状态，不返回原始包 |
| GET /v1/traces | workspace_id,limit,cursor,status,agent,search | items,next_cursor,partial,scanned,project_id |
| GET /v1/traces/:id | workspace_id | trace摘要 |
| GET /v1/traces/:id/spans | limit,after_span_id,status,parent_span_id,search | items,next_span_id |
| GET /v1/traces/:id/spans/:span | workspace_id | span结构与payload_revision |
| GET /v1/traces/:id/spans/:span/payload | revision,section,after_chunk,limit | 精确bundle的chunks,next_chunk,complete |

`workspace_id`未选时只从当前scope的授权空间中选择配置默认空间/唯一空间，不能产生全局权限。服务按事务locator解析bucket；客户不能通过伪造bucket绕过路由。

Trace列表先按真实ACL取得有界路由候选，再在CH取FINAL最新态后过滤。排序为最新接收的created_at_ms/trace_id键集。每次最多扫描2000候选，候选/响应页均有界；无法判定全局总数时不虚报total。游标绑定当前scope指纹、过滤条件和位置，并签名；权限变化后拒绝旧游标。查询结束复核返回根的当前权限和删除状态。

HTTP/UI Trace列表默认50/最大200条，Span结构默认/最大200条，正文默认/最大4块；可信kernel可支持1000结构行/32正文块，不能把kernel上限当Web接口上限。页面按需继续。字段名称来自现有CH：started_at_ms/ended_at_ms为毫秒，duration_us为微秒；64位值可用十进制字符串，未知显示缺失值。

## 4. Web桥接、登录与页面

- Next新增`/api/storage-core/auth` GET/POST/DELETE；POST代理IAM密码登录，HttpOnly/SameSiteStrict会话cookie按后端origin派生名字。Cookie安全属性按HTTPS，变更请求校验Origin；token不进localStorage、响应JSON或日志。
- core AuthProvider只通过会话恢复用户，不执行旧用户名自动换Key；core登录页使用用户名/密码。未配置core时原登录方式不变。
- `observe/session`的action支持summary/spans/span/payload/batch，参数白名单转发；不接受user查询参数作为授权。未接管的写操作明确不支持，不落回旧表。
- OTLP原入口成功响应遵循协议：JSON为空对象，protobuf为空响应，batch ID/state由响应头报告，状态查询走batch端点。接收返回不等同indexed。
- Trace界面复用共享令牌/组件，展示default、列表筛选、分页结构、单Span与分块正文。切换Trace/Span/过滤条件时取消旧请求并丢弃过期结果。界面不获取全部10000Span，也不自动拼装完整Trace JSON。

## 5. 旧格式导入与隔离验收

先在独立旧格式SQLite建立有限样本，通过只读一致性导出/校验，再将Execution/Session/interaction允许字段转为OTLP包，由相同接收/Worker链路入库。用户到目标principal/workspace必须显式映射；不导入密码/旧Key或自动归组。源行无法转换时隔离并报告数量，不默默跳过。保留源hash、目标ID、节点数与正文hash对照，证明源未改。

验收包括：实际HTTP上报正常/失败/未知Token/Unicode正文、重复包和同key冲突、worker暂停后接收并重启恢复、至少10000Span、单点结构/正文网络读取有界、Owner/普通成员/组外隔离、失效令牌/伪造user/缺省项目、旧格式样本导入与源不变。用脚本产生真实OTLP协议流，不把直接写CH夹具冒充采集闭环；不宣称真实大模型或所有既有框架已认证。

按仓库要求用`scripts/develop_start.sh`启动Next，显式隔离AGENT_INSIGHT_HOME/DATABASE_URL及空闲端口；启动前检查脚本可能终止的进程和.next归属。现有运行库和其他worktree服务保持原样。最终保留服务运行，给出URL、登录方式、已验收范围、日志/截图和停止方式。

## 6. 分工与验证顺序

1. schema_core：004 DDL/机器目录、observations.py接收/物化、故障/幂等/版本测试、source_evidence004目录。
2. legacy_migration：Next bridge、core cookie/auth、OTLP早期分支和相关测试，通用配置样例。
3. design_review：Trace分页组件/旧入口gate、core侧边导航与单元合同，之后审查集成。
4. 主任务：HTTP/query服务、旧格式转换、隔离启动与采集验收、浏览器/证据、文档和集成审查。

先跑有意义的失败测试，再实现。Python专项、针对性TS/类型检查、完整npm test按资源预算执行并如实区分失败/跳过/中止；新功能最终以真实HTTP、CH回读与浏览器操作验收。没有UI结果不得交付“可验收界面”。


## 7. 当前实现检查点

- 004两表完整字段、PK/FK/UK、CHECK、索引及ledger触发器见[字段字典004](core-table-dictionary.md#004-可靠采集与实体版本字段)；35事务表+13CH表=48，三种OLTP后端只选其一，不乘三计数。
- 服务启动为`python3 -m services.storage.trace_service --config /private/trace-service.json`，只接受私有普通配置文件；必须先显式init/migrate至004并建立CH表，启动不隐式升级。完整配置/可信账号/采集Key初始化见[操作指南](../../../docs/zh/how-to/platform/storage-core.md)。
- 采集限定已完成OTLP Span；同源版本冲突、旧版本忽略、跨service父子边、未知Token/差量汇总、原始制品故障/损坏、时钟回退、旧worker fence、慢准备续租、已退役路由和批量重试已有针对性验证。
- 本批已验证的PG/OG/CH结果按驱动、代码快照和真实/测试sink区别记录在实施状态。1000在线采集端混合压测、分片队列/HA、全部旧模型迁移和全部框架认证仍未完成。浏览器及HTTP万Span整链路证据已追加到实施状态，本节不外推为完整重构完成。


## 8. 本轮验收追加（已完成）

`exclude/storage-core-acceptance/20261112-e25e83fe/`中的HTTP、recovery、legacy-import、protobuf四份JSON证据已读回。HTTP真实上报10000 Span fixture，200行结构页131344字节、单Span670字节；Unicode正文4页SHA256一致；暂停worker后accepted，重启恢复indexed。旧格式SQLite fixture3 Span完成转换/索引，重复幂等、不支持记录隔离、源hash/计数不变；未迁客户库或复制旧密码/Key。protobuf273字节请求、空协议响应并最终indexed。

最终Python默认345条中209通过/136可选跳过，最终Web focused30/30与完整类型检查通过。首轮应用全量5334条为5258通过/52失败/24跳过；其中本次关联的2项VM适配问题已修复并回归，最终显式隔离的全量复跑未取得汇总，已保留日志并停止自有测试进程。浏览器已完成密码登录/退出、管理员与成员隔离、万Span分页/目标搜索/单点正文、7块正文前后翻页及桌面/窄屏验收。详细证据、耗时和边界见[实施状态](implementation-status.md#本轮http迁移样本与应用验证追加)，不得将fixture验收写成真实LLM、客户库切换或千级并发证明。

验收入口、私有账号文件位置、最终截图、最新专项/全量边界见[最终复核](implementation-status.md#最终复核与可打开界面)。本轮保持服务运行，未推送远端。

## 原界面兼容实施批次（2026-11-12，按用户授权执行）

本批产品前端五入口与789e8d04逐字节一致，移除仅为前次错误精简界面增加的自有组件；不新增按钮、页面、文案、登录方式或导航。原接口方法、参数、DTO及原交互保持，技术适配位于服务端。

服务端通过私有0600身份映射文件将已由原鉴权模块验证的旧API Key摘要/用户名，映射到同一授权主体的单空间IAM凭据；映射绑定core origin并核对当前principal/workspace，查询user不得授予权限。不自动给同名未映射用户授权，不将委托凭据下发前端。

兼容读端保留旧records/stats/facet与session structure/interaction/interactions合同；结构按200 Span数据库页构造，正文仅在原界面主动打开单点/完整视图时读取，_payloadVersion作为绑定Trace/Span身份、结构版本和精确payload_revision的opaque校验值，防止并发插入改变索引后错误回填正文（不能仅使用正文hash）。原界面交互索引不等于数据库Span ID，必须在服务端解析和二次授权。

为保留既有资源ID、用户标签和手动标注，新增005迁移（001–004保持原始字节）：

| 表 | 字段与约束 | 语义 |
|---|---|---|
| trace_legacy_ids | workspace_id、alias_kind(task/execution)、alias_id、trace_id、created_at_ms；PK(workspace,kind,alias)，FK Trace locator，非空ID/非负时间；不可改写/删除既有映射 | 保留旧taskId/upload_id，目标仍按workspace/trace路由和鉴权；多别名允许指向同一Trace，碰撞拒绝 |
| trace_annotations | workspace_id、trace_id；label/query_override/final_result_override/feedback_json可空；extra_json非空默认{}；revision正整数、created/updated非负；复合PK/FK Trace | 人工编辑的事务权威，不改写采集原始包；写入CAS，源物化不覆盖人工标注 |
| trace_tags | workspace_id、tag_id、owner_principal_id、kind(version/business)、name、description可空、color、revision、created/updated；复合PK，unique(workspace,owner,kind,name)，FK主体/空间 | 标签元数据与权限；旧标签ID需显式迁移，使用次数按可读且未删除的Trace求值 |
| trace_tag_links | workspace_id、trace_id、tag_id、created_by、created_at_ms；复合PK(workspace,trace,tag)，FK Trace/tag/主体，tag反查索引 | 标签关联操作同事务、去重且不得越权；源写入不删除关联 |

005只新增上述四表和索引/映射不可变保护，当前物理总数将从48增至52（三个事务后端只选其一）。服务必须显式备份和升级；本批仅迁独立验收库，保留升级前数据指纹。关系库备份证据目录随005增补，不能遗漏新增表。

写端使用Trace当前IAM授权，所有者/组Owner/Admin才可编辑或删除；只读共享不授予写权限。逻辑删除先持久化locator屏障与deletion_requests，保留身份/审计映射，异步物理清理另行报告。标签与标注不依赖旧Execution/Session存在。

本批修复不等于全平台数据迁移完成。Trace-bundle v1的50MiB导入、完整导出、原始框架字段、评测/诊断/数据集/Infra等联动必须分别接回并取得证据；不得返回空成功或忽略原过滤条件伪装兼容。未取得对应结果的项目保持未完成。

## 9. Trace 证据冻结与回流草稿切片（2026-11-13，待开发）

### 9.1 目标与边界

本切片提供统一的 `TraceEvidence` 取证读端，并将原 `POST /api/agent-datasets/trace-drafts` 的数据来源接到该读端。产品前端继续与 `789e8d04` 一致，不增加页面、按钮、请求参数或登录方式；原接口仍返回 `draft.values.{input,output,trace}`、`draft.traceSource.{taskId,executionId,capturedAt}` 和 `warnings`。Next 根据已验证身份及私有映射选择 core 主体/空间，正文中的 `user` 不授予权限。

**现有 `LegacyTraceReads.session(view='full')` 不是无条件的一致性快照。** 它已绑定每个 Span 的精确 `payload_revision` 并检查读取权限，但分页期间多个 Span、摘要、注解仍可能分别来自不同物化时刻。本切片必须验证完整实体版本向量，不能仅在现有 full 外包一层 hash 就称为证据冻结。

本次成功表示“取得并校验证据、构造回流草稿”。真正入集仍经 `POST /api/agent-datasets/backflow`，涉及字段映射、类型、同 task 去重、内置可靠性集保护、目标数据集版本与写事务；本切片不声称这些已切换到新库。实验运行器、自动重评、评测结果/人工修分、可靠性事件及诊断任务的读写接管同样不在本切片完成声明中。此处先完成设计，待主任务完成应用全量失败/超时核查并明确开发范围后再实现。

### 9.2 私有接口与统一服务端入口

| 层 | 拟定接口 | 合同 |
|---|---|---|
| core 私有 HTTP | `GET /v1/compat/observe/evidence?workspace_id=...&taskId=...`，或以 `executionId` 指定执行别名 | 使用与现有兼容端相同的 Bearer/IAM 验证；两种别名同时提供时必须解析到同一个 Trace，禁止选择一个后忽略另一个；不接受客户端 bucket、owner、版本向量或自定义无界上限 |
| core 领域读端 | `TraceEvidence.read(credential, workspace_id, *, task_id=None, execution_id=None)` | 完整执行下述“短事务捕获→有界 I/O→短事务复核”；成功返回 `agent-insight.trace-evidence` v1，不修改源、head、ACL、别名或注解 |
| Next server helper | `readTraceEvidence(request, { taskId?, executionId? })` | 复用现有兼容身份解析、origin 限制、禁止重定向、超时/字节预算及通用错误映射；不得从调用方提供的用户名构造授权，也不得失败后读取旧 Prisma Trace |
| 原草稿路由 | 原 `POST /api/agent-datasets/trace-drafts` 与原请求体 | core 模式调用 helper，随后复用既有 Claude Code 交互规范化、子 Agent 名称推断和 `extractTaskArtifacts`；原模式保持。只在成功后记录原 usage event，不返回内部凭据或取证清单 |

内部 `TraceEvidenceV1` 包含：`format`、`version`、`captured_at`、`snapshot_hash`、`manifest`、`execution`、`session`。`execution/session` 是供既有业务适配器消费的完整证据，保留原别名、query、finalResult、RawInteraction 与原 LF 表示；`manifest` 说明证据版本、来源和覆盖范围。HTTP 延续兼容端的 `{value: ...}` 封装。前端只收到原草稿 DTO，不新增可见字段；内部 manifest 不直接铺入 `traceSource`。

这是一次请求内校验成功的证据值，不等于已插入 `snapshot_manifests` 的持久发布快照。后续评测/诊断若要跨请求长期引用，须另行持久化 manifest、正文制品和发布状态，不能把这次读取的成功响应当作已有持久 snapshot ID。

### 9.3 冻结算法与一致性条件

**第一段：在同一个控制库只读事务中捕获边界。** SQLite 使用现有 `mode=ro`、`query_only=ON`、deferred read transaction；PG/openGauss 使用 `REPEATABLE READ READ ONLY`。不得调用会自行另开事务的 `resolve/properties/scope` 拼接多份边界，而应提供共享连接的内部读取函数。在此事务中一次性完成：

1. 校验当前 credential、项目/workspace 与 Trace 读取 ACL，记录本次 `scope.fingerprint`；凭据过期/撤销、组成员和资源授权都以当前值为准。
2. 解析请求别名、选择返回用的 task/execution 别名，并记录这些实际映射；捕获 locator 的完整身份：workspace、trace_id、source_namespace、native_trace_id、trace_bucket、incarnation、route_epoch、state。记录当前 owner principal；不能信任导入 capsule 中的 `user`。
3. 捕获 `trace_annotations` 的存在性、revision、原始字段值及 `extra_json.override_fields`。不存在作为明确的 revision 0 哨兵，与存在但字段为 null 区分。记录相关 `deletion_requests` 的 incarnation、barrier_revision 和 state；初始 locator 必须 active，已有删除屏障不得作为有效证据。
4. 按 `(entity_kind,entity_id)` 排序捕获该 Trace 全部 `obs_entity_heads`，包括 trace head 及每个 span head 的 revision、source_revision、content_hash、artifact_ref。必须至少有一个 trace head；所有物理 Span 包含在向量中，carrier 也不例外。计数超过 100000 Span 或冻结清单超过预定内存预算时拒绝，不先把无界结果读入内存。

关闭该事务后再做 CH/正文/本地不可变制品 I/O，不持有控制库写锁或长事务等待 HTTP。scope 指纹是本次前后授权检查条件，不是数据水位。

**第二段：先验证完整 CH 版本，再读取正文。** 当前 worker 在 `prepared` 时已提交 heads，之后才依次写正文/Span/Trace 摘要，因此“head 存在”不等于“CH 已就绪”。

1. 分页读取 CH 当前 Trace 摘要和全部 Span 结构，单页不超过 200；验证 workspace/bucket/trace、非删除标记和严格递增 span_id。不得使用过滤后的 Span 页来证明完整性。
2. 摘要的 revision 必须等于捕获的 trace head revision；Span ID 集合必须与捕获的 span heads **完全相等**，每条内部 revision 都必须相等。CH 过旧、缺失或出现向量外的新增/更高版本时都不能拼成证据。行数、总数相等不能替代集合和版本比较。
3. 在有界读取中验证 head 指向的不可变制品 hash、编码/版本和实体归属，并从 span source 的 `row.payload_revision` 取得预期正文版本。不得把 head.content_hash 直接拿来与 CH 行 hash 比较：span head 的 hash 对象是含 `row/sections/source_revision` 的源 snapshot，trace head 的 hash 对象是聚合 state，均不是 CH 序列化行。对 source.row 与 CH 可直接比较的持久字段逐项核对，验证摘要计数/边界与捕获的聚合 state 一致；compact 投影不是完整原文，也不能靠重新归一化旧包而悄悄改变证据语义。
4. 全部结构通过后才按这些已校验的固定行读取 full 正文，不重新分页取得另一组 current 行。每页最多 4 块，固定 span_id、payload_revision 和 section，核对分块连续性、chunk_count、清单/内容校验及终止游标；缺块、缺清单、版本不符或存储错误不得退化成预览/空字符串/空 interactions。

只读事务捕获的是当时已经 prepared 的实体边界，不声称覆盖全部已 accepted 但尚未进入 heads 的采集包，也不声称 Trace 已结束。如果 CH 尚未达到捕获边界，本次取证显式不可用；读端不启动 worker、不补写 CH、不自动提升源 revision。有限重试必须重新执行完整捕获流程，不能只刷新向量中的某几条。

**第三段：完成序列化后在新的控制库只读事务复核。** 在返回任何正文前重新校验 credential、scope 指纹、Trace ACL 和 owner，重新读取实际使用的别名/locator、注解及删除屏障，并取得完整 head 向量；与第一段严格比较。新增 Span、revision/hash/source_revision/artifact_ref 变化、注解新增或变化、owner/路由/incarnation/删除屏障变化均使证据失效。源 head revision 严格递增，必须比较实际值，不能仅比较最后更新时间或 Span 数量。

仍然有权但数据边界变化返回 409，要求调用者完整重试；凭据或权限被撤销优先返回 401/403，不泄漏已读取内容。该协议提供捕获边界到最终授权复核点的乐观一致性，不能承诺响应发出之后数据不再变化，也不能宣称数据库与 CH 存在分布式事务。

第二段发现 CH 结构/正文不符时也须进行有界的最终边界复核：权限已撤销按 401/403；head/注解/路由已变化按 409；边界未变而 CH 缺失/未追上/不符才按 503。不能在首次看到更高 CH revision 时直接报“存储不可用”，掩盖真实的并发源更新；若最终控制库也不可用，则不返回内容并报告 503。

### 9.4 保真、字段优先级与 hash

- query/finalResult 等有效值以捕获注解中 `override_fields` 为准；显式 null 是一次有效覆盖，不能用 `override || source` 把 null/空字符串替换掉。没有 override 时读取完整源属性/原始 `legacy_trace` 元数据，不能用 compact 的有界预览替代完整 query 或最终输出。
- 普通 OTLP、旧 RawInteraction 和原 LF 数据均采用已保存的精确版本。完整保留 RawInteraction 的任意扩展、调用/request/response/attempt IDs、`_collaboration`、原始顺序及 LF 父子/显示关系；只由服务器覆盖运行时定位指针。身份/授权仅来自 IAM 和 locator，原 `user` 等只作为来源信息。
- 区分“有效的空 Session”和“缺少 Session/正文”。已验证 carrier 表示的原 `interactions=[]` 可以返回空数组；源 `session=null` 或未能取得证据不能靠构造空轨迹满足评估器。原 LF 双表示如都存在须保留，两种表示不得重复计为分析 Span。
- manifest 至少绑定格式/投影版本、路由身份、实际别名、owner、注解存在性与 revision/值摘要、排序后的实体版本/hash 向量、正文版本及每个实际使用 section 的内容摘要、有效 execution/session 的内容摘要与覆盖说明。64 位 revision 采用规范十进制字符串，数组顺序有意义。
- `snapshot_hash` 使用有版本的确定性 UTF-8 JSON 编码计算 SHA-256：对象 key 排序、固定分隔符、禁止 NaN/Infinity、保留源 Unicode key 和有限浮点值；原文字符串按实际值编码，不作 Unicode 归一化。不直接将含任意 RawInteraction 的值交给仅接受 ASCII key/无浮点的 `contracts.canonical_json`。
- 不把 token、credential/session ID、内部 scope 指纹、Bearer/旧 Key 摘要、制品绝对路径或本次 `captured_at` 放入内容 hash 或响应 manifest。artifact_ref 只在服务端捕获/复核，公开 manifest 仅记录内容 hash；同一主体更换合法会话不应改变相同证据的内容 hash。`captured_at` 仅作本次读取时间，不能伪装源执行时间。

### 9.5 预算与失败语义

默认评测/诊断取证及本次草稿使用 **16MiB UTF-8 序列化证据总预算**，包含 execution/session、LF 双表示和 manifest；HTTP 封装另留固定小额开销并在 core 与 Next 同时限制实际字节。此配置是服务器 profile，不接收客户端任意扩大。每页结构/正文、单 section 原 64MiB kernel 限制、总时间和并发均继续有界；16MiB profile 会在读入超过预算时提前停止，而不是先拼接 64MiB 后再检查。内部制品验证也必须有实际字节/展开预算，任何路径不能无界 `read()` 或 `json.loads()`。

草稿还需独立检查其最终原 DTO 的 UTF-8 大小，避免 JSON/中文/转义和双层包装放大超过桥接限制。原 LF 的 128MiB 展示例外不自动扩大诊断证据预算；50MiB bundle 导入成功也不代表所有内容都能进入本次 16MiB 诊断 profile。明确拒绝优于截断、抽样或静默省略，后续流式/制品引用方案另行设计。

| 返回 | 语义 |
|---|---|
| 400 | 缺少/非法标识、别名互相矛盾、请求结构非法 |
| 401/403 | 当前身份无效，或初始/最终权限检查不通过；不返回已读取内容 |
| 404 | 已授权请求找不到对应 Trace/所需原 Session；不得转去旧库搜索同名数据 |
| 409 | 权限仍有效，但读取期间边界/版本/注解/路由/删除状态变化；重新取完整证据 |
| 413 | 结构、正文、内部展开、证据/最终 DTO 的明确字节/计数预算超限；不截断 |
| 503 | 无 trace head、CH 尚未达到捕获版本、缺行/缺块/缺制品、校验损坏、未知证据编码/存储不可用或读取超时；不能返回成功空轨迹 |

错误响应只提供有界通用错误与稳定原因码，不包含内部路径、凭据、Trace 正文；日志同样不能输出这些值。本次不缓存 full 证据；以后若缓存，缓存 key 必须绑定数据 manifest，并在每次返回前重新授权，不能复用旧 scope。

### 9.6 拟开发文件与验证门槛

拟新增 `services/storage/trace_evidence.py` 和对应 Python 合同测试；在 `trace_service.py` 接私有 evidence 路由。在 `src/lib/storage-core/` 增加 server-only evidence helper，复用现有兼容鉴权及 HTTP 安全边界；只改原 `trace-drafts/route.ts` 的 core 分支，不改组件或浏览器请求。具体文件归属和开发授权由主任务后续下达，本节不授权自动提交、迁旧库或扩大业务写端范围。

验证先 RED 再 GREEN，至少包含：

1. 在每个捕获步骤中途变更模拟数据，证明头向量/注解/别名/owner/locator 来自同一只读事务；PG/OG 与 SQLite 的快照边界合同一致。CH 阻塞期间另一控制写事务可完成，证明未持写锁。
2. prepared head 先于 CH、摘要已到但 Span/正文未到、Span 已到但摘要未到、未知额外 Span、缺失 Span、错版本/错正文、分块缺失/损坏均拒绝；先完成全部结构验证，再允许 full 正文读取。
3. CH 分页/正文读取期间新增 Span、同数量替换 Span、源版本推进、注解从不存在到存在/显式 null、owner/路由/删除状态变化返回 409；撤销凭据/ACL 返回 401/403 且无正文。
4. 完整 query、浮点/Unicode/任意 Raw 扩展、LF 双表示、原始索引与合法空 Session 保真；缺 Session 不伪空。相同证据更换 token/制品根路径不变 hash，任一实际证据值或实体版本变化改变 hash。
5. 超过 16MiB、100000 Span、Unicode/JSON 转义放大、超时和未知编码均有明确错误；证据失败时 `trace-drafts` 不调用旧 Prisma，不返回 draft，也不记成功 usage。
6. 原 `trace-drafts` 请求与响应逐字段兼容，输入/输出 warning、Claude Code 规范化/子 Agent 推断保持；导入 fixture/普通 OTLP 在隔离 core＋真实 CH 通过完整取证与草稿 HTTP 后，才声明该切片已接通。

本切片专项通过不能替代应用全量测试，更不能宣称 backflow 已保存到新库、实验/诊断/自动重评已接通，或提供千级并发认证。既有旧业务数据、原模式及其他 worktree 服务保持不动。


## 10. 诊断会话与消息的 core 持久化切片（2026-11-13，仅设计、未开发）

### 10.1 已核实的实际调用图与范围

本节设计原故障页追问会话与消息的迁移，并将诊断 Agent 自身 Trace 的完整 core 记录列为开放入口的强制前置；全部原功能必须保留。不修改前端、SSE 事件名、浏览器请求、模型配置领域或已有 §9；待主任务确定开发范围后实施。推荐控制库两张事务表，保持 ClickHouse 的 Trace/Span 分析职责；继续写旧 Prisma 会留下权限及双写一致性缺口，把聊天状态当 CH current 快照也不能提供可靠消息顺序与会话互斥，故均不采用。

| 实际调用方/路径 | 当前行为 | core 接通必须替换的依赖 |
|---|---|---|
| `src/app/(main)/fault/page.tsx`，数据加载约 650–675 行 | 同时请求 observe/data、observe/session、`GET /api/fault/diagnosis/session?executionId=<taskId>`；以返回消息恢复历史、以 `opencodeSessionId` 继续 Agent 会话 | `executionId` 在这个页面实际常是 task 别名，不能当旧 Execution 主键直查；先按已授权 Trace 的 task/execution/internal 别名解析 |
| 同页 `handleSubmit`，约 735–780 行 | POST stream，body 为 `{user,message,executionId,sessionId,executionBrief}`；消费 text/done/error；`sessionId:null` 表示新对话，载入 localStorage 历史可发送更早的 upstream ID | body.user 不参与授权；保留 null 新建语义与合法历史分支，不能强制复用最后一个 upstream ID，也不能接受任意外部 ID |
| `src/app/api/fault/diagnosis/session/route.ts` GET/POST | 直接 `prismaRaw.faultDiagnosisSession.findUnique({executionId})`；GET 包含全部消息按 createdAt 升序；POST 先查后建或任意替换 upstream ID | core 分支全部改走受鉴权的会话领域 API；禁止读取失败后回旧库，禁止公开接口任意绑定未知 upstream ID |
| `src/app/api/fault/diagnosis/stream/route.ts` `ensureDiagnosisSession`/POST | 先查建 session，取最近 24 条消息（desc 后 reverse），从 `db.findSessionByTaskId` 取原轨迹；落 user 后调用 Agent，完成落 assistant 和 upstream ID，失败另落错误文本 | session/message create/find/count/update 全部迁到 core；Trace 证据改取 §9 `readTraceEvidence`，不能用 compact preview 或旧 db Session 兜底 |
| 同 stream 的 `formatAgentDebugContext` | 查旧 `AgentDebugReport`/`AgentDebugSkillsAnalysis`，比较 interactionsHash 后形成提示词 | 报告未迁移；core 本切片显式标记该上游上下文 unavailable，不读取同名旧报告冒充当前 core Trace 结论 |
| `runGeneralAgent`（`src/lib/engine/general-agent/runner.ts`，成功/失败 recorder 分支） | stream 传 `recordTraceAs:'fault-diagnosis-agent'`；成功及失败均可能由 `recordEvaluatorExecution` 写旧 Execution/Session | 必须先以 core recorder 替换成功/失败两条记录路径，保持 `recordTraceAs` 的原功能语义，完整保存原始 messages、tool 调用/结果、失败状态与证据。actor/workspace 由受信上下文绑定，保留原公开 ID、稳定源 revision 与幂等；不得以不传 `recordTraceAs` 丢弃诊断自身 Trace。该前置未实现、未验证前不得开放 core SSE 或宣称诊断已迁移 |
| `src/app/api/agents/[id]/route.ts` DELETE | 清理旧 Execution 对应的 FaultDiagnosisMessage/Session | 该旧事务没有 core 权限，不能扩大为隐式删除 core 诊断；core 历史由 Trace 删除屏障立即隐藏，后续合规清理协议另行处理 |

全仓当前 session/message 的产品持久化调用仅为上述两个诊断路由及 Agent 删除清理；`prisma/schema.prisma` 的旧 `FaultDiagnosisSession`/`FaultDiagnosisMessage` 是原模式存储。`src/lib/diagnosis/service.ts` 的 `DiagnosisRun`、AgentDebug 报告/Skill 分析、评测输入冻结/优化导入/重测，以及 RAS 可靠性事件均是另外的领域，**不计为本两表切片完成**。模型配置与 `recordUsageEvent` 沿用已验证用户的现有领域；允许其原有独立库，并不代表诊断 session/message 继续影子写旧库。

### 10.2 原公开合同与权限

- GET 成功保持 `{session:null,messages:[]}` 或 `{session:{id,executionId,opencodeSessionId,createdAt,updatedAt},messages:[{id,role,content,createdAt}]}`，日期为 ISO 字符串，稳定消息 ID；内部 revision/seq/state 不要求前端认识。空结果仅能在 Trace 已授权且确实无诊断会话时返回。
- POST session 保持 `{session:...}`；创建原子幂等；传非空 upstream ID 只可选择服务端已记录属于该 Trace 的 ID，未知值 409，不能据 payload 直接注册。省略字段不改绑定；显式 null 可请求下一轮新建，不删除旧分支绑定和历史。
- stream 的 `ready{executionId,sessionId,diagnosisSessionId}`、`text{delta,fullText}`、`reasoning{delta}`、`tool{phase,name,callID,status}`、`done{sessionId,diagnosisSessionId,workspaceDir,output,stats}`、`error{message}` 与原响应头保持。正文仍交由原 Agent 运行器生成；不从数据库伪造模型成功。
- 每个 core 操作重新验证 credential、default project/workspace、Trace ACL 和 active locator/删除屏障；组 owner/admin 可读组内 Trace 及其会话，member 只能读本人或明确共享/组可见的 Trace，viewer 仅有已授权的读取。会话不创造独立的旁路 ACL；明确共享 Trace 同时暴露其诊断历史，此继承关系必须在后续共享文档说明。
- 写入同时要求 `read`（读取取证上下文）与 Trace `write`，并保留资源 owner 或组 owner/admin/personal 限制；read-only 的明确共享不能授写。所有 actor/模型配置用户名由已验证身份/私有映射取得；body.user、executionBrief.user、来源 capsule user 不可信。
- 每轮创建、续租、checkpoint、完成及历史返回均复核权限/删除屏障。撤销或删除发生后不得继续返回正文或接受迟到助手更新；中止本地 Agent 请求，已写消息保留但对失权主体不可见。无权按 401/403；有权但会话版本冲突/已在运行/已删除路由按稳定 409，缺失按 404；预算超限 413，存储异常 503，禁止成功空历史兜底。

### 10.3 拟定 006 两表的完整逻辑字段

以下是待实现合同，尚无 006 DDL/运行时。SQLite `I` 为 INTEGER 且逐列 CHECK `typeof(...)='integer'`，PG/openGauss `I` 为 BIGINT；`T` 为 TEXT。所有 PK/FK 列 NOT NULL，除明确 nullable 的字段外其余亦 NOT NULL。毫秒时间非负，updated 不早于 created；revision、seq、fence 取 `1..9223372036854775807`，加法先检查溢出。新生成 ID 为服务器 UUID；既有 workspace_id/trace_id 不加严格式、不 trim、不改写。涉及 JSON 的结构、UTF-8 字节预算和 SHA-256 在公共领域层校验，三库 DDL 不依赖各自 JSON 方言。

**`trace_diagnosis_sessions`**：

| 字段 | 类型/默认/空性 | 规则 |
|---|---|---|
| workspace_id | T | 租户边界 |
| session_id | T | 服务器稳定诊断 ID，非 upstream ID |
| trace_id | T | canonical internal Trace ID；UNIQUE(workspace_id,trace_id)，保持原“一条 Trace 一份服务端会话账本” |
| created_by | T | FK iam_principals，首次创建 actor，仅审计，不另授权限 |
| opencode_session_id | T nullable，默认 NULL | 最近合法选中的 upstream ID；不存 credential |
| revision | I，默认 1 | 会话 CAS；任何绑定、轮次或租约状态变化推进 |
| next_sequence | I，默认 1 | 下一条可分配 seq；每轮在同事务保留 user/assistant 两个连续位置 |
| turn_fence | I，默认 1 | 当前租约栅栏；每次开始/接管递增，禁止时间戳代替 |
| active_request_key | T nullable，默认 NULL | 当前轮标识；空闲为 NULL |
| lease_owner | T nullable，默认 NULL | 单次受信 Next 运行实例 UUID，非用户自报、非 token |
| lease_expires_at_ms | I nullable，默认 NULL | 有活动轮时非负；不能靠本地进程锁替代跨实例租约 |
| created_at_ms | I | 创建时间 |
| updated_at_ms | I | 单调更新审计时间 |

PK `(workspace_id,session_id)`；FK `(workspace_id,trace_id)` → trace_locators，FK created_by → iam_principals，均 NO ACTION。active_request_key/lease_owner/lease_expires_at_ms 必须全空或全非空；非空字符串有界、不可为空串。索引 `(workspace_id,updated_at_ms,session_id)` 和 `(lease_expires_at_ms,workspace_id,session_id)`；唯一 Trace 索引用于按别名解析后读取。workspace/trace/session/created_by/created_at 不可改，next_sequence/turn_fence/revision 不回退；不能用 ON DELETE CASCADE 绕开删除屏障。

**`trace_diagnosis_messages`**：

| 字段 | 类型/默认/空性 | 规则 |
|---|---|---|
| workspace_id | T | 与 session 相同租户 |
| session_id | T | 所属诊断账本 |
| message_id | T | 服务器生成并在重试中复用的稳定消息 ID |
| seq | I | session 内唯一逻辑顺序，不按毫秒时间猜顺序 |
| request_key | T | 一轮 user/assistant 的共同幂等键，受信服务器产生或校验显式 Idempotency-Key |
| request_hash | T | 小写 64hex；绑定完整原用户消息、证据 hash、已验证模型选择及 continuation 意图；不含密钥 |
| role | T | CHECK user/assistant |
| state | T | user 仅 accepted；assistant 为 streaming/done/failed/interrupted |
| content | T，默认空字符串 | 原始完整用户消息/累计助手正文；user 不可为空，assistant 占位可空；不把预览写成完整正文 |
| content_hash | T | 实际 UTF-8 content 的小写 64hex SHA-256 |
| evidence_hash | T nullable，默认 NULL | 本轮 §9 内容 hash，仅证明取证内容标识，不冒充已发布的持久 snapshot ID；旧导入不明时 NULL |
| opencode_session_id | T nullable，默认 NULL | 此轮实际使用/返回的 upstream ID，保留旧分支续聊的服务端归属证明 |
| created_by | T | 发起轮次的真实 actor；assistant 记录同 actor 归因，不伪造系统 principal |
| turn_fence | I | 该轮实际栅栏；终态后固定 |
| revision | I，默认 1 | 消息正文更新 CAS，累计全文而非 append 重复 delta |
| error_code | T nullable，默认 NULL | 有界稳定码，failed/interrupted 可用 |
| created_at_ms | I | 保留分配时间 |
| updated_at_ms | I | checkpoint/终态提交时间，单调 |

PK `(workspace_id,message_id)`；FK `(workspace_id,session_id)` → sessions、created_by → iam_principals；UNIQUE `(workspace_id,session_id,seq)`、UNIQUE `(workspace_id,session_id,request_key,role)`。索引 `(workspace_id,session_id,seq)` 支持前后翻页及最近 24 条，`(workspace_id,session_id,opencode_session_id,seq)` 支持验证历史 upstream 归属。message/session/seq/request_key/request_hash/role/created_by/created_at 不可变；终态助手 content/hash/upstream/state 不可再次更改。user content/hash 不可变，upstream ID 允许在本轮受信完成事务中从未知绑定到实际值一次；两条消息最终绑定相同 ID。任意请求内容/证据变化而复用同键，必须 409。

不新增 CH 表。若按当前实际 52 表核算，此方案拟增至 54；这是计划数，未开发前仍以已应用 migration/catalog 为准，不能先声称已有 54 表。

### 10.4 事务、顺序、并发与崩溃语义

1. **取证/准备**：先验证身份与 Trace 写权限，再取得 §9 完整冻结证据和服务器 executionBrief。客户端 brief 只可作为明确标记的用户补充，不能覆盖事实；报告缺失明确 unavailable。制品工作区按 workspace+core session 的无碰撞 hash 绑定，不以截断/替换后的 executionId 单独作目录。目录隔离和受限权限也适用于共享主体，不能借 body.user/客户端路径串目录。当前 `runGeneralAgent.user` 同时参与模型配置选择与用户工作区定位，组 admin 续聊 owner 创建的同一 upstream 时必须将这两个受信概念分开：需要最小的服务端工作区选择 hook 或同等 bridge，让目录绑定 core session、模型仍取当前已验证 actor 配置；不能为了复用目录偷偷使用原 owner 的模型配置，也不能仅更换 user 导致 upstream cwd 与当前证据目录不一致。该 hook 是完整接通的前置开发项，尚未实现。任何 CH/模型/文件 I/O 不持有控制库写锁。
2. **begin_turn 原子事务**：复核权限/删除屏障，按 canonical Trace 原子 get-or-create 账本；CAS session.revision，认领租约/fence；分配两个 seq，插入 accepted user 与 streaming assistant 占位，冻结 request_hash/evidence_hash。已有同键同 hash 返回原稳定 ID/状态；同键不同 hash 409。返回 duplicate 与本轮是否首条 user 的受信标记，原 usage 统计据此区分启动/续聊，不能继续调用旧 faultDiagnosisMessage.count，也不在私有重试中重复统计。另一活跃轮返回 409 busy，不把并发请求拼进同一 upstream 上下文。PG/OG 锁定该 session 行并 CAS，SQLite 使用短写事务；首次建会话唯一冲突重试在新事务重读，不在已失败的 PG 事务中继续。
3. **upstream 分支**：原请求 sessionId 缺省/null 则新建 Agent 会话，不因数据库已有最新值强制续聊；非空只允许 sessions 或消息账本已绑定到相同 Trace 的 upstream ID，历史合法分支可复用。公开 POST session 不登记外部未知 ID。并发分支仍经同一 Trace 账本互斥，不覆盖其他轮的 upstream 结果；旧 localStorage 快照属于未迁移的未知 ID 时明确拒绝，必须显式迁入映射后可用。
4. **消息与 SSE**：保留原最近 24 条历史作为提示词，并继续原 8000 字符 prompt 摘要规则；数据库保存全部原消息，摘要规则不改变存储正文。前端看到的 text 必须先有成功的持久 checkpoint，再发原 text 事件。`ChatHandlers.onText` 当前返回 void，不能仅加 async 冒充背压：需每请求独立有界串行队列，按累计全文+expected_revision 写入，再按原顺序发相应 text，队列超预算中止模型；终态等待队列 drain。e.fullText 可合法修正累计文本，不能强制只追加；幂等相同 revision/content hash 重投不重复推进。reasoning/tool 延续原实时事件；两张聊天表不替代原运行轨迹，原 messages 与 tool 事件、调用参数/结果及可用失败证据必须由前置 core recorder 完整保存，不得因聊天表只有 user/assistant 而省略。仅保存原运行器实际产生的字段，不补造未记录的思维内容。
5. **租约/完成**：拟租约 90 秒、最多 15 秒续一次，每次必须当前 owner+fence+有效权限+active route；助手 checkpoint 同样检查且消息 belongs 当前 request。成功前须确认 core recorder 已持久接收完整诊断自身 Trace（含可恢复 receipt/outbox），再在短事务完成助手全文、双方实际 upstream 绑定、session 最新 upstream 和释放租约，随后才发 done；聊天表提交或 Trace 持久接收任一失败都不能发假 done。两者没有跨库分布式事务，部分完成须用固定 receipt/request key 恢复、补齐而不重跑模型；Trace 查询可见性另按既有 indexed 状态验证，accepted 不冒充已索引。失败路径同样必须由 core recorder 保留实际失败 Trace，不能只写一条聊天错误文本代替。模型失败保留已经持久的正文并记录错误终态（历史展示映射为原 assistant content 与有界错误文本），再发 error，错误处理不可再新插一条助手导致重复。存储错误只发通用 error，不泄漏路径或凭据。
6. **失联/重启**：网络取消、失权、超时应撤销本轮模型并将可保存轮次标记 interrupted；失权时不能靠旧 credential 绕过 ACL 写尾部，可信恢复器只可维护既有轮次的终止元数据，不继续生成/泄漏正文。进程崩溃后的过期租约由下一次授权访问/显式维护标记 interrupted并推进 fence；旧 worker 的迟到更新全部拒绝。保留已 committed 正文，不声称已生成但尚未 checkpoint 的模型 token 零丢失，也不自动重跑外部模型冒充 exactly-once。
7. **幂等边界**：旧前端没有稳定请求键；Next 给单次 POST 生成键并贯穿私有重试，或接受校验过的 Idempotency-Key。同一消息重复 HTTP POST 且没有稳定键仍是两次用户操作，不能用内容 hash 去重吞掉真实重复提问。已完成同键重试可用原终态输出形成原 done；进行中同键不再调用第二个 Agent，可返回 409/in_progress。消息持久化与模型外部执行没有分布式事务。

### 10.5 拟定 core 与 Next helper 合同

| 拟定层/接口 | 输入及输出 | 约束 |
|---|---|---|
| core `GET /v1/compat/fault/diagnosis/session` | workspace_id+executionId alias → 原 `{session,messages}` DTO | 内部分页按 seq 200 条读取、最终一次响应完整历史；前后 scope/route/session.revision 复核，不截断成功 |
| core `POST .../session` | 原 executionId/opencodeSessionId + verified actor → 原 `{session}` | 原子建会话/合法已知绑定选择，不能接受 user 授权；所有变更用 CAS |
| core `begin_turn` | Trace ref、request_key/hash、message、evidence_hash、continuation、expected session revision → session/message IDs、seq、revision、fence、lease、最近 24 条历史 | 私有接口，仅服务端受信运行器调用；credential 仍有当前 read+write，不因是 loopback 就跳过权限 |
| core `checkpoint/renew/finish_turn` | session/request、owner、fence、消息 expected revision、累计全文/终态/真实 upstream → 新 revision/状态 | 绑定同一 credential actor/Trace/current turn；不能更新别的 request/message；finish 原子且可幂等 |
| Next `readFaultDiagnosisSession(request, executionRef)` / `ensureFaultDiagnosisSession(request, input)` | 使用现有兼容身份 resolver、origin 限制、无 redirect、字节/时间预算，直接保持原 route DTO | 从 core profile/显式映射得到 principal/workspace 与现有模型领域用户名，禁止 payload.user 授权或失败后查 Prisma |
| Next `openFaultDiagnosisTurn(request,input)` | 复用 `readTraceEvidence` + begin；返回受限 turn handle、完整验证证据、history 与可信模型身份 | handle 仅服务端，不返回 bearer/私有 scope/绝对制品路径；不能导出原 token 到磁盘 |
| Next `checkpointFaultDiagnosisTurn/renewFaultDiagnosisTurn/finishFaultDiagnosisTurn` | 由 handle 保留稳定 key/owner/fence/expected revisions，封装原累计消息与 upstream 结果 | 与 SSE 串行队列配合，不自行偷偷重试一次模型调用；成功终态提交前禁止 done |

沿用原公开路由，在 core mode 分支接 helper；原模式继续原实现。拟每条用户消息 UTF-8 上限 1MiB、助手累计 8MiB、历史响应 16MiB/最多 10000 条（超限明确 413，不能只返回最近 N 条伪装完整历史）；提示词的既有 24 条/8000 字符截断是独立可见的 prompt 规则。Evidence 仍受 §9 16MiB，不因消息预算变化放宽。续租/checkpoint HTTP 为短请求，原 SSE 仍采用原运行超时默认 5 分钟、maxDuration 600；客户端 timeoutMs 需服务器范围校验，不能任意无限扩展。具体 profile 与 helper 导出名待开发范围确认后冻结，不代表接口已经上线。

### 10.6 三库迁移与旧数据保留

- 拟新增 `schema/{sqlite,postgresql,opengauss}/006_trace_diagnosis.sql` 与同字段 catalog，绝不改 001–005 字节；schema_meta version/checksum 遵守已有顺序追加/校验。三库 PK/FK/状态/范围/不可变触发器与 CAS 合同一致，SQLite 额外严格整数 CHECK；PG/OG 不依赖不兼容的 UPSERT/JSON 操作。需要给 relational source_evidence 增加已应用版本的 catalog hook。
- 现有 v5 数据不自动升级；仅显式 backup→验证备份与当前 prefix/checksum→迁移事务→核对表/旧行不变。006 本身只建空表，不给每个 Trace 虚构空会话、不搬模型配置、不改 CH/head/source_revision、不改业务默认库。实际同步范围由主任务授权。
- 旧诊断历史导入属于显式迁移器：只读导出原 Session/Message 和已验证身份/Trace 别名映射，保留旧 session/message IDs、完整 content、原时间、upstream 归属；按固定导出次序分配 seq，不能凭同毫秒 createdAt 编造确证顺序。没有可验证 actor/Trace/上游关系的条目隔离报告，不按旧 payload.user 自行认领。幂等复入校验原 ID 与内容，冲突停迁，不 merge/覆盖目标；保留旧库和导出校验清单。
- Trace 删除立即通过 locator/deletion_requests 屏障让会话及消息不可读写，历史不物理 cascade；后续物理擦除须进入同一删除队列/保留策略，不能把当前“不可访问”宣称为已完成合规擦除。Agent 删除旧逻辑继续只处理旧数据；本切片没有“删 Agent 自动删新库全部历史”能力。

### 10.7 开发前确认与可证明的完成门槛

建议完整接通范围是“原故障页选择 core Trace → 已授权历史读取 → 取 §9 精确证据 → 原 Agent/SSE 运行且成功/失败的自身 Trace 完整持久进入 core → user/assistant checkpoint/upstream 在 core 重启后可恢复 → 原页面续聊/新对话/合法历史分支”，其中 SSE/模型仍由现有 Next 运行器执行。仅建表、只改 GET、关闭自身 Trace 记录或旁写两份库均不足以声明接通。

开发顺序明确为：先完成 §9 共享取证的真实存储验证及应用全量零失败；再在单独授权的前置切片实现/验证 core recorder 与受信工作区 hook；最后才实施 006 两表、Next helper 与原 SSE 接线。core recorder 必须完整保留原 messages/tool/失败 Trace，诊断 upstream 原公开 task/execution ID 通过可信映射保留，内部 OTLP 身份可规范编码但不得用新随机公开 ID 破坏旧关联；与被诊断 Trace、request key 和真实 actor/workspace 的关系由服务器确定。相同来源快照重试复用稳定 ID、source revision、内容 hash 与 receipt；修正快照才推进服务器分配的 source revision，不能重放时按时间戳另造版本。核实成功、失败、流中断及部分 sink 失败后的完整正文读回与幂等恢复后，才允许开放 core SSE；此之前原 core 诊断入口保持明确不可用，不能以两表先上线宣称闭环。

先 RED/GREEN 验证：同 Trace 的 task/execution/internal 别名归一、并发首次创建唯一、跨租户 FK、seq 两条原子分配、同键异输入冲突、两个并发轮只有一个模型启动、同一全文 checkpoint 幂等、终态不可修改；member/owner/admin/viewer/共享/API 能力边界与 payload.user 伪造；SSE text/done 必须排在 durable 提交后、队列超限/存储错不发假成功；失权/删除/过期 lease/新 fence 使旧 worker 失效；重启可读原始完整消息/upstream，null 新建与已知历史分支可用、未知 upstream 不串话；没有任何 core 分支调用 faultDb、旧 db Session、旧报告或旧 Prisma recorder；core recorder 在成功/失败/中断路径均被真实调用，原始 messages、tool 参数/结果和错误证据逐字段读回一致，稳定原 ID/source revision/receipt 重试不重复，不能通过移除 `recordTraceAs` 让测试表面通过。三库真实事务及隔离 HTTP/SSE mock Agent（清楚标 fixture，不冒充真实 LLM）分别取得证据，旧模式定向回归通过后再由主任务决定浏览器与真实模型验收。

诊断自身 Trace 的 core recorder 是本切片的强制前置和完成门槛，不属于可丢弃的后续项。AgentDebug 报告、DiagnosisRun/诊断输入长期冻结、评测/修分、RAS 事件与优化/重测仍是独立待迁领域；这些未切换前明确保持待后续，不用空成功或旧 Prisma 影子写宣称完成。此节只完成设计，暂不编写 DDL、helper、路由或产品代码。
