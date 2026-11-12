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
