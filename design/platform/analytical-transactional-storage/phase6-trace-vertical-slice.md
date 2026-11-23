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


## 10. 诊断会话与消息的 core 持久化切片（2026-11-13，已授权实施）

### 10.1 已核实的实际调用图与范围

本节设计原故障页追问会话与消息的迁移，并将诊断 Agent 自身 Trace 的完整 core 记录列为开放入口的强制前置；全部原功能必须保留。保留全部页面、组件与原登录源码及SSE事件名；apiFetch仅为诊断路径补齐既有Key头，模型配置仍按当前受信账号选择。当前实施按本节与§11进行，最终测试及实际验收边界见实施状态。推荐控制库两张事务表，保持 ClickHouse 的 Trace/Span 分析职责；继续写旧 Prisma 会留下权限及双写一致性缺口，把聊天状态当 CH current 快照也不能提供可靠消息顺序与会话互斥，故均不采用。

| 实际调用方/路径 | 迁移前行为 | core 领域合同 |
|---|---|---|
| `src/app/(main)/fault/page.tsx`，数据加载约 650–675 行 | 同时请求 observe/data、observe/session、`GET /api/fault/diagnosis/session?executionId=<taskId>`；以返回消息恢复历史、以 `opencodeSessionId` 继续 Agent 会话 | `executionId` 在这个页面实际常是 task 别名，不能当旧 Execution 主键直查；先按已授权 Trace 的 task/execution/internal 别名解析 |
| 同页 `handleSubmit`，约 735–780 行 | POST stream，body 为 `{user,message,executionId,sessionId,executionBrief}`；消费 text/done/error；`sessionId:null` 表示新对话，载入 localStorage 历史可发送更早的 upstream ID | body.user 不参与授权；保留 null 新建语义与合法历史分支，不能强制复用最后一个 upstream ID，也不能接受任意外部 ID |
| `src/app/api/fault/diagnosis/session/route.ts` GET/POST | 直接 `prismaRaw.faultDiagnosisSession.findUnique({executionId})`；GET 包含全部消息按 createdAt 升序；POST 先查后建或任意替换 upstream ID | core 分支全部改走受鉴权的会话领域 API；禁止读取失败后回旧库，禁止公开接口任意绑定未知 upstream ID |
| `src/app/api/fault/diagnosis/stream/route.ts` `ensureDiagnosisSession`/POST | 先查建 session，取最近 24 条消息（desc 后 reverse），从 `db.findSessionByTaskId` 取原轨迹；落 user 后调用 Agent，完成落 assistant 和 upstream ID，失败另落错误文本 | session/message create/find/count/update 全部迁到 core；Trace 证据改取 §9 `readTraceEvidence`，不能用 compact preview 或旧 db Session 兜底 |
| 同 stream 的 `formatAgentDebugContext` | 查旧 `AgentDebugReport`/`AgentDebugSkillsAnalysis`，比较 interactionsHash 后形成提示词 | 通过§11可信上下文读取core报告，缺失明确unavailable；存储异常失败，不读取同名旧报告冒充当前core结论 |
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

### 10.3 006 两表的完整逻辑字段

以下合同已落到三库006及diagnosis-catalog.json，完整当前字段/索引见核心表字典。SQLite `I` 为 INTEGER 且逐列 CHECK `typeof(...)='integer'`，PG/openGauss `I` 为 BIGINT；`T` 为 TEXT。所有 PK/FK 列 NOT NULL，除明确 nullable 的字段外其余亦 NOT NULL。毫秒时间非负，updated 不早于 created；revision、seq、fence 取 `1..9223372036854775807`，加法先检查溢出。新生成 ID 为服务器 UUID；既有 workspace_id/trace_id 不加严格式、不 trim、不改写。涉及 JSON 的结构、UTF-8 字节预算和 SHA-256 在公共领域层校验，三库 DDL 不依赖各自 JSON 方言。

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

不新增CH表。006使事务表从39增至41，连同13张CH表为54；§11的007再追加2张事务报告表，目前43张事务表+13张CH表=56。已有目标只有显式升级后才具备对应表。

### 10.4 事务、顺序、并发与崩溃语义

1. **取证/准备**：先验证身份与 Trace 写权限，再取得 §9 完整冻结证据和服务器 executionBrief。客户端 brief 只可作为明确标记的用户补充，不能覆盖事实；报告缺失明确 unavailable。制品工作区按 workspace+core session 的无碰撞 hash 绑定，不以截断/替换后的 executionId 单独作目录。目录隔离和受限权限也适用于共享主体，不能借 body.user/客户端路径串目录。当前 `runGeneralAgent.user` 同时参与模型配置选择与用户工作区定位，组 admin 续聊 owner 创建的同一 upstream 时必须将这两个受信概念分开：需要最小的服务端工作区选择 hook 或同等 bridge，让目录绑定 core session、模型仍取当前已验证 actor 配置；不能为了复用目录偷偷使用原 owner 的模型配置，也不能仅更换 user 导致 upstream cwd 与当前证据目录不一致。该hook已由trusted-context/runner实现。因上游运行库和凭据仍按actor隔离，跨actor只能读取历史并显式新建自己的上游；begin会在分配消息前拒绝跨actor复用，不能以共享运行目录或冒用模型凭据绕过。任何 CH/模型/文件 I/O 不持有控制库写锁。
2. **begin_turn 原子事务**：复核权限/删除屏障，按 canonical Trace 原子 get-or-create 账本；CAS session.revision，认领租约/fence；分配两个 seq，插入 accepted user 与 streaming assistant 占位，冻结 request_hash/evidence_hash。已有同键同 hash 返回原稳定 ID/状态；同键不同 hash 409。返回 duplicate 与本轮是否首条 user 的受信标记，原 usage 统计据此区分启动/续聊，不能继续调用旧 faultDiagnosisMessage.count，也不在私有重试中重复统计。另一活跃轮返回 409 busy，不把并发请求拼进同一 upstream 上下文。PG/OG 锁定该 session 行并 CAS，SQLite 使用短写事务；首次建会话唯一冲突重试在新事务重读，不在已失败的 PG 事务中继续。
3. **upstream 分支**：原请求 sessionId 缺省/null 则新建 Agent 会话，不因数据库已有最新值强制续聊；非空只允许 sessions 或消息账本已绑定到相同 Trace 的 upstream ID，历史合法分支可复用。公开 POST session 不登记外部未知 ID。并发分支仍经同一 Trace 账本互斥，不覆盖其他轮的 upstream 结果；旧 localStorage 快照属于未迁移的未知 ID 时明确拒绝，必须显式迁入映射后可用。
4. **消息与 SSE**：保留原最近 24 条历史作为提示词，并继续原 8000 字符 prompt 摘要规则；数据库保存全部原消息，摘要规则不改变存储正文。前端看到的 text 必须先有成功的持久 checkpoint，再发原 text 事件。`ChatHandlers.onText` 当前返回 void，不能仅加 async 冒充背压：需每请求独立有界串行队列，按累计全文+expected_revision 写入，再按原顺序发相应 text，队列超预算中止模型；终态等待队列 drain。e.fullText 可合法修正累计文本，不能强制只追加；幂等相同 revision/content hash 重投不重复推进。reasoning/tool 延续原实时事件；两张聊天表不替代原运行轨迹，原 messages 与 tool 事件、调用参数/结果及可用失败证据必须由前置 core recorder 完整保存，不得因聊天表只有 user/assistant 而省略。仅保存原运行器实际产生的字段，不补造未记录的思维内容。
5. **租约/完成**：拟租约 90 秒、最多 15 秒续一次，每次必须当前 owner+fence+有效权限+active route；助手 checkpoint 同样检查且消息 belongs 当前 request。成功前须确认 core recorder 已持久接收完整诊断自身 Trace（含可恢复 receipt/outbox），再在短事务完成助手全文、双方实际 upstream 绑定、session 最新 upstream 和释放租约，随后才发 done；聊天表提交或 Trace 持久接收任一失败都不能发假 done。两者没有跨库分布式事务，部分完成须用固定 receipt/request key 恢复、补齐而不重跑模型；Trace 查询可见性另按既有 indexed 状态验证，accepted 不冒充已索引。失败路径同样必须由 core recorder 保留实际失败 Trace，不能只写一条聊天错误文本代替。模型失败保留已经持久的正文并记录错误终态（历史展示映射为原 assistant content 与有界错误文本），再发 error，错误处理不可再新插一条助手导致重复。存储错误只发通用 error，不泄漏路径或凭据。
6. **失联/重启**：网络取消、失权、超时应撤销本轮模型并将可保存轮次标记 interrupted；失权时不能靠旧 credential 绕过 ACL 写尾部，可信恢复器只可维护既有轮次的终止元数据，不继续生成/泄漏正文。进程崩溃后的过期租约由下一次授权访问/显式维护标记 interrupted并推进 fence；旧 worker 的迟到更新全部拒绝。保留已 committed 正文，不声称已生成但尚未 checkpoint 的模型 token 零丢失，也不自动重跑外部模型冒充 exactly-once。
7. **幂等边界**：旧前端没有稳定请求键；Next 给单次 POST 生成键并贯穿私有重试，或接受校验过的 Idempotency-Key。同一消息重复 HTTP POST 且没有稳定键仍是两次用户操作，不能用内容 hash 去重吞掉真实重复提问。已完成同键重试可用原终态输出形成原 done；进行中同键不再调用第二个 Agent，可返回 409/in_progress。消息持久化与模型外部执行没有分布式事务。

### 10.5 core 与 Next helper 合同

| 拟定层/接口 | 输入及输出 | 约束 |
|---|---|---|
| core `GET /v1/compat/fault/diagnosis/session` | workspace_id+executionId alias → 原 `{session,messages}` DTO | 内部分页按 seq 200 条读取、最终一次响应完整历史；前后 scope/route/session.revision 复核，不截断成功 |
| core `POST .../session` | 原 executionId/opencodeSessionId + verified actor → 原 `{session}` | 原子建会话/合法已知绑定选择，不能接受 user 授权；所有变更用 CAS |
| core `begin_turn` | Trace ref、request_key/hash、message、evidence_hash、continuation、expected session revision → session/message IDs、seq、revision、fence、lease、最近 24 条历史 | 私有接口，仅服务端受信运行器调用；credential 仍有当前 read+write，不因是 loopback 就跳过权限 |
| core `checkpoint/renew/finish_turn` | session/request、owner、fence、消息 expected revision、累计全文/终态/真实 upstream → 新 revision/状态 | 绑定同一 credential actor/Trace/current turn；不能更新别的 request/message；finish 原子且可幂等 |
| Next `readFaultDiagnosisSession(request, executionRef)` / `ensureFaultDiagnosisSession(request, input)` | 使用现有兼容身份 resolver、origin 限制、无 redirect、字节/时间预算，直接保持原 route DTO | 从 core profile/显式映射得到 principal/workspace 与现有模型领域用户名，禁止 payload.user 授权或失败后查 Prisma |
| Next `openFaultDiagnosisTurn(request,input)` | 复用 `readTraceEvidence` + begin；返回受限 turn handle、完整验证证据、history 与可信模型身份 | handle 仅服务端，不返回 bearer/私有 scope/绝对制品路径；不能导出原 token 到磁盘 |
| Next `checkpointFaultDiagnosisTurn/renewFaultDiagnosisTurn/finishFaultDiagnosisTurn` | 由 handle 保留稳定 key/owner/fence/expected revisions，封装原累计消息与 upstream 结果 | 与 SSE 串行队列配合，不自行偷偷重试一次模型调用；成功终态提交前禁止 done |

沿用原公开路由，在 core mode 分支接 helper；原模式继续原实现。拟每条用户消息 UTF-8 上限 1MiB、助手累计 8MiB、历史响应 16MiB/最多 10000 条（超限明确 413，不能只返回最近 N 条伪装完整历史）；提示词的既有 24 条/8000 字符截断是独立可见的 prompt 规则。Evidence 仍受 §9 16MiB，不因消息预算变化放宽。续租/checkpoint HTTP 为短请求，原 SSE 仍采用原运行超时默认 5 分钟、maxDuration 600；客户端 timeoutMs 需服务器范围校验，不能任意无限扩展。对应实现为TraceDiagnosis、diagnosis.ts、diagnosis-stream.ts及原路由core分支；读写/重试/取消与最终验收边界见实施状态。

### 10.6 三库迁移与旧数据保留

- 拟新增 `schema/{sqlite,postgresql,opengauss}/006_trace_diagnosis.sql` 与同字段 catalog，绝不改 001–005 字节；schema_meta version/checksum 遵守已有顺序追加/校验。三库 PK/FK/状态/范围/不可变触发器与 CAS 合同一致，SQLite 额外严格整数 CHECK；PG/OG 不依赖不兼容的 UPSERT/JSON 操作。需要给 relational source_evidence 增加已应用版本的 catalog hook。
- 现有 v5 数据不自动升级；仅显式 backup→验证备份与当前 prefix/checksum→迁移事务→核对表/旧行不变。006 本身只建空表，不给每个 Trace 虚构空会话、不搬模型配置、不改 CH/head/source_revision、不改业务默认库。实际同步范围由主任务授权。
- 旧诊断历史导入属于显式迁移器：只读导出原 Session/Message 和已验证身份/Trace 别名映射，保留旧 session/message IDs、完整 content、原时间、upstream 归属；按固定导出次序分配 seq，不能凭同毫秒 createdAt 编造确证顺序。没有可验证 actor/Trace/上游关系的条目隔离报告，不按旧 payload.user 自行认领。幂等复入校验原 ID 与内容，冲突停迁，不 merge/覆盖目标；保留旧库和导出校验清单。
- Trace 删除立即通过 locator/deletion_requests 屏障让会话及消息不可读写，历史不物理 cascade；后续物理擦除须进入同一删除队列/保留策略，不能把当前“不可访问”宣称为已完成合规擦除。Agent 删除旧逻辑继续只处理旧数据；本切片没有“删 Agent 自动删新库全部历史”能力。

### 10.7 实施顺序与可证明的完成门槛

建议完整接通范围是“原故障页选择 core Trace → 已授权历史读取 → 取 §9 精确证据 → 原 Agent/SSE 运行且成功/失败的自身 Trace 完整持久进入 core → user/assistant checkpoint/upstream 在 core 重启后可恢复 → 原页面续聊/新对话/合法历史分支”，其中 SSE/模型仍由现有 Next 运行器执行。仅建表、只改 GET、关闭自身 Trace 记录或旁写两份库均不足以声明接通。

开发顺序明确为：先完成 §9 共享取证的真实存储验证及应用全量零失败；再在单独授权的前置切片实现/验证 core recorder 与受信工作区 hook；最后才实施 006 两表、Next helper 与原 SSE 接线。core recorder 必须完整保留原 messages/tool/失败 Trace，诊断 upstream 原公开 task/execution ID 通过可信映射保留，内部 OTLP 身份可规范编码但不得用新随机公开 ID 破坏旧关联；与被诊断 Trace、request key 和真实 actor/workspace 的关系由服务器确定。相同来源快照重试复用稳定 ID、source revision、内容 hash 与 receipt；修正快照才推进服务器分配的 source revision，不能重放时按时间戳另造版本。核实成功、失败、流中断及部分 sink 失败后的完整正文读回与幂等恢复后，才允许开放 core SSE；此之前原 core 诊断入口保持明确不可用，不能以两表先上线宣称闭环。

先 RED/GREEN 验证：同 Trace 的 task/execution/internal 别名归一、并发首次创建唯一、跨租户 FK、seq 两条原子分配、同键异输入冲突、两个并发轮只有一个模型启动、同一全文 checkpoint 幂等、终态不可修改；member/owner/admin/viewer/共享/API 能力边界与 payload.user 伪造；SSE text/done 必须排在 durable 提交后、队列超限/存储错不发假成功；失权/删除/过期 lease/新 fence 使旧 worker 失效；重启可读原始完整消息/upstream，null 新建与已知历史分支可用、未知 upstream 不串话；没有任何 core 分支调用 faultDb、旧 db Session、旧报告或旧 Prisma recorder；core recorder 在成功/失败/中断路径均被真实调用，原始 messages、tool 参数/结果和错误证据逐字段读回一致，稳定原 ID/source revision/receipt 重试不重复，不能通过移除 `recordTraceAs` 让测试表面通过。三库真实事务及隔离 HTTP/SSE mock Agent（清楚标 fixture，不冒充真实 LLM）分别取得证据，旧模式定向回归通过后再由主任务决定浏览器与真实模型验收。

诊断自身 Trace 的 core recorder 是本切片的强制前置和完成门槛，不属于可丢弃的后续项。AgentDebug 报告、DiagnosisRun/诊断输入长期冻结、评测/修分、RAS 事件与优化/重测仍是独立待迁领域；这些未切换前明确保持待后续，不用空成功或旧 Prisma 影子写宣称完成。本节已按用户后续授权落地DDL、helper与原路由；AgentDebug与SkillsAnalysis报告按§11同步实施，DiagnosisRun等其他领域仍不计为本切片完成。


## 11. Trace 报告的 core 存取与冻结输入（2026-11-13，已授权实施）

本批次保持所有产品前端及既有 AgentDebug、SkillsAnalysis DTO。优先接通 Trace 页诊断报告、独立 Skills 核验和诊断追问读取报告；依赖尚未迁移 Experiment/Case 的 DiagnosisRun 不据此声明完成，core 请求不得回退读取旧 Trace。

实施顺序：先为追加迁移 007 的两表写隔离 SQLite 行为与约束失败用例；补齐三库 DDL/catalog；实现 Python 领域模块及 HTTP 适配合同；接可信 Next 上下文、既有报告 API 和执行器；最后跑定向隔离测试、三库合同及真实 HTTP/CH 验收。001–006 不改写；旧数据仅经已授权备份迁移路径升级。新报告不写旧 Prisma。

### 11.1 追加两表

`diagnostic_report_runs` 以 `(workspace_id,report_id)` 为主键，保存 `trace_id`、`kind`（agent-debug/skills-analysis）、`actor_principal_id`、可空 `request_key`、`execution_id`、`interactions_hash`、`generator`、`scope_fingerprint`、`evidence_hash`、`evidence_ref`、`lease_secret_hash`、`status`（running/done/failed/skipped）、可空 `payload_hash/ref`、可空 `progress_hash/ref`、可空 `error_message`、可空 `lease_until_ms`、`revision`、`created_at_ms`、`updated_at_ms`。身份、快照、生成器和创建时间不可变；revision 从 1 单步增加，终态不可重开。引用 Trace、actor 的 FK 不能跨空间；`(workspace_id,actor_principal_id,kind,request_key)` 唯一，重复 key 必须同输入。

`diagnostic_report_heads` 以 `(workspace_id,trace_id,kind)` 为主键，保存当前 `report_id`；四列复合 FK 约束报告确属该空间/Trace/种类。切换 head 保留旧运行与旧证据，新旧后台任务不能相互覆盖。删除公开报告只移除当前两个 head、阻止旧任务重新发布，历史制品进入既有保留/删除策略，不冒称物理擦除。

ID、hash、类型、状态及毫秒非负范围由 CHECK 约束；SQLite 额外严格整数 CHECK，PG/openGauss 使用 BIGINT。运行和 head 分别按空间/Trace/种类/创建时间、actor/request_key 索引；007 三库字段与 catalog 对齐。完整 evidence（16MiB）、报告 payload（8MiB）和 progress（1MiB）存放私有内容寻址 JSON 制品；表里只保留 hash/ref。制品正文可有任意合法 JSON 扩展，但不能把认证 token 写入路径、manifest 或诊断元数据。

### 11.2 授权、冻结与发布

GET 按当前 Trace read 权限取当前 head，制品 I/O 后重新授权并复核 head；POST 需要 execute 和工作空间 write（用于实际执行器自身 Trace 录入，不要求来源 Trace 的 write），调用 §9 TraceEvidence，并在报告写事务中重核 route/incarnation/epoch、完整 head vector、annotation、aliases 和 actor/scope，之后创建 running 运行及 head。Next 提供的 expectedSnapshotHash 必须等于服务端重新取证结果，防止模型使用与持久化版本不同的输入；可信 ALS 固定真实 actor/workspace，body.user 不作为授权。

后台 PATCH 必须携带 report_id、当前 revision、仅服务端持有的 leaseToken，并满足当前 head、未过期租约、原 actor/execute 权限及 frozen scope。每次进度 checkpoint 串行推进 revision 并续租；终态先等待进度写完，再发布完整 payload。旧任务、删除后返回或失去授权的任务一律不能发布；错误不写旧库。租约过期以 failed/stopped 暴露，后续显式重跑创建新运行。DELETE 要求 delete 与来源 Trace 的修改权限。

### 11.3 后端接口与原执行器

私有端点为 `/v1/compat/observe/reports/{kind}`：GET 取 row/payload/progress，POST 创建或返回 cached/busy；PATCH `/{reportId}` 发布进度/终态，DELETE agent-debug 清除当前报告及 Skills head。所有响应去掉制品绝对路径、scope 指纹、lease hash 和认证 token，leaseToken 仅 POST 私有返回给 Next 后台闭包，原前端 DTO 不增加该字段。

Next `withCoreReports(request,action)` 提供受信上下文给 execution-resolver、report-store 读取及追问 formatter；core 缺上下文不能走 Prisma。报告 API 的 core 早分支沿用原 runner、正常的运行/缓存/跳过/失败 DTO。深层通用 Agent 用 `runWithTrustedCoreAgentContext` 固定模型、工作目录和 core recorder，成功失败都保留自身 Trace，不只记录报告文本。

完成门槛包括：同空间不同 actor/私有 Trace 隔离、跨空间拒绝、force 新运行及旧结果 CAS、完整证据/扩展与显式 null、并发注解或 source head 改变拒绝、撤权/删除竞态、进度与重启后报告恢复、报告与 Skills 真执行和失败 Trace 均留在 core。仅建表、Mock 路由或一个报告 fixture 不代表诊断全功能容量验收。


### 原诊断请求的鉴权兼容

原apiFetch未对`/api/fault/diagnosis/`附Key，旧接口无鉴权因此没有暴露此遗漏。仅扩展现有同源请求的Key路径匹配，保留原Key优先级、localStorage退出/切换语义及URL前缀；不引入新Cookie/登录态/密码页。页面、组件、登录页和auth-context保持原基线源码，api.ts仅为诊断请求附现有Key。授权仍由原Key验证、私有身份映射与实时IAM范围决定，body.user和executionBrief不参与身份选择。


### 11.4 当前代码与分层验证记录

007 三库 DDL/catalog 已冻结；新增运行表与当前指针表，通过复合 FK 阻止跨空间/Trace/报告种类引用，直接 SQL 也不能改冻结输入、写终态或用半空 hash/ref 对绕过 CHECK。报告正文及 progress 在制品 I/O 前先校验来源权限、原 actor、租约与当前 head，I/O 后再次核对，撤权优先于制品损坏；创建也先要求 execute 与工作空间 write，不能由只读或无法录入自身 Trace 的凭据写入孤儿证据。kind、revision、requestKey 冲突及当前 head fencing 不依赖进程内 Map。

原两个 AgentDebug/Skills API 已增加 core 早分支；可信 `withCoreReports` 同时给既有 report-store 读取、execution-resolver 和追问 formatter 使用，core 缺少上下文时不读旧 Prisma Trace。后台完成、失败、进度统一走 core CAS，模型/lease secret 不进入原前端 DTO。完整 Trace Evidence 在开始时绑定，原 AgentDebug 输入与最终报告文件均写读同一受信工作目录，不能只把通用 Agent 调到另一目录。

Skills 核验继续使用原 LLM 业务步骤提取：相同 batch 大小、原提示词和合并逻辑，输入改为冻结 interactions，跳过旧 Session/ExecutionMatch 缓存；提取、计分、建议模型的自身 Trace 通过受信 recorder 进入 core。core 提取最多四个 batch 在途，所有 batch 的结果保持原序，失败录入也必须 await；legacy 分支的调度及业务流程不变。安全的 indexed 自身 Trace 回执随报告制品保存，上限 4096，仍受报告整体 8MiB 预算。

进度事件按既有格式与脱敏规则保留，串行推进 revision；启动实际 Agent 前先完成权限 checkpoint。静默长任务每 15 秒以同队列 checkpoint 续租 15 分钟租约，队列/授权失败会中止共享 AbortSignal，传递到通用 Agent 及直接模型分支；不因默认报告允许长跑就人为缩短原 timeout。模型返回及全部自身 Trace 的 indexed 回执确认后才发布成功，不以 accepted/prepared 当成功。

当前已取得的分层证据：报告领域 SQLite、实际 PostgreSQL、官方原生 openGauss SHA256 驱动各 19 项通过（含预授权不落制品、撤权优先、删除后发布、快照变更、CAS、SQL 约束与模糊提交恢复）；5→7 数据保留证据由 schema agent 保存。Next 可信上下文/报告生命周期 10 项、实际文件路径与冻结 LLM 提取/并发管线 4 项定向通过，与既有报告定向回归合计 37 项通过；这些模型响应属于受控 fixture，不是外部模型质量或生产容量验收。真实 OpenCode provider/文件工具、完整 Next HTTP、原浏览器及最终全量门槛由主任务继续验收并记录，尚不能据此声明本节或全产品迁移最终完成。

#### 11.4.1 响应丢失的精确恢复

Next 为每次 POST 固定私有 requestKey 和随机 leaseToken，同一次 RPC 最多三次重发完全相同的 JSON 字节；认证、权限、版本冲突及输入错误不重试。服务端只持久化 lease 的 SHA-256。重复 begin 需要当前 actor/授权/报告 head、一致的冻结输入和 operation body hash，并用同一 secret 取回该 running 运行的租约；不能依赖重新读取后来已改变的来源 Trace，也不会给其他调用方泄露租约。进程关闭后仍可读取持久化进度，过期运行需显式新请求重跑。

PATCH 同样固定 requestKey、expected revision 和完整字段；operation key/base revision/body hash 随已有进度制品保存，终态发布也保留该私有回执。只有当前 head、原 actor/授权和 lease 均有效，且恰好推进一次 revision、回执内容逐项匹配时，才可重放已经提交的结果；不同字段、旧 head、已被后续操作推进的旧回执均拒绝。并发相同操作在最终写事务中也不会再次推进版本。回执和私有 lease 不进入原报告 DTO。DELETE 不盲重试，以免删掉新建的报告 head。

定向测试模拟 begin、进度及终态提交后响应丢失，确认同一实际 Agent 只启动一次、进度不中断、完成结果可恢复；额外覆盖不同载荷重放、旧回执/新 head 拒绝与同时到达的重复提交。该协议覆盖有限网络重试，不声称 Next 进程崩溃后自动恢复仍在执行的模型任务。


## 12. 已授权增量：Dataset 版本资产、回流与 Trace 批量生成（2026-11-13）

用户确认按资产/数据集→实验/评测/结果顺序继续。本批保持全部原页面和原Dataset/Generation DTO及入口，复用原字段规范化、采样/去重/Trace分析算法；迁移共享数据集存储与Trace生成job/source/publish，禁止只迁普通CRUD而让生成结果写旧表后不可见。原有Prisma模式保持；core模式无隐式旧库兜底，旧数据迁移另外明确执行。

### 12.1 资产与事务

复用001资产identity/draft/release/seal/alias、IAM asset ACL与私有hash制品。内部identity name为稳定key，显示名称保留原DTO，允许不同账号或同账号同名数据集。Dataset原文允许有限小数与Unicode键，采用UTF-8 JSON文本envelope封装到既有manifest-json/v1，禁止修改canonical_json协议。草稿只保存有界summary与成员manifest引用，样本正文/参考答案按独立不可变制品保存；私有gold不经通用artifact下载暴露。每次普通保存形成可供后续运行冻结的内部不可变版本，不把内部seal变成新公开发布权限要求；未来显式公开发布另行鉴权。

008追加dataset兼容head/操作回执两表：head保存原dataset ID→asset ID、当前draft/release、live生命周期及单调版本/删除屏障；receipt按workspace+真实actor+kind+operation key保存请求摘要及精确结果。字段、CHECK/PK/FK/UK/索引补齐到机器目录和字段字典，001–007字节不变。真实owner/组ACL由IAM决定，body.user不得授予权限，builtin/benchmark只读由内核强制。新建归属、草稿/成员、seal/alias、head与receipt同一事务；删除只做tombstone并保留旧版本/run引用，恢复递增屏障使旧worker仍失效。

字段与关系以[核心表字典008–009节](core-table-dictionary.md#008009-dataset版本资产操作回执与生成任务)及[008机器目录](../../../services/storage/schema/dataset-catalog.json)为准；该节列出head/receipt全部28字段、三库类型、PK/UK/FK/CHECK和索引。截至008为45张事务表+13张CH表=58张；009后当前为46+13=59张。

### 12.2 CAS、重试与回流

读取提供HTTP ETag；原组件在打开定义、行编辑、字段编辑或批量导入时捕获该次读取的ETag，保存/删除携带该草稿基线的If-Match，不新增可见UI。不使用全局账号/数据集最新版本缓存替换旧草稿的基线；完整Case与head版本不一致时拒绝编辑。并发或陈旧修改明确409/412，不自动重新覆盖；原错误展示保留。兼容不带版本的内部调用只能宣称请求内CAS，不冒充旧页面防丢更新；后台任务必须显式传版本/fence。回流追加在最新head下重算原taskId去重并原子提交，多条中任何无效输入均不部分写入。网络模糊提交只有限重投同operation，不生成新版本/新case；精确重试返回保存的原响应，而非按最新状态重算。

### 12.3 Trace生成任务

同批迁移原catalog、source capture、任务create/progress/claim/renew/stage/recover/complete/fail/cancel/delete与删除查询。009按最小必要字段追加生成job控制状态（字段以冻结目录为准），operation receipt复用008；任务配置/进度/summary及源成员放私有hash制品，不存超大JSON控制列。可复用现有work lease/fence的地方优先复用，状态转换必须在内核领域方法中原子完成，禁止网络仿Prisma transaction。

生成任务31字段与约束见[dataset_generation_jobs字典](core-table-dictionary.md#dataset_generation_jobs)及[009机器目录](../../../services/storage/schema/dataset-generation-catalog.json)。008/009合计新增3张事务表、59字段；三库DDL、实线FK/虚线制品和CH关联图统一见字典，不另设影子字段定义。

Source capture按真实授权scope冻结来源Trace及准确heads/sections摘要；保留原registered agentId或framework/name/clientId身份键，不能把同名Agent误合并。生成专用事件投影只读取算法实际使用的完整user/assistant文本与工具名称/flags，工具大正文不跨边界进入JS或被截成完整结果。已有source原文与hash保持不变；不能靠增加源revision回填旧派生值。进度checkpoint、心跳续租、取消/删除/撤权及旧fence检查覆盖实际worker生命周期；完成须同事务校验当前job/epoch/lifecycle并发布Dataset版本、job成功与receipt。重启恢复须重新校验实际身份，不持久化明文用户token。复用原normalizer/sampling/content-processor，不另造Mock业务算法。

### 12.4 实施计划与验收

1. 先写失败测试：Dataset权限/同名/Unicode小数/CAS/版本保留/软删恢复/精确retry/回流去重；008追加三库DDL和领域kernel，再跑同合同。
2. 先写失败测试：生成job状态机、租约/fence/取消/删除/重启/发布原子性及source投影；追加009并实现core repository，复用原worker算法。
3. Next沿原API加core分支/可信存储上下文，共享dataset repository供后台调用；原请求字段验证、readonly、根因缓存与DTO不丢；补传输层ETag并行为测试。
4. 用新隔离目标备份/升级，运行真实CH来源→Trace草稿→批量回流→Dataset列表/字段/Case编辑→版本冻结→Trace生成/进度/取消/删除；核对旧库零影子写、原页面源码/可见交互及旧模式回归。
5. 跑全量npm、Python、类型与必要三库合同，保留日志和截图，更新实施状态/中英文指南/字典与日记；本批结果不外推实验/评测/Benchmark完整迁移及千级容量。


## 13. 实验、评测结果与 RunPlan 消费者（2026-11-14）

用户已授权继续实施剩余消费者，保留全部原功能和可见界面，沿用独立环境；本节细化既有phase2运行/结果设计，不改变默认库或引入新的评测运行服务。

### 13.1 数据权威与版本

沿用001的runs/run_inputs/work_items/work_attempts/result_receipts/result_selections/outbox，而非跨HTTP模拟Prisma事务或建立可变machine score副本。原Experiment是可编辑业务容器，一次启动、重测或监听追加分别产生新的immutable RunPlan；旧RunPlan、输入release和结果回执保留。稳定外部Experiment/Case/Result ID经控制索引关联内部run/slot/attempt；case正文、分组、配置、进度和结果包均存私有hash制品，OLTP只保存检索键、状态、revision和引用。扩展字段保真；score等分析事实物化到现有CH eval_result_facts/eval_metric_facts/selection/publication表。

010追加八张最小控制索引：experiment_heads（业务容器/当前配置与生命周期）、experiment_runs（多次RunPlan与外部实验关联）、experiment_cases（稳定Case ID/归属/正文引用）、experiment_result_slots（稳定Result ID/当前work与selection）、experiment_attempt_checkpoints（阶段/command/Trace绑定和CAS制品）、experiment_annotations（review/comment不可变审计）、experiment_operation_receipts（精确重试）、experiment_judge_traces（私有评分自身Trace归属）。011另追加diagnosis_runs/diagnosis_judge_traces两张不可变来源和私有自身Trace索引，复用001状态/租约/报告结果。完整三库DDL/catalog/字段约束已补齐核心表字典010–011节，001–009字节不变。物理表计数以实际迁移目录为准，不提前宣称已实现。

创建RunPlan必须在一个领域事务内固定Dataset release、有效FI目录、Case顺序、Agent/Skill/Evaluator定义、运行参数和版本摘要，并建立run归属/输入/槽；不能在异步worker重新按用户名读取可编辑最新定义。执行端只获public输入；reference_output、根因和评分规则仅评分协议可读。自建Evaluator原页面整体列表读写须绑定真实actor与CAS，冻结定义可复用资产release；内置Evaluator由可信服务器目录提供快照，不能按客户端声称赋予系统身份。

### 13.2 执行、结果与取消

Python ExperimentStore提供明确领域动作：create/list/read/runplan/start/claim/renew/load_work/complete/fail/retry/cancel/reconcile/review/comment/remove及必要Case/Trace绑定操作，禁止任意模型/SQL/where透传。read/list返回有界typed snapshot，Next沿原DTO与纯聚合构造响应。领域方法同事务校验当前IAM、资源归属、生命周期、case revision、RunPlan hash、当前Trace attempt及fence；慢制品/CH访问前后重新校验，token不得持久化。

Next抽离原executeResultRow的评分部分为冻结输入执行接口，继续复用evaluateOnce、全部preset、自建Evaluator、重试/超时/cleanup与取消信号。领取/续租/回调用真实attempt/fence；重试新attempt，重评产生新result，原machine结果保留。取消、Case删除、Trace替换和恢复均使旧写入失效，外部client/Benchmark回调也必须携带当前绑定，不能只用同名ID更新。

机器结果包先持久化，再同事务完成receipt、选择、任务终态和Outbox；CH分批写事实/metric/selection并校验数量/hash，确认indexed后才发布完整结果成员。原0..100机器分与兼容0..1视图转换沿原纯函数；missing/failed/inconclusive不得填零或进入错误分母。humanScore修改或清除是独立版本审阅事件，保留原因/作者/时间，评论也是追加审计；重评可清当前人工覆盖但不删历史。

Judge/worker自身Trace可能包含gold prompt，须独立归属/可读范围，不能继承执行端public共享。组管理员读取业务记录不授予gold或他人模型凭据；user参数仅为兼容展示或已验证配置定位。

### 13.3 消费者与实施顺序

1. 先实现010/ExperimentStore及SQLite/PG/openGauss合同：冻结输入、幂等创建、真实租约/fence、取消/重试、receipt、人工审阅、CH重投/发布屏障；旧前缀不变，三库显式迁移保留数据。
2. 接原实验创建/列表/详情/Case/结果/评论及原执行入口；Dataset调用使用可信上下文且引用冻结release，不让原后台落回Prisma。原DTO构造优先复用detail-agg及comparison纯函数；原评分算法不另写一套。
3. 扩展对比、Trace生成/外部执行、取消协调、监听/重扫、同配置复测与Benchmark异步回调；原环境准备与命令回收逻辑保留，明确所有未覆盖入口，不能返回伪成功。
4. 逐项迁移TrajectoryEvalResult的直接运行/追加/重试，以及Evaluation/SkillIssue详情、DiagnosisRun与实验结果引用。TraceEvaluation在当前源码未发现活跃调用，保留在历史语义迁移清单，不因旧表存在新增业务。
5. 用独立HOME/Prisma壳库/core/CH验证原界面：Dataset→实验→执行→Case/结果→人工分/评论→重评→取消/重启；核对旧表内容指纹、fence/撤权/跨组、同配置和多版本不漂移。全量npm/Python/类型、三库专项与浏览器结果分别报告，保留失败尝试；不外推生产迁移或千级容量。


## 14. Benchmark 外部执行、评测与回调接管

本节延续用户批准的完整后端重构。Benchmark仍保留原Adapter、执行器和外部Evaluator服务，以及现有页面、任务契约、输入拆分、产物验证、评分归一化和展示。012仅追加以下五张控制索引；机器分数、metrics和证据结果继续使用001的不可变result receipt/selection与CH事实，不建立第二份可变score。实施前001–011保持字节不变，当前服务不得隐式升级旧目标。

### 14.1 五表与内容权威

| 表 | 逻辑字段（`T`=TEXT，`I`=严格64位整数，`?`=nullable） | 主键、关联和索引 |
|---|---|---|
| `benchmark_dataset_heads` | workspace_id T, dataset_id T, public_dataset_id T, public_asset_id T, public_release_id T, private_asset_id T, private_release_id T, adapter_key T, content_hash T, state T, revision I, lifecycle_revision I, created_by T, created_at_ms I, updated_at_ms I | PK(workspace_id,dataset_id)；public Dataset→008，两个release→001 seal，owner→IAM；空间+adapter+state及public Dataset唯一索引 |
| `benchmark_experiment_bindings` | workspace_id T, experiment_id T, dataset_id T, public_release_id T, private_release_id T, binding_hash T, binding_ref T, actor_principal_id T, created_at_ms I | PK(workspace_id,experiment_id)，实验→010、dataset→012、release→001；只追加绑定，完整selection/config保存在hash制品；dataset/experiment索引 |
| `benchmark_jobs` | workspace_id T, job_id T, experiment_id T, case_id T, run_id T, work_item_id T, kind T, parent_job_id T?, adapter_key T, evaluator_key T?, attempt_no I, retry_of_job_id T?, origin_credential_id T, origin_credential_kind T, actor_principal_id T, protocol_state T, revision I, request_hash T?, request_ref T?, progress_hash T?, progress_ref T?, completion_hash T?, completion_ref T?, callback_epoch I, callback_token_hash T?, callback_expires_ms I?, callback_attempt_id T?, callback_fence I?, created_at_ms I, updated_at_ms I | PK(workspace_id,job_id)；实验/Case→010，run/work/attempt→001，parent/retry→同空间同Case相关job；execute/evaluate协议stage与指纹在此，通用任务状态/租约/fence仍001。按空间+实验+Case+kind+创建时间、协议状态+更新时间、父job+attempt_no索引；不得跨空间/实验绑定 |
| `benchmark_artifacts` | workspace_id T, job_id T, artifact_id T, name T, kind T, media_type T, content_hash T, size_bytes I, storage_hash T, storage_ref T, contract_hash T, created_at_ms I | PK(workspace_id,artifact_id)，UK(workspace_id,job_id,name)，job→012；制品hash/ref只在私有领域读取，不作为公开路径；job/name与content hash索引 |
| `benchmark_operation_receipts` | workspace_id T, actor_principal_id T, operation_kind T, operation_key T, request_hash T, experiment_id T?, dataset_id T?, job_id T?, response_hash T, response_ref T, created_at_ms I | PK(workspace_id,actor_principal_id,operation_kind,operation_key)；三个subject恰有一个且FK在同空间；精确提交结果只追加、先实时认证/授权再回放，不重新冻结最新资产 |

上述逻辑字段在实施时由012 DDL与机器目录逐列校对，SQLite逐列`typeof(integer)`、PG/openGauss BIGINT。hash限定64小写十六进制；revision/fence为1..2^63−1且更新严格单调，时间非负且updated不早于created，hash/ref成对可空。全身份字段、封存输入/contract、结果receipt与artifact只追加；直接SQL同样受CHECK/FK/trigger限制。可变job仅修改允许的协议stage/进度/终态及受fence保护的callback能力指针；不得借JSON任意改变数据归属。

Public Dataset release只含原公共Case投影；原rawCase/privatePayload作为单独`benchmark`资产release封存。通用Dataset/API不暴露该私有manifest。启动固定两个release、Case顺序、adapter/manifest版本摘要、Agent参数定义/目标profile、所有evaluator定义以及selection；执行器只得到公开payload和允许的提交物合同。外部Evaluator可取得自己job所需的私有输入，不能读取其他job的产物或任意资产。

### 14.2 领域动作与原子边界

私有服务只提供明确动作，不传Prisma模型、SQL或任意where：`dataset_import/read/list`、`create/read/read_view`、`start`、`claim/load_work/renew/checkpoint`、`artifact_put/read`、`execution_complete`、`evaluation_prepare/dispatch_checkpoint/complete/normalize_commit`、`retry_case/retry_evaluation`、`cancel/reconcile`以及`continuation_claim/finish`。原Adapter的validate/split/build/normalize仍在Next可信运行时执行；提交内容和原算法输出通过有界hash制品交接，Python在领域事务中验证来源/IAM/版本/工作项/attempt/fence/合同及结果选择。

- Dataset公共与私有release、head与幂等receipt同事务提交。
- 实验容器、稳定Case与冻结binding同事务创建；启动时RunPlan、待执行job与结果槽同事务创建。不能先建旧Experiment再分库补写Benchmark记录。
- 每次实际执行/重评都绑定独立不可变RunPlan和真实输入release。外部job与001工作项绑定，dispatch Outbox先持久后传输；响应丢失按固定job/request digest对账，不再运行Agent。
- 外部任务被接收后，callback能力与外部attempt保持稳定；重启恢复既有dispatch，而不是仅因Node的短租约消失就生成新外部执行。任务超出封存hard deadline才失效，须核查/取消原进程，再显式新attempt。
- 接受执行completion后只进入submitted；产物合同与digest核对通过后构建Evaluator job。raw completion先存不可变制品；归一化失败可重试保存同一raw结果，不能重跑Agent或悄悄改raw completion。
- `normalize_commit`同事务写machine receipt、selection、job终态、CH Outbox及continuation意图；旧结果保留。补充评估器仍调用已有冻结Experiment scorer，只有真实Trace indexed后才能交接。
- imported submission保留原入口语义：跳过Agent执行，固定原提交物/合同后直接评测；不伪造execution Trace。
- 取消/删除立即推进实验/Case生命周期屏障。外部进程未确实退出继续显示pending，旧callback即使晚到也不能覆盖新attempt或重新发布结果。Case/结果retry CAS绑定明确上一job/attempt，旧human review历史保留。

### 14.2.1 明确失败的无分数结果与分类器

启动在同一RunPlan下为每个Case预建唯一primary评分工作（`phase=publish`、实际evaluator slot、queued），并绑定稳定result slot；该工作等待执行提交，不能被普通评分器领取。正常`evaluation_prepare`复用这项工作，不另建同Case/slot评分工作。transport执行工作仍使用`__execution__`，不写伪造评分；publication等所有工作确实终态，成员只包含真实评分工作。

平台可确定的失败分四类：execution（有效设备completion明确failed且cleanup成功）、submission（可信冻结Adapter拒绝已封存提交物）、dispatch（首次派发得到可信、明确未启动的拒绝）、preparation（尚无sealed dispatch/outbox即可确定未启动）。`dispatch_unknown`、网络错误、超时和未确认清理不得当作确定失败，更不得产生0分或伪造Harness/模型完成。

每个失败job仅有一条独立、不可变的012 operation receipt：kind=`failure-source`、key=`source:<job_id>`、subject=job，response制品format=`benchmark.failure-source/v1`。制品包含ws/experiment/run/case/job身份、失败stage、request/completion hash、必要的已验证transport/设备证据摘要、failureCode及明确的not_started/cleanup判据；不含callback cap、原API明文或机器分数。当前job终态和制品内容必须一致。receipt hash为`failure_source_hash`；progress可以展示诊断，但不作为可变权威覆盖此receipt。

`classify_failure`是私有controller-proof动作，输入仅job/source hash与幂等键，不接受任意score/normalized body。实际平台分类器领取这项primary工作，建立真实worker=`benchmark-failure-classifier`的attempt/fence/checkpoint；检查当前Case/RunPlan、source ACL/origin、唯一primary slot、work/fence及冻结membership后生成不可变`status=failed, score=null`机器结果。evidence明确标注execution/submission/dispatch/preparation来源及failure source hash，明确评分Harness/评测模型未运行；不增加外部Harness运行次数。已有相同source的选定失败结果精确重放，其他选择/新attempt绝不能被旧分类覆盖。

分类、selection、slot终态、标准CH result Outbox和failure intent收敛同事务提交。标准事件使用`benchmark_failure_job_id`与`benchmark_failure_source_hash`，gate另验该job的Exp/Run/Case、不可变失败源以及receipt真实classifier attempt→primary work/slot；正常external评分继续使用`benchmark_job_id`并严格等于callback attempt。新增明确恢复意向`benchmark.failure.classification.requested.v1`，与dispatch/execution-completed/raw-normalization一样可在owner+proof范围恢复；未知transport只退避/对账，不进入分类。

### 14.2.2 补充评分与可恢复交接

primary normalize提交后，只有存在已冻结非benchmark评估器才保留continuation intent。原actor后台以当前可信token处理`finish_intent(operation=prepare_continuation)`：先从对应execute completion读取Trace身份，在写事务外读取真实TraceEvidence；事务内重验origin credential、当前primary receipt/selection、Case/parent生命周期、源资产和indexed屏障。Trace override只进入独立child RunPlan的Case快照，不修改稳定Case行或primary输入。config/releases/model/评估器定义全部复制父plan，公开body不能提供覆盖；真实Trace body按当前indexed内容一次封存。

child评分使用010原生evaluate工作、真实attempt/fence以及原generic scorer，primary slot/receipt保留在原run。`trusted_parent`仅对`head.scope=benchmark`、存在exact binding、slot=`benchmark`（或经真实parent核验的`benchmark:origin:<job_id>`）且release恰等于binding.private_release_id时，复用公共Dataset映射授权；普通start和任意其他私有release仍要求原asset权限。child创建与continuation receipt、intent终态同事务，精确重投不会创建第二代child。未indexed/权限失效保持有限退避；执行completion明确无Trace时，独立child工作由`benchmark-source-classifier`真实claim/checkpoint/complete failed-null，标注未运行评测模型，不伪造Trace。source_classification记录job/completion hash/primary result。child的`benchmark:origin:<job_id>`输入marker在通用claim/load/renew/complete和投影前以纯SQL验证原credential live scope和run权限；不必等待到模型执行后才拒绝撤权。

运行时Legacy client路由使用Node从可信actor.username生成并封存的`run_config.legacyOwner`；公开同名字段被覆盖。callback若有实际device owner须与该字段一致；缺失旧多Case映射返回503，不猜IAM登录名。IAMA权限始终使用principal/origin credential/source/fence，username只用于既有transport client归属查找。

### 14.2.3 受控历史提交物导入

保留已存在的历史imported语义，提供内部typed helper，不新增页面或公开上传入口。可信Node创建Draft时由内部参数封存`submissionSource=imported`，跳过不存在的Agent client/profile和buildAgentTask预检；普通create不接受公开source覆盖。Draft的公共Dataset、私有gold和evaluator定义仍按原规则冻结。

`import_submissions`只允许原owner、controller proof、未启动Draft及确切imported binding；先查独立012幂等receipt，再校验同键内容。一个领域事务创建完整RunPlan、每Case真实import-worker attempt/checkpoint、合同校验的不可变制品和submitted completion及evaluation intent。真实工作是提交物导入，不声称Agent执行，不派发外部command，不创建callback cap，不生成Trace。任一Case/bytes/hash/合同不合法时事务整体回滚，不留半job；Draft容器仍是可审核的独立操作。每artifact≤64MiB、整个请求≤128MiB、≤10000Case；允许合同合法空文件和安全Unicode相对路径，私有对象引用不对外暴露文件路径。

随后沿已验证的真实Adapter验证、外部Evaluator dispatch、raw/normalize、receipt/selection及CH投影链恢复。原DTO标明imported；普通Agent启动/配置复用拒绝，重评仍需专用新job/RunPlan及清理约束，不能走普通Agent retry。

### 14.2.4 专用重评、重跑与取消协议

手工重评以当前真实owner及read/write/execute授权建立新origin；历史session过期不阻止当前授权用户复用其合法历史提交，旧callback的原origin仍必须有效。`prepare_evaluation_retry`仅controller-proof读取当前primary slot选定机器receipt、最新evaluation及原提交物；`retry_evaluation`按旧job+machine ID CAS，实际旧exec/eval均须确认cleanup，创建独立的单Case/primary评分RunPlan、新job ID与attempt_no/retry_of_job_id，复用同一原execute parent。012 parent关联允许跨run，但新plan记录精确来源。新计划只复制父冻结release/定义/model，不重冻latest；旧receipt/selection/human review全部保留。重评attempt>1按原规则不重跑补充评估器。普通generic plan mutation继续拒绝，不能借重评接口覆盖任意score。

Case重跑同样CAS旧execute job与当前primary机器选择；imported禁止Agent重跑，Case尚有active work/continuation或未知清理时拒绝。确认收尾后复制父冻结plan，仅为该Case创建新execute job、primary work和RunPlan；其他Case可以继续，并发仍由真实claim预算约束。重复相同操作键只回放原receipt，两个并发不同操作只能一个赢得旧来源CAS。

Node专用Case重跑消费者先精确查操作回执，再读取旧job/机器选择并CAS，公开请求不提供config、model或release覆盖。新job在启动事务即持久化`benchmark.execution.prepare.requested.v1`。并发或外部评测预算满时保持pending；独立后台可在额度释放后直接领取新RunPlan，无须依赖旧run的callback补队列。仅无sealed request的纯准备允许租约到期后提升fence重新领取；已sealed/dispatch_unknown任务只恢复相同外部身份，不另起attempt。已取消但尚未取得exact cleanup receipt的Agent或外部Harness继续占相应并发/预算；原生补评使用独立scorer调度与native cleanup证明。

取消/删除仅需当前真实delete权限，不借execute读取gold。`cancel_request`原子封存真实外部目标、原run/client/kind/requestDigest，写010 cancellation注解、012 receipt和durable intent，并推进实验/Case生命周期、cancel_requested和fence，普通callback立即失效。未派发（没有能力/外部请求）、import step或已有不可变cleanup成功可确认无外部残留；dispatch_unknown等均pending。

独立`cleanup_confirm`只处理该已封存目标。Node必须先持久绑定真实取消command ID再派发；设备command需核对user/client/action/payload原kind/runId/requestDigest及真实返回cancelled，不能仅凭SUCCEEDED。Evaluator仅向封存目标发原requestDigest取消并核对真实返回runId/cancelled。controller签精确有限证明，领域追加独立取消target receipt和cancellation_update，不覆盖旧completion、不写分数或产物。删除barrier后仍可用当前取消actor的有效delete授权写同目标清理收据，旧cap不能通过normal complete复活。admin路径仅取最小冻结target及可信legacyOwner，不读取私有Case/gold。未知退出保持pending；retry只认已确认清理。

### 14.3 回调能力与实时IAM

源码基线的execution callback已有device认证，但Evaluator progress/complete/artifact仅按evaluationId定位。core模式必须补足可信回调；公开`requestDigest`是内容摘要，不能充当秘密。为保持原外部服务协议，新增可选`callbackHeaders`，legacy请求可省略；core派发必须带job专用的不可猜callback能力，并由真实Evaluator HTTP client在progress、artifact、complete和提交物下载时回传。

能力以独立用途域绑定workspace/job/真实attempt/fence/epoch/hard expiry及request hash。数据库仅保存能力hash、epoch/expiry/attempt/fence；明文只进入私有dispatch envelope，不进入公开RunPlan、原DTO、错误或日志。为重启恢复，可用现0600控制器密钥分隔用途派生可恢复能力；原API令牌明文不能写入job或Outbox。即使能力正确，回调仍需验证当初真实origin credential是否存在、未撤销、未过期、principal auth_version未变、组成员/空间仍有效，并检查当前实验/Case/RunPlan生命周期和attempt fence。

IAM只做内部窄factor：按已登记credential ID读取同一credential row后，复用原认证与scope构建/资源授权代码；只有已成功验证callback能力的Benchmark领域才能调用。不得增加credential-ID换scope公开入口，不复制一套较宽松的回调权限。只读凭据、删除/停用/退组或过期凭据不能通过后台回调写结果；重入组不会让旧凭据复活。

### 14.4 制品兼容修正与当前验证边界

012 checksum已冻结。013只放宽`benchmark_artifacts.size_bytes`到0..67108864，以继续保存原Evaluator允许的空stdout等0字节证据；提交是否有效仍由冻结Adapter合同/validateSubmission判断。SQLite在同一迁移事务内完整复制行、更换CHECK并重建同名索引与不可变/保留trigger；PG/openGauss只替换目标CHECK。不得直接修改已应用012的checksum，也不删除历史制品。Unicode相对证据路径保留原安全规则：最长512字符、最多16级、各段1..128字符，禁用`.`/`..`、控制字符、双向控制、路径特殊字符和段尾点/空格。

SQLite、真实PostgreSQL与native openGauss的Benchmark专项各覆盖78项领域测试及3项取消身份测试；PG/openGauss按77项主矩阵和4项补充矩阵分批验证，全部使用随机隔离schema；另有Root投影来源门测试。包含012→013历史所有表逐行不变、原artifact update/delete保护、空证据、credential撤销/过期/账户停用/auth_version/成员/空间、source ACL、真实attempt/fence、失败null分类、导入原子回滚、child来源marker及共享publicDataset不直接授予private gold权限。Node实际HTTP以隔离SQLite运行原device轮询/回调与真实Evaluator服务/HTTP client，验证普通提交75分、raw提交后归一化中断恢复且Harness仍仅1次、无client/command的imported提交75分，以及缺Trace时supplemental真实failed/null。最新Node专项15项包含7个真实HTTP场景，另覆盖手工primary重评（同一Agent、两次Harness）、Case重跑（两个独立Agent命令、两次Harness）、delete-only取消（旧能力立即失效、真实设备取消回执后收敛）；预算未知清理与独立准备恢复同时在三库验证。使用fixture提交和Harness，不声称实际Agent/模型或正式benchmark质量。

独立实际ClickHouse数据库分别验证：成功/明确失败混合四表为result=2、metric=5、selection=2、publication=2（失败score为missing而非0）；真实ObservationIngest到CH indexed TraceEvidence→独立supplemental RunPlan→fixture scorer结果两组receipt四表均为2，稳定Case.trace_id保持原值；imported四表均为1。每组均正常排空对应Outbox并读回，不手改历史事件。原公共DTO、聚合、过滤与下载复用原算法，未修改页面JSX。

专用Case/primary结果retry及取消/删除的外部清理对账现有typed实现；原生补评cleanup按实际worker身份核验，无法确认退出时保持pending。dataset admin生命周期、image preparation窗口及尚未接入的其他旧入口仍明确guard；generic start/execute_start/retry不能绕过Benchmark领域。早期未预建primary work或已sent而无publication的隔离历史需要单独受控backfill，不静默重置事件。生产切换、客户环境、千级并发容量和用户原库迁移不在本次fixture验证声明内。

### 14.5 可验证分块与完成门槛

1. 先TDD实现012三库DDL/catalog、Dataset双release、五表约束、精确receipt、live IAM callback验证；保存001–011前缀指纹，并在隔离11→12迁移验证旧表/行/制品不变。
2. 接原Benchmark数据集导入/准备、create/read/list/same-config与原DTO；正常失败必须可见，不能读空列表或回旧库掩盖未接通。
3. 接真实client命令与环境prepare、dispatch outbox恢复、progress/提交物/complete；原执行器/adapter路径、产物名/大小/hash/完整性规则不变。
4. 接外部Evaluator实际HTTP派发与带能力的回调、真实raw结果归一化、失败/重评/continuation和取消。验证请求丢失/重复/乱序、两个并发retry、改source/release、旧callback、撤权/过期/跨job、存储故障均不能错误发布。
5. 真实隔离SQLite+CH+原执行器/本地Evaluator fixture闭环、PG/openGauss域合同、原UI页面/DTO golden及应用全量测试分别取证；Mock判分不冒充真实模型质量/正式benchmark成绩。旧数据库只读备份保留；生产迁移、客户环境和千级混合容量仍须独立证明。


## 15. Workbench / Grayscale 实验消费者与跨库交接

本批保持原Workbench、触发分析、A/B和候选复测入口、DTO及可见界面。Task/Grayscale/Skill配置暂作为独立事务领域保留原控制存储，不把旧Task存在误写成全部事务领域已支持新后端；Experiment/Case/机器结果和RunPlan必须走010及001，禁止再影子写旧Experiment、ExperimentCase、ExperimentEvalResult或TrajectoryEvalResult。Task.caseStatesJson仅为带来源版本/receipt的兼容进度投影，机器分数以当前core selection为准。

### 15.1 授权与读取

所有HTTP入口先取得真实IAM映射作用域，再组合Dataset/Evaluator/Experiment仓储。请求中的user只用于兼容DTO并由已验证actor归一；后台不能用username替代凭据。旧Skill/模型配置owner别名与IAM profile username分离，透过受信上下文传递，不能篡改profile。core错误明确返回，不回退旧业务表。

实验列表、基线、执行进度、验证证据和灰度结果从完整且有覆盖声明的core只读投影复用原聚合。确需Task、客户端命令等独立控制域时显式读取其真实存储，缺失来源不能伪为空数组。A/B旧Task上的分数不直接当作当前机器分；需核对其Case、Trace、当前选择/版本后重建兼容投影。人工分和机器分、0和null、未完成与未计分沿用原合同。

### 15.2 创建与恢复的原子边界

不把跨库HTTP调用包装为Prisma事务。新建时服务器按真实workspace/principal、请求路径和operation key生成稳定Task/Experiment ID，先将prepared handoff intent同Task本域状态持久化，再发送typed core create并取得精确receipt，最后用Task本域CAS将intent改为ready。失败保留prepared状态；只恢复原封存请求，不读取或重冻最新Dataset/Skill/Evaluator，也不删除可能已真正创建或启动的实验。

intent保存原请求hash、稳定ID、已冻结Experiment输入和原Task执行配置，受64MiB实际UTF-8预算约束，不包含API凭据。原Task配置可被旧API编辑，因此不能把JSON自称trusted当作权威：以0600 controller key、独立目的`workbench-handoff/v1`、真实principal/workspace和精确manifest请求体hash签HMAC；恢复必须验证签名、actor及实时IAM。prepared阶段若当前Task执行配置已不同，拒绝自动覆盖。phase标签本身不授予权限，公开HTTP提交的伪造intent/proof无效。配置密钥轮换需先处理仍prepared的intent，不能把旧签名失效描述为已恢复。

重启恢复按签名intent重投相同operation key与原请求hash，不持有或写入原API明文。重复请求和响应丢失返回既有Experiment/Task关联；请求内容变化拒绝409。Workbench会话任务/优化记录的后置关联在自身领域单独CAS及幂等恢复，不能回滚已提交的新core资源。

### 15.3 执行、评分与扩展边界

客户端执行沿用原generateExperimentTraces及可信core work handle，在对外发命令前保存稳定命令/attempt身份；业务Trace必须真实完成且indexed后交给封存评估器。触发分析使用服务器已核对的客户端trigger decision与原evaluateSkillTriggerAnalysis算法，不能以未调用Skill的裸Trace猜测或直接覆盖机器结果。批量追加/重试以typed domain操作完成；旧Task执行claim与新的RunPlan lease/fence分别负责本域，不冒充一个分布式锁。

本地A/B与非诊断候选复测复用原runGeneralAgent、模型/系统提示/工具处理及超时算法，在外部执行前持久化`local:<真实attemptId>`。trusted publicExecution recorder把真实业务Trace写入新观测存储，旧fallback Execution影子写在core模式关闭。进程组退出检查未确认时必须返回`EVALUATION_CLEANUP_UNCONFIRMED`，不能仅凭Promise拒绝或已发SIGTERM确认停止。当前本机registry按workspace/principal/attempt定位实际controller和cleanup completion；跨实例、重启后未知目标保持pending，不猜测已停止。完成回执传输丢失按精确操作键查询/有限重投，不重跑Agent，也不补记Agent失败。单独的静态Evaluation/Skill快照控制域仍保留原存储，未宣称全部事务领域已迁移。

真实core自身Trace、selection、取消和恢复仍需对应实测。仅客户端Mock、MemoryFacts或focused测试不替代实际ClickHouse、模型/客户端及浏览器验收；千级混合并发和超大Trace容量另做负载验证。

### 15.4 派生 Issue 的解决注解（014）

新增事务表 `experiment_derived_issue_annotations`，只追加，不修改010派生Issue或001机器receipt的内容。字段为：`workspace_id TEXT`、`annotation_id TEXT`、`experiment_id TEXT`、`issue_id TEXT`、`machine_result_id TEXT`、`owner_principal_id TEXT`、`actor_principal_id TEXT`、`resolved_run_id TEXT`、`resolved_at_ms BIGINT`、`operation_kind TEXT`（固定`derived_issue_resolve`）、`operation_key TEXT`、`request_hash TEXT`、`issue_payload_hash TEXT`、`machine_content_hash TEXT`、`selection_revision BIGINT`，均非空。SQLite时间/版本为有界整数，PG/openGauss为BIGINT；hash为64位小写十六进制，时间非负、selection版本大于0。

主键`(workspace_id,annotation_id)`；唯一约束`(workspace_id,actor_principal_id,operation_key,issue_id)`及`(workspace_id,issue_id)`（保证并发首个解决生效）；索引`(workspace_id,issue_id,resolved_at_ms,annotation_id)`。外键分别关联010原Issue注解`(workspace_id,experiment_id,issue_id)`、001机器receipt`(workspace_id,machine_result_id)`、IAM owner/actor及010精确操作回执`(workspace_id,actor_principal_id,operation_kind,operation_key)`。三库触发器均禁止UPDATE/DELETE。001–013不改字节，迁移仅创建新表、索引和触发器；已有业务行保持不动，服务先停写、显式upgrade至014再启动。

`derived_issue_resolve`要求真实actor为原实验owner，并取得私有controller对精确请求的证明。一次有界批量在同一事务存储中原子写入操作回执及注解，校验每个Issue真实存在、原machine/hash/来源RunPlan一致、来源Trace仍可访问，首次写入必须仍为当前selection且Case有效；未知ID明确404、来源或selection变化409、他人/管理员代写403。已解决Issue保持第一次解决记录，不用不同run覆盖。精确重放先按actor/key/request hash查回执，再对其每个历史Issue和原来源重新授权；不把后续新generation的结果当成本次回执。返回已解决ID及本次新增数量。

读取仅在derived_list、derived_lookup、derived_detail的兼容DTO上叠加`resolvedAt/resolvedRunId`，原machine payload/hash永久不改。后续撤权、来源删除与历史选择规则沿用010。旧静态SkillIssue仍在原控制域更新；Workbench计划状态和core解决注解各自在所属库提交，跨库失败保留精确操作键供恢复，禁止把HTTP放进Prisma事务或宣称跨库原子性。


### 15.5 验证证据、归档与派生投影

普通`GET /api/experiments`及`eval-runs`、`eval-results`使用独立typed `list_view`读取实验头、实际Case标识/数量/创建时间、合法来源taskId/executionId、当前结果状态/更新时间/错误、机器分/人工分（保留0）和FI失败判定字段。`eval-results`按原runId/taskId在服务端先圈定实验，避免加载其他历史。禁止装载或拼接冻结Session、Execution、Trace正文、评论及执行checkpoint；不声明这些来源的完整覆盖，仅开放Experiment/Case/Result三个列表模型，调用未覆盖字段或模型必须失败。合法来源按原列表算法生成同样DTO，仍保留归档过滤、真实owner/IAM、分页total与评分/FI终态规则。

读取每个实验的封存RunPlan仅用于必要来源ACL/生命周期校验，不遍历或返回其Session内容；来源已撤权、删除或epoch变化时，该实验保留允许的头信息、Case数量和结果状态，隐藏机器分/人工分，不加载其Case/结果私有内容。单个不可用来源不得阻断其他实验列表，详情继续按原source guard拒绝。响应前重新校验IAM与来源；读期间来源失效时同样降级metadata，不能把旧私有结果发出。所有行/字节预算显式限制，异常或损坏的存储内容不能伪装为空集合。

选中机器receipt为quarantined时，不加载其packet及人工review，列表结果投影为failed、分数为空；合法来源仅返回固定“机器结果暂不可用”，来源不可访问时错误、taskId/executionId也隐藏。普通详情明确503，不把隔离的机器事实当作成功结果；accepted/indexed正常即时可见的语义不变。

RunPlan来源授权同时覆盖Trace和001 `run_inputs`封存资产向量。每次读取、claim、活动attempt的renew/load/complete、派生Issue/Evaluation读取与解决、诊断来源读取及CH投影，均通过已有seal/asset身份实时检查原Dataset/Evaluator等asset的read授权；存在Dataset兼容头时同时要求active。检查只读取小型关系向量，不把完整RunPlan解析加入renew；新的release、alias或内容版本不使合法历史失效，builtin/旧配置没有run_inputs时不凭空要求资产或最新catalog。Benchmark私有gold slot只允许严格匹配同一binding的private release，并通过其同样封存的public Dataset release/asset授权；不得把其他私有Benchmark资产借用此映射。列表来源失效降级metadata，私有详情/评测/投影拒绝，不能从其他入口绕过Benchmark本域的source guard。

Case结果的内部`coreResult`包含真实selected machine ID、content hash、RunPlan ID/hash和evaluation version；未选中为null，原公开DTO默认不增加该内部字段。原Task JSON只保留执行身份/进度兼容层，列表、基线、进度与Task读取均从当前core Case和selected receipt重建分数。新执行claim尚未取得actual attempt、过期attempt、待重评及未计分不会继续展示旧缓存分数；仍使用原0–100量纲、逐评估器取整及均分/tier规则。

候选行为验证沿用原样例筛选、基线复用、判分及预算算法。临时验证实验通过typed core create/Case/RunPlan完成，验证proof绑定真实source/candidate、样例hash、当前机器RowsHash与candidate hash，并以私有`workbench-verification/v1` controller目的和真实actor/workspace签名；公开编辑config不能伪造优化通过。机器selection变化或来源撤权/删除即失效，人工分与机器分继续分离。

原临时验证实验的清理是派生可见性归档：在所属OptimizationRecord的`verification-cleanup` source refs以CAS保存ID，不删除core事实/历史，也不推进来源撤权屏障。Workbench列表与普通全局实验列表都过滤同一归档集合；签名和机器来源仍合法时可复用证据。用户真正删除实验/来源则走core生命周期协议，归档记录不能复活或绕过删除。后置WorkbenchTask/OptimizationRecord关联把原前置条件封存在handoff，重复创建可补齐关联，已经链接过的旧请求不能覆盖后来选择的新source。

Workbench执行、候选验证及非诊断复测按`coreAssets.releases`精确读取封存Dataset release，不通过latest解析输入或gold；历史版本读取不写入编辑态Dataset context缓存。不存在封存release、来源撤权或回执身份不符时明确失败，不回退旧库或最新版。独立grayscale任务显式启动新轮时可先读取当前版本并封存本轮，Workbench既有实验与同配置克隆保持来源release。

取消历史仍保留原公开DTO。内部`coreActiveCancellationIds`仅标明当前RunPlan的全局取消及持续有效的Case逻辑删除；消费者只用活动集合判断可执行性和派生Task状态，旧服务缺该字段时保守保持全部活动。删除尚未物化的Dataset样例时按真实计划剩余样例判定父实验状态，不把“物理Case为零”当作整轮已取消。

实验详情对非owner仍隐藏Session正文与评测gold。domain仅从已经重验来源ACL的真实封存业务Session计算内部readiness标量（非空interactions、业务回复、结束时间、真实agent），按当前Case的executionId/taskId精确关联，历史其他来源不能替代。ReadView以不可枚举的可信元数据传给原详情聚合，保持原Trace就绪规则及0分；不得伪造Session内容或仅凭机器分/ready状态判成功。非owner的Workbench进度仅从已授权Case/Result快照投影，不读取owner私有Task/runtime，不借用owner身份；owner读取自己的旧控制域配置时使用真实actor的兼容username。legacy详情算法不变，内部标量不加入公开DTO。

一般用例/触发实验沿旧points归因、建议、severity/category/dedup规则，在machine receipt提交前纯转换为`experimentSkillDerived`（version=1，原points、一个Evaluation和有界Issue集合）；禁止在plan/列表读取时补造或同步旧动态表。RunPlan通过既有controller证明封存`experiment_skill_scope`的精确Skill ID/name/version/preset/scope/source，包含于原`derived_skill_ids/versions`向量。内核核对envelope原points与本次machine points一致，重算归因Issue字段和稳定attempt/slot/point ID，不接受任意DTO；与directTrajectoryDerived互斥，不放松direct的真实Trace要求。有封存Trace时executionId必须匹配原根Execution；只有此已证明的新envelope支持纯输入评测的null executionId。输入型派生详情execution/trace_evidence为null，仍校验原machine receipt、selection、owner及资产ACL，不查旧Trace凑来源。

原优化点GET及plan POST建立真实actor上下文，动态/触发Issue只读typed当前selection，静态/反馈仍读原控制域，保留去重、prevalence、解决过滤及DTO。旧同步函数在core仅为无写入兼容入口，不回填Evaluation/SkillIssue。FI collect回调仅提交FI控制域事实；core Case绑定与ready由实际attempt worker独立读取新TraceEvidence后执行精确complete，回调不冒充IAM身份、不读取旧Session/Execution、不回填同fiRunId的历史旧Case。

触发问题沿旧替代语义增加只读`derived_trigger_frontier`：仅真实owner的同Skill/version、已证明trigger scope且全部槽位已终止的实验可参与，依据当前selected machine receipt实际完成时间选择最新实验；同毫秒以稳定实验ID定序。成功但零Issue的新触发结果仍推进空前沿。返回真实Evaluation IDs及完成时间，查询前后重验IAM、来源、实验生命周期/当前计划与selection；不加载旧动态表，不写resolve，不推测模型最新内容。默认未解决聚合仅显示该前沿的触发问题；`includeResolved`历史视图保留原实际解决字段，不把只读替代伪装成014人工解决事件。

可见公开Skill保留原评测能力。只有真实查询到的公开Skill且精确匹配`experiment_skill_scope` ID/name/version/source/preset/scope时，controller可为一个`derived_public_business_skill_id`授予已签名的business-only例外；同ID版本向量只能含该精确版本，其他ID仍限owner/global原域。内核明确禁止direct envelope使用此public-only ID，不能借business标记扩大direct/general授权；静态公开读取仍按原Skill控制域权限。

版本分析两个既有GET建立真实Experiment actor作用域，复用原root/版本标签/问题/时间窗口/均分/p95算法。core只读新Observe/Tag与typed list_view当前selection，人工0分保留；legacy仍走原表。兼容Observe列表默认不改DTO，仅私有includeCoreIdentity请求可返回已授权记录的canonical Trace ID；公开Observe代理不转发该参数，版本DTO也不返回内部身份。真实principal对应的canonical owner筛选标签、Trace和实验结果，避免管理员或legacy兼容username混入他人数据。结果读取后重验Trace可见集合，来源删除/撤权不沿用旧行；无旧Tag/Execution/Session/ExperimentResult影子读取。


### 15.6 诊断优化部署的来源读取

原部署预检、确认和状态路由保留DTO及客户端命令协议；core分支建立真实Experiment actor上下文，忽略客户端user声明。正式Skill版本、优化记录、客户端注册与部署命令保持原控制域。优化记录中的Diagnosis引用只从新DiagnosisRun读取来源execution_id，不回查旧DiagnosisRun；显式Trace引用和诊断来源均通过TraceEvidence实时授权与完整性校验。

部署来源必须归当前principal所有，组内读取权限不授予向他人客户端部署的权力。目标clientId、framework与Skill实际origin从新库冻结来源读取；非JiuwenSwarm要求同client/platform的唯一opaque origin_ref，只由客户端本机注册表解析路径，displayPath仅显示。未知/矛盾/缺失origin明确422，不查旧Execution/ExecutionSkill补来源、不猜全局路径。JiuwenSwarm保留原框架全局目标与唯一在线客户端规则。预检前后、持久化enqueue之前及WSS dispatch之前再次读取来源并核对固定manifest/目标。enqueue前失效不建部署命令；enqueue后、WSS派发前发现变化时，将已知queued命令标记DELIVERY_FAILED及部署失败，失败/取消的artifact不能继续领取。持久化enqueue本身已经对设备poll可见，是授权提交边界；不能将跨库检查描述为已经在途或已领取命令的原子回收。

原预检/确认/状态handler在独立HOME/Prisma SQLite与真实core HTTP/CH验证：同key不增命令，3个PRECHECK及1个DEPLOY经真实设备poll/制品接口/状态回执到SUCCEEDED，状态保留5个事件；缺origin422、跨owner403、预检时来源变化409均未创建部署命令。9张旧动态表行数仍为零，隔离库integrity正常。设备传输及安装回执为模拟夹具，没有在用户机器执行真实Skill安装。证据为本批`acceptance/deployment-native-report.json`。


### 15.7 原 Trace 流程分析消费者接入

范围为既有`/api/observe/executions/:executionId/analyze-match`的GET/POST、`flow-parser`及`alignment-attribution`，不新建浏览器API或界面。原匹配/分批抽步骤/合并/Skill span/归因候选/评分聚合/fallback算法保留；存储接线不能顺带调整这些业务规则。静态Skill、版本、ParsedFlow留在原配置控制域。旧Execution、Session、ExecutionMatch、TrajectoryEvalResult及动态Evaluation/SkillIssue在core模式不读写。006报告kind只允许agent-debug/skills-analysis，不将流程匹配伪装为这两种报告，也不修改冻结DDL。

内部容器使用明确`scope=trace-flow-analysis`的真实Experiment/Case/RunPlan与受控internal flow evaluator，不注册为用户评估器。每个原POST请求以真实workspace/principal、canonical Trace及operation key生成稳定资源ID，先按精确身份恢复既有容器，再读取最新资产准备新容器；首次create在本域原子保存完整冻结manifest及精确请求回执。这样相同请求中断后不能因模型、Skill或ParsedFlow已更新而改用新版。不同请求生成独立历史，旧单行ExecutionMatch的“最后完成结果”由内部机器selection派生，不用可编辑JSON冒充缓存事实。已有RunPlan lease/fence/checkpoint与receipt delivery恢复机制负责执行和丢回执，不引入跨库事务。

POST先建立真实actor上下文并解析已授权TraceEvidence，不能相信body.user。冻结实际canonical Trace、snapshot hash/route incarnation、真实业务interactions/根Execution；按原rootSkill提取、实际版本及缺失版本fallback规则解析当前actor可读的Skill/版本，冻结内容及hash、ParsedFlow/mermaid及hash、mode、原精确请求和脱敏模型选择。模型密钥只在实际attempt运行时按封存连接指纹解析，不入manifest。Trace/已注册资产由内核沿既有source/asset live ACL与epoch校验准备、claim、load、renew、complete及读取；仍在旧控制域的静态Skill范围由Node在执行、恢复和读取入口实际复核，不能声称Python已经访问该配置库。再分析读取新证据，历史计划仍指向原证据。

`flow-parser`增加显式冻结输入/不持久化出口，原公开函数保留legacy路径，复用原抽取、匹配、合并及Mermaid生成函数。缺失ParsedFlow时在真实work handle内用冻结Skill正文执行原parseSkillFlow(persist:false)，其产出随match receipt封存；原静态ParsedFlow可在receipt确认后以Skill ID/version/content hash核对的本域CAS更新，控制缓存失败不撤销已提交match，不能把旧库Session伪造成输入。所有真实模型调用使用trusted模型及recorder并等待实际indexed回执；普通模型失败可保留原业务fallback，身份/来源/录制失败不可吞掉为成功。

为保留原POST中归因失败不撤销已成功匹配的语义，匹配与可选归因分别使用真实内部work/receipt。匹配先提交含`mode/matchJson/staticMermaid/dynamicMermaid/analysisText/flowJson/extractedSteps/interactionCount/matchedAt/usedSkill*`的原形状投影；compare归因随后以该精确machine ID/hash和同一Trace/Skill快照准备独立计划，不能读取后来覆盖的match。动态模式不运行Skill归因。归因失败在自己的attempt留下真实失败，POST仍可按原合同返回匹配结果与attribution:null；请求撤权或来源失效则拒绝发送私有匹配数据。

`alignment-attribution`拆出原纯候选提取、LLM归因、deviation/score/rawAnalysis及Issue转换；原legacy持久化入口保留。core补充工具选择/冗余度时只读取同actor、同Trace、真实选中轨迹质量receipt，原优先级/0–100转0–1及aggregateTrajectoryScore算法不变，并把该实际receipt来源封存到归因计划；不存在则按原alignment-only算法。归因产物经既有真实Trace要求的directTrajectoryDerived及attested Skill范围写typed Evaluation/Issue，避免使用只允许普通用例/触发的experimentSkillDerived冒充输入型归因。动态表不做影子写。不能把独立ParsedFlow控制写和机器receipt称为原子提交。

GET在IAM与Trace source复核后，通过现有Experiment端点的有界typed内部查询定位该actor/Trace最后完成的实际匹配selection，精确读取其封存DTO；尚无结果按原analyzed:false，进行中字段按实际slot/checkpoint投影，不伪造成功。`currentInteractionCount/hasUpdate`沿原计数规则，从当前已授权业务Trace计算；flowJson取本次实际封存结果而非可变最新ParsedFlow。可选归因只有来源match ID/hash仍相同时才关联，旧归因不得附到新匹配。不能遍历全部Trace正文或旧ExecutionMatch来定位缓存。

此scope是后台分析容器，所有普通实验/评测结果/Run列表、agents/基线和Workbench可见集合及分页total必须排除；精确内部查询与后台恢复保留受控读取。隐藏规则按业务scope而非名称前缀，不能因用户改名复现界面行。旧普通实验、Workbench、静态Skill与ParsedFlow数据不迁移或删除。

模型调用前以真实work checkpoint记录精确请求hash的intent，只有真实响应及其indexed recorder确认后才保存observed响应；已确认失败保存failed并沿原fallback。恢复只继承同work/run的调用账本，observed可复用，未知intent不重发。过期未知intent不再创建无意义attempt，保留pending等待原worker真实late响应；跨实例无法确认时须明确处置或提交显式新分析请求。独立请求不会借用旧调用响应。SDK在该封存调用域禁用自动重试，其他模型调用规则不变。归因计划只能继承当前精确match receipt对应的不可变Trace证据；后续Trace增长不会改变它，但来源权限、incarnation/epoch和公开资产仍实时复核。

已确认matcher业务失败的机器回执携带内部失败证据，原POST返回原500/error DTO；未知交付仍为pending，不猜失败。可选归因pending不撤销已完成匹配，最终必须重新读取当前selection并通过来源/Skill权限检查，方可返回match及空归因。direct轨迹质量的有效工具选择/冗余度优先级保留，不因更晚普通用例结果改变已封存补充来源；Benchmark私有release/origin不复制到无binding的Flow输入。

隔离验收已覆盖原compare/dynamic POST与GET、自动parse/静态缓存、实际归因和精确重放：真实core HTTP/SQLite/ClickHouse与受控Mock OpenAI HTTP产生6次真实模型请求、6条indexed judge Trace、3份Flow机器回执；派生Evaluation/Issue实际写入新域，9张旧动态表均为零，静态ParsedFlow缓存为1。另以真实新库direct与普通质量回执验证原优先级，实测伪user/匿名/跨owner拒绝、Skill撤权及来源删除失效、同key在模型配置改变后不重发。原Next普通实验列表实测不显示内部容器。focused与kernel测试另外覆盖未知intent不重发/不增attempt、late observed恢复、当前match绑定、Trace增长与撤权反例。此验收不是浏览器交互验收、实际模型质量认证或千级容量认证。
