# 存储核心、IAM、default项目与三库适配实施状态

日期：2026-11-12。当前已完成001核心基础、IAM/002/统一授权/三事务库合同、003 default项目预留，以及004可靠采集/Trace显式Web桥接实现；本轮HTTP万Span与重启/导入验收已通过，浏览器已完成万Span、分页、正文及成员隔离验收，整体重构未完成。总体目标见phase1/phase2，IAM批次范围见[phase5](phase5-iam-adapters-plan.md)，default追加范围见[开发计划](phase3-development-plan.md)。

## 基线与交付

- 工作分支`codex/storage-core-refactor`基于已同步的`upstream/master`：`298d1d5b10ab3ab67a955b41a1665b0cd4d26b54`，旧库基线96个Prisma模型。
- `001_core.sql`四套原始字节均保持不变；新增SQLite/PG/openGauss三套`002_iam.sql`、`003_projects.sql`、`004_observations.sql`与机器字段目录。
- 当前物理核心为 **35张事务表+13张CH表=48张**：001原34张，002新增10张IAM表，003新增项目目录与workspace归属2张，004新增可靠采集与实体版本2张。完整字段/类型/约束/索引见[字典](core-table-dictionary.md)。这不是原59张逻辑目录的全部实现。
- `services/storage/control.py`、`relational.py`共享资产/发布/草稿/别名、RunPlan、任务lease/fence/取消、结果回执与Outbox原子性。PG/openGauss写锁粒度为正确性基线，尚未完成千级混合容量优化。
- `iam.py`实现稳定主体、密码派生、会话/API凭据、用户组/成员CAS/最后Owner保护、空间归属、资源归属与显式共享/撤销。组管理员全组读取，普通成员本人/共享，viewer只读；无隐式平台管理员。
- `authorized.py`统一校验元数据/列表/Span/正文/聚合/有界制品下载。CH读取和下载前后重新校验权限；慢I/O与密码派生不占写事务。私有评测gold不通过普通制品端口开放。
- `clickhouse.py`保持最新态后筛选、结构分页/单点、多section正文bundle、分块/hash和有界请求；新增范围绑定聚合、删除屏障及Token未知覆盖度。未知总数返回null，并提供已知和/缺失数量，不冒充完整零值。
- `migrations.py`与CLI实现已知连续前缀、checksum、显式迁移计划及原子升级。SQLite备份后锁源重核；服务端先取迁移表锁再建立快照，绑定备份源身份/历史/全部托管表内容证据。DDL不得自行提交事务。
- `legacy.py`提供只读原始清点/导出/验证，保留活跃WAL、类型、物理列、重复行和摘要；`trace_import.py`新增限定Session/Execution允许字段的显式映射/dry-run/接收链路apply，不等于96模型语义迁移或生产切换。

## 004 Trace垂直链路实现与验证（本轮已验收）

日期：2026-11-12。实现已接通，**HTTP采集到万Span浏览器链路已验收**。范围与接线见[phase6](phase6-trace-vertical-slice.md)，隔离启动见[操作指南](../../../docs/zh/how-to/platform/storage-core.md)。下列只记录已取得结果，不替代之后的最终集成证据。

- 追加两张OLTP表`ingest_batches`、`obs_entity_heads`，001–003字节不变；完整字段/索引/不可变与版本规则见字典，机器目录为`ingest-catalog.json`。
- `observations.py`实现4MiB/4096完成Span/64MiB展开限制，原始包私有fsync后原子接收、主体/空间receipt幂等、全局强序Outbox租约/fence、冻结计划、源版本冲突隔离、差量摘要及固定版本重试。默认来源otlp，跨service同Trace及父子关系保留，root显示不被child覆盖。
- `trace_service.py`与Next core桥接实现当前scope密码登录/独立Cookie、可靠上报、回执、分页列表/结构/正文；模式必须显式打开，旧模式开关未设置保留。后端只监听loopback并限制32个并发请求，不宣称千级并发。
- `write_payload_bundles`每批最多128 Span，chunk请求≤4MiB，全部chunk成功后发布manifest，随后写Span及Trace摘要。测试中的128份小正文批只需2次Payload HTTP；这不是每种载荷都固定2次，也不是端到端容量指标。

### 已取得的分层结果

| 环境/执行 | 实际结果 | 精确证明范围 |
|---|---|---|
| SQLite观测合同（批量优化前） | 32通过；后续新增bulk两例单独通过 | durable-ack、整包原子校验、回执/租约/重启/冲突、delta/未知Token、跨service、删除屏障、私有策略指纹及显示/归一化边界 |
| PostgreSQL15 | 26条合同整组通过20.806秒，新增归一化6条分批通过；bulk两例另通过22.486秒 | 共34条观测行为有实机覆盖；使用测试Facts sink，不能写成34条真实CH闭环或原生OG结果 |
| 原生openGauss7 | 40/40通过、0跳过，44.740秒 | 官方Linux ARM64/Python3.11 psycopg2/libpq，已验证纯SHA256账号；控制14+当时复制快照的观测26。Facts为测试sink，不包含随后归一化/显示6例或bulk2例 |
| SQLite/CH适配器专项（批量优化后） | 执行84条：49通过、35明确跳过，9.551秒 | `test_observations`+`test_clickhouse`；跳过34条可选PG与1条可选CH，不能写为84全通过 |
| 真实ClickHouse25.8 | 最新专项1条通过1.747秒 | 隔离随机DB；实际chunks/manifest/Span/摘要、失败后固定revision重放、跨service二Span读回、128正文批manifest发布中断后不可读、恢复hash/单条等价及Unicode读回；不是万Span或千级容量结果 |

PG分批结果不加算成同一时间执行的全套通过，也不把不同快照的native结果外推为当前全部34条原生通过。native日志`/tmp/agent-insight-native4-matrix.log`、源码快照/hash清单`/tmp/agent-insight-native4-evidence.json`为本机0600证据，未提交；其他本节结果见子任务工具输出，未独立保存完整日志。HTTP、万Span、旧格式导入结果追加在下节；最终浏览器截图及代码指纹由主任务完成后继续追加。

### 本轮HTTP、迁移样本与应用验证追加

证据目录：`exclude/storage-core-acceptance/20261112-e25e83fe/`（隔离验收输出，未作为业务数据提交）。以下为真实HTTP/数据库操作，输入是人工构造OTLP/旧格式SQLite fixture，**没有真实LLM调用或客户库迁移**。

| 项目 | 实际结果/证据 |
|---|---|
| OTLP→worker→CH查询 | `http-acceptance.json`状态passed，4条Trace场景含10000 Span大Trace；同包同batch，成员隔离、源修订、冲突批失败且当前视图不损坏均通过 |
| 有界读取 | 列表响应3632字节；大Trace结构页200行/131344字节；单Span670字节；Unicode正文4页/hash一致，最大正文页273753字节 |
| 大Trace处理时间 | 本次worker等待125.698秒；为隔离功能验收观测，不是P95/P99或千级吞吐基准 |
| 重启恢复 | `recovery-evidence.json`：worker暂停时accepted且1条Outbox，进程重启后indexed |
| 旧格式Trace导入 | `legacy-import-evidence.json`：隔离旧格式fixture计划3 Span/索引3 Span，重复apply命中1重复包，1条不支持记录隔离；源文件/内容hash保留且源未变；旧凭据未复制，Unicode/工具正文回读通过 |
| protobuf | `protobuf-evidence.json`：273字节application/x-protobuf请求，0字节协议响应，回执最终indexed |
| 旧壳库 | HTTP验收前后Prisma表计数未变；不等于完成全部旧模型迁移 |
| Python当前默认专项 | 执行341条：205通过、136明确可选跳过，45.054秒；不可写成341全通过 |
| 新增Web专项 | UI+bridge27/27通过，HTTP/query10项通过；这些专项不替代完整应用与浏览器验收 |
| 应用全量`npm run test` | 执行5334条：5258通过、52失败、24跳过，440805毫秒；全量未通过，不宣称新旧全部功能已验收 |
| 浏览器最终结果 | `browser-evidence.json`通过：owner查看全部7条样例、Bob仅见本人2条且他人深链拒绝；失败筛选、10000 Span摘要/目标Span搜索、200行结构前后页、7块正文1–4/5–7前后翻页和切输出、桌面/390px窄屏导航均实际操作通过；保持owner验收页打开 |

Unicode全文SHA256为`b19bcab25c703d64d7098782a18f74b7403a60f75bd4d0d234fb9608848de7e5`。源旧格式fixture文件SHA256为`e9d3a431ebcbc8b93221b05b2bf5ceb940f457a592ca07818164c04202305a16`，仅绑定本次样本，不代表生产数据。以上记录追加于既有历史证据，不覆盖001–003或IAM原测试日志/commit基线。

### 最终复核与可打开界面

- 本机入口`http://localhost:58388/trace`，当前独立core服务为127.0.0.1:58387，CH为127.0.0.1:58332；SQLite控制面、旧Prisma壳库分别位于上述证据目录，不共用原业务库。服务保持运行；浏览器已保留管理员验收标签页。账号密码仅在该私有目录的`验收账号.json`，不入Git。不要把验收账号当生产账号。
- `ui-desktop-final.png`为1280×800最终结构/正文；`ui-mobile-final.png`为390×844导航收起后的实际页面。`ui-member-isolation.png`保留Bob访问Alice深链被拒绝的画面。正文每页仅渲染当前最多4块，不累积全文DOM，前后可访问全部内容。
- `payload-pages-evidence.json`：7块长正文分4+3读取，完整SHA256为`5f4713015bf9c3de9fd0c8ccb2ed4e99ce16ecf93fc00540dbc7e5a708afccd4`，首API页1084188字节；浏览器实际完成前进、返回和切section。
- `auth-outage-evidence.json`：HttpOnly/SameSiteStrict、响应不泄露session_token、跨Origin登录拒绝、旧Key拒绝、停core时返回502且不退旧库、恢复后读回均通过。新链路验收全程前后旧壳Prisma表计数不变；该证据只覆盖独立壳库。
- 最后Python默认套件`python-final.log`执行345项，209通过/136可选跳过，22.732秒；最终Web focused 30/30通过（bridge23+UI5+原deployment回归2），TS完整类型检查通过，移动侧栏更新后再次完整类型检查通过。
- 首轮全量5334项中本次引入的2个VM模块加载问题已修，focused2/2回归通过。52项原失败逐例分类保存在`initial-npm-failure-classification.json`：8项在HEAD复现相同失败，3项在HEAD完整临时schema下通过，其余39只分类未逐项证明历史归属。不能笼统称全部历史失败。
- 最终显式隔离`AGENT_INSIGHT_HOME`/`DATABASE_URL`的完整应用复跑在1227秒仍无完整汇总，1123秒无新输出，仅剩`evaluator-scoring-http.test.ts`子进程；已停止该次测试的4个自有进程并保留`npm-isolated-final.log`及`npm-isolated-final-stopped.json`。不作为完整应用通过或失败项已清零证明。
- 最终`final-readback.json`读回7条Trace/10018 Span，17个批次indexed、1个故意构造的版本冲突批次failed；服务健康检查和网页200，独立旧壳表计数仍与验收前一致。代码实现分别在`a546ff88`、`798788e3`本地提交。
- 本轮功能与专项验收完成，完整重构/全量应用绿灯/千级容量未完成。当前入口只接管Trace，不能将此页面验收外推为全部评测器/Skill/Agent/Benchmark流程已切库。

### 当前边界

强序单队列、控制写锁和32个请求槽为当前正确性基线；尚未完成1000在线采集端混合压测、100000Span边界、生产迁移、分片Durable Event Log或HA认证。固定快照和其他领域可靠物化、完整评测/Benchmark版本工作流仍未全部接管。不能用先前kernel直接写入的万Span夹具，替代本批HTTP采集→worker→页面的验收结果。

## 003 default项目预留（历史阶段记录）

本节保留003交付时的范围和验证记录；当前新增能力、模式与测试状态以上方004章节为准。

- 新增`projects`与`project_workspaces`；新目标初始化应用001+002+003。001/002原始字节保持不变，旧目标需显式备份/核验证据后迁移。
- 003为全部既有workspace补default归属，原ID（包括既有非规范ID）逐字保留，不重写业务/CH行，不生成IAM账号、成员、Owner或ACL。新workspace及default映射同事务提交。
- `projects.py`提供稳定default标识、不可变ProjectContext和有界解析。未指定项目兼容default；显式空字符串、空白、其他项目拒绝，未绑定/停用项目失败关闭。
- AccessScope、workspace grant、列表/聚合元信息和scope指纹带project_id；同default不扩大现有workspace/资源权限。项目禁用后仍能撤销本人会话/Key，认证与项目授权分别检查。
- 当前仅新存储库预留default，现有Next.js/Prisma、已部署客户端和业务运行库未切换。项目UI、Owner/邀请/多项目成员及切换上报流程属于后续增量，不因目录存在就视为已实现。

### 本批验证记录

- 默认专项命令（未配置外部数据库变量）：**执行240个测试条目，141通过、99明确跳过、0失败**，15.547秒。跳过的是外部引擎合同，不能写成240项全通过。
- 迁移/关系库/CLI专测：**57通过、0跳过**，186.335秒，含真实PG/openGauss各14条控制合同。结果记录在子任务工具输出，未独立保存原始日志；不将工具摘要当作恢复演练证明。
- PG最终复验：**43通过、0跳过**，25.953秒，包含真实PG项目授权/CH闭环29、PG DDL约束4、SQLite/目录检查10；采用最后的注销修复代码。日志为`/var/folders/8s/r6t1yc991fq4xdx422ccr29h0000gn/T/storage-projects-pg-kovx7agl/pg-scope-ddl.log`。
- 原生openGauss官方Linux ARM64/Python3.11 SHA256：**43通过、0跳过**，804.600秒；IAM16、授权10、真实CH闭环3、控制/迁移14。此次执行受资源竞争影响，不作为吞吐基准。
- native额外003 Schema事务探针验证5类旧workspace ID逐字保留（首尾空白、空ID、600字符、C0、C1），无隐式IAM授权，另有9项预期约束拒绝；探针全部回滚。
- 所有46表主键/排序键及显式UK/IDX清单与目录/DDL核对，8张Mermaid图解析和实际渲染通过。修改文件链接、代码围栏、空白和Python编译检查通过。
- 应用`npm run test`本轮约1056秒后因长期无新输出停止，日志空闲约862秒；**未完成**，不统计完整通过/失败数。此前44项失败仅属于下方历史基线。本轮未修改现有应用源码/Prisma/依赖/脚本。
- 预先启动的旧版全套专项和原生42项在最后注销边界修复后作废/中止，最终结果不使用它们；只采用本节明确标注的最终代码验证。

证据：默认专项`/var/folders/8s/r6t1yc991fq4xdx422ccr29h0000gn/T/storage-projects-units-z64ank1t/python-units.log`；原生最终日志/源码指纹为已有OG证据目录中的`native-project-final43.log`、`native-project-final43-evidence.json`、`native-project-tested-files-final43.json`；当前代码与已测代码指纹一致。应用不完整日志与停止记录为`/var/folders/8s/r6t1yc991fq4xdx422ccr29h0000gn/T/storage-projects-npm-_tju0g4e/npm-test.log`、`interruption.json`。应用未在浏览器中验证，本批仅对文档图示做无头渲染检查。

## IAM/002批次验证（历史基线）

| 层次 | 实际结果 | 证明范围 |
|---|---|---|
| 存储Python全套 | **192通过、0失败、0跳过，49.397秒**；ResourceWarning作为错误 | 同时启用SQLite、PG、openGauss兼容测试连接和CH，包括DDL、迁移、IAM、三后端授权和跨库业务链路 |
| PostgreSQL | 15.19，ARM64 `postgres:15-alpine`隔离容器；固定psycopg2-binary2.9.10 | 真实控制/只读快照/并发领取/Outbox、001→002保留、故障回滚及备份屏障；多Owner并发在RC/RR下均保护最后有效Owner |
| openGauss原生认证 | **31通过、0失败、0跳过，27.177秒** | 7.0.0 build2397a86f、PG兼容模式；Linux ARM64/Python3.11.13、官方psycopg2/libpq2.9，原生SHA256认证；IAM12+授权7+CH闭环3+业务/迁移9 |
| ClickHouse | 25.8.12.129 official build，macOS ARM64隔离实例 | 13表、最新态、正文完整性、每后端万Span分页/单点/跨空间统计、撤权和删除屏障；未知/混合/真实零Token覆盖度 |
| 独立审查 | 已修复发现的授权/迁移竞态，并执行回归 | 下载期间撤权、分析删除屏障、时钟回退撤销、迁移等待写入者后的旧快照、顶层COMMIT与失败迁移回滚 |
| 既有应用`npm run test` | **5241通过、44失败、24跳过，共5309；760.676秒** | 全量未通过；未将该结果写成完整应用验收成功 |

192项细分：授权门面7、PG/OG授权合同38、CLI2、CH单元10/真库6、通用合同4、SQLite控制11、IAM12、IAMDDL15、旧库导出22、迁移17、关系库22、核心DDL17、三后端CH闭环9。原生31项为在另一驱动/运行环境执行的同一组合同，不加算成223个独立测试。

本批应用全量使用新建隔离`AGENT_INSIGHT_HOME`及Prisma测试库。与上次70项存储基础交付时的全量结果（5242/43/24）相比，本轮增加一项Dify安装fixture子进程超时（status=null）；其余失败名称相同，涉及既有UI/FI/RAS/构建平台等。本轮未修改`src/`、`test/`、`prisma/`、`package.json`、lockfile或RAS/FI模块；未做clean-master对照，不宣称新增失败为0。未启动Next dev，**未在浏览器中验证**。

### 本次证据

- Python最终日志：`/var/folders/8s/r6t1yc991fq4xdx422ccr29h0000gn/T/storage-iam-final-63stwx41/python-suite.log`。
- 原生openGauss日志、已测源码指纹及环境记录：`/var/folders/8s/r6t1yc991fq4xdx422ccr29h0000gn/T/agent-insight-opengauss-env-rgbg5yn9/`中的`native-matrix-final.log`、`native-tested-files-final.json`、`environment-evidence.json`。最终已测代码指纹与仓库一致。
- 应用全量日志：`/var/folders/8s/r6t1yc991fq4xdx422ccr29h0000gn/T/storage-iam-npm-804gb9xj/npm-test.log`。
- openGauss官方服务端归档SHA256：`e3a71a23a84871293f2c43d27044e01a169699ba65b19c1766c802b4d10a50c5`，已与官方校验文件核对。官方Python归档测量摘要`92c027718f2a5917e9eea6c2d26dba6e2ee53e0394a8c1ebf0ae6e6e9250aae7`仅为本次下载指纹，未获得单独发布的checksum，不声称完成发布摘要核验。
- CH固定官方发布资产SHA256：`541b149c0b73c44524cf3aff38541697736de266b36b6233811451a7922ee588`。

这些路径是本机临时证据，凭据另存在私有文件，未提交。原生openGauss与macOS普通psycopg2-binary的SHA256握手不兼容；主机兼容MD5 fixture仅辅助跑合同，不能作为生产配置建议。

## 数据保留与适用边界

1. 新采集/HTTP/浏览器/旧格式导入验收使用独立目录、SQLite/schema和CH数据库；未执行默认业务库迁移、替换、清理或自动归组，未覆盖旧备份。首轮完整应用测试未统一设置测试HOME，部分遗留用例会读取默认配置并可能使用该datasource，其日志不能用作“默认库完全未触碰”的证明。之后已显式隔离完整应用测试；本批未据测试夹具失败对业务库做修复或删除。
2. 已有001初始化不隐式升级，基础控制操作仍可使用已知前缀；IAM要求显式迁移002。SQLite迁移保留私有一致性备份，事务失败回滚；PG/openGauss真实测试确认001行、release/run和原marker保留。
3. 服务端外部dump的恢复核验由运维完成，工具只验证文件hash、源证据及操作声明。测试中的备份fixture不等于真实生产dump恢复验收。
4. core显式模式已接入IAM密码登录、独立Cookie/同源检查及单实例登录限流；旧模式不变，账号恢复、外部身份迁移与跨实例限流仍待扩展。浏览器完成度以004追加验收为准。
5. 普通成员聚合为显式授权Trace集合，每空间最多1000根；删除屏障每空间最多1000根，查询总绑定参数最多4096。超出拒绝，后续须实现可扩展ACL/删除字典；制品下载暂限16MiB。
6. 组/空间转移、历史归属和旧用户映射仍需显式迁移清单，未映射空间保持隔离。现有业务写入口接管时必须同事务建立资源归属。

## 下一批

- 在已验收的004 HTTP/浏览器链路上扩展分片Durable Event Log与其他领域恢复协议。
- 固定Trace快照、Dataset/Evaluator/Skill/Agent/Benchmark多版本发布与运行闭环，之后逐领域接管现有API。
- 旧模型逐字段转换、目标apply、增量/DELETE追平、影子读、停写切换及回退；当前原始导出不是迁移完成。
- 扩展尚未接管的Web领域与账号恢复、规模化ACL/删除投影、保留期/pin/索引重建。
- 控制写锁细化、1000在线采集端混合读写压测、故障/HA及目标部署发行版恢复验收。

原首批70项结果及IAM/002批次192项专项作为历史证据保留；default项目增量另行记录。原全量失败证据与总体设计仍保留，不将本批测试外推为完整重构/生产切换完成。
