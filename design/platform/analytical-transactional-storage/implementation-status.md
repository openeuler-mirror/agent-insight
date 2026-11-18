# 存储核心、IAM、default项目与三库适配实施状态

日期：2026-11-18。第一版原功能的新存储消费者逻辑已汇总至020（77张事务表、19张ClickHouse表），公共采集、静态控制、Infra、GoalPlus/协作/Usage及旧库语义转换已进入集中验证。原界面隔离验收已可打开，最新实际结果和限制见文末“2026-11-18 集中验证与原界面验收”；旧章节保留各阶段证据，不表示当前仍未接线。**第一版以原有功能、界面及统计口径一致为目标；万级Span、统计水位和千级混合容量优化延期至第二版。** 当前仍未执行客户全库迁移或生产切库，不能将样本演练和部分原界面流程解释为全产品生产验收。

**后续执行节奏（2026-11-17用户调整）**：先按依赖连续完成剩余接入逻辑并保存本地开发检查点；开发期只做必要类型检查和快速专项，不再对每个内部片段分别做Spec/Quality、应用全量、三库及浏览器验收。全部接入逻辑完成后集中独立审查、全量测试、三库、原界面端到端及旧数据迁移演练。未集中验收的片段明确标为“逻辑完成、待统一验收”，不能据此切换生产。

## 产品验收纠偏（2026-11-12）

用户明确要求保留原有全部功能，仅变化其背后的数据支持。此前core技术样例的单Trace导航、全页替换、独立登录后落点和未接管操作501不符合此要求；本批已撤回前端替换，恢复原页面与登录。**产品验收未通过；先前“可打开验收”仅证明技术样例可运行，不能代表原产品完成切换。** 下文历史实测数字与截图继续保留，完成状态按此纠偏解释。

已核对当前源码有52个`src/app/(main)`页面文件及290个API `route.ts`文件（含本批新增auth路由）；这是物理入口数量，不是已验证功能数量或完整迁移清单。原界面已恢复；全部API/后台调用逐项映射、所有既有功能回归及产品切换仍未完成。实施顺序与首轮分组见[兼容清单](phase3-development-plan.md#修正后的实施顺序与兼容清单)。

## 基线与交付

- 工作分支`codex/storage-core-refactor`基于已同步的`upstream/master`：`298d1d5b10ab3ab67a955b41a1665b0cd4d26b54`，旧库基线96个Prisma模型。
- `001_core.sql`四套原始字节均保持不变；新增SQLite/PG/openGauss三套`002_iam.sql`、`003_projects.sql`、`004_observations.sql`、`005_trace_metadata.sql`、`006_trace_diagnosis.sql`、`007_diagnostic_reports.sql`、`008_dataset_assets.sql`、`009_dataset_generation.sql`与机器字段目录。
- 001–009阶段物理核心为 **46张事务表+13张CH表=59张**：001含21张事务表及13张CH表，002新增10张IAM表，003新增项目目录与workspace归属2张，004新增可靠采集与实体版本2张，005新增旧ID/标注/标签4张，006新增诊断会话/消息2张，007新增报告运行/当前指针2张，008新增Dataset head/操作回执2张，009新增生成job1张。完整字段/类型/约束/索引见[字典](core-table-dictionary.md)。这不是原59张逻辑目录的全部实现。
- `services/storage/control.py`、`relational.py`共享资产/发布/草稿/别名、RunPlan、任务lease/fence/取消、结果回执与Outbox原子性。PG/openGauss写锁粒度为正确性基线，尚未完成千级混合容量优化。
- `iam.py`实现稳定主体、密码派生、会话/API凭据、用户组/成员CAS/最后Owner保护、空间归属、资源归属与显式共享/撤销。组管理员全组读取，普通成员本人/共享，viewer只读；无隐式平台管理员。
- `authorized.py`统一校验元数据/列表/Span/正文/聚合/有界制品下载。CH读取和下载前后重新校验权限；慢I/O与密码派生不占写事务。私有评测gold不通过普通制品端口开放。
- `clickhouse.py`保持最新态后筛选、结构分页/单点、多section正文bundle、分块/hash和有界请求；新增范围绑定聚合、删除屏障及Token未知覆盖度。未知总数返回null，并提供已知和/缺失数量，不冒充完整零值。
- `migrations.py`与CLI实现已知连续前缀、checksum、显式迁移计划及原子升级。SQLite备份后锁源重核；服务端先取迁移表锁再建立快照，绑定备份源身份/历史/全部托管表内容证据。DDL不得自行提交事务。
- `legacy.py`提供只读原始清点/导出/验证，保留活跃WAL、类型、物理列、重复行和摘要；`trace_import.py`新增限定Session/Execution允许字段的显式映射/dry-run/接收链路apply，不等于96模型语义迁移或生产切换。

## 2026-11-13 全量测试恢复与统一取证（前一批证据）

### 全量失败与超时已查明并修复

- HTTP评测测试在空SQLite直接导入Prisma，创建失败后finally的清理SQL再次失败，跳过server.close而使进程常驻。现先用现有隔离helper建schema，再导入依赖；结束断开DB/关闭HTTP/恢复fetch与timer。CodeAgent及四组FI/上传测试也统一自行建隔离schema，不依赖外部业务库。
- 测试helper清除继承DB_*并固定空DB_HOST，防止单独测试因dotenv选择远端库。全量运行使用独立HOME/AGENT_INSIGHT_HOME/SQLite、已有Node24.22.3、已有完整Conda Python和PowerShell7.7，不安装依赖、不改全局配置。缺PyYAML/pydantic2及PowerShell宿主HOME崩溃分别以成对运行验证，不能归为产品数据库缺陷。
- 测试沙箱漏注入真实getAgentEventTree/cache、导航漏掉基线已有task-insight、导入按钮已移至既有批量导入组件，均只修测试依赖/断言，不改前端。Trae JS编译产物用现有esbuild准备，未据此宣称VSIX或IDE已验收。
- 两处真实既有后端问题已修：独立工具不再多计LLM；各session视图共用有效耗时，历史stored值不再覆盖派生结果。Windows Turbopack的child_process导入遵循既有约束；未执行真实Windows构建。
- 全量第二轮剩余冷却测试依赖固定sleep，实际冷却按整轮真实耗时计算。现以条件等待并加强不得提前重跑的断言，延迟模拟及完整consumer模块12/12通过；consumer行为未变。

### 取证与草稿已接通的范围

新增私有`GET /v1/compat/observe/evidence`与Next server helper，原`/api/agent-datasets/trace-drafts`仅增加core分支，前端五目录与`789e8d04`仍零diff。一次控制只读事务捕获当前IAM、owner/别名、locator/incarnation/epoch、annotation与全量heads；关闭事务后核对CH摘要/Span集合及精确revision，再读取并核验正文；最后重新捕获授权/版本边界。修改返回409，撤权拒绝，缺失/损坏/未追上503，超过16MiB/100000 Span等预算413，均不以空轨迹回落旧Prisma。transport使用fatal UTF-8解码，非法字节不再静默替换后携带原hash。

源snapshot hash与正文清单保留精确版本，不包含token/内部绝对路径/captured_at；相同证据换合法token或重新读取hash不变，注解变化hash改变。Python完整源快照保留有限浮点、Unicode扩展及整数；Next继续既有JS JSON/Number语义，不宣称引入无损大整数codec。精确大整数扩展应使用十进制字符串。

| 验证 | 最新结果与准确边界 |
|---|---|
| 应用全量 | `npm run test` 5364执行：5342通过、0失败、22跳过、0取消，235.85秒，未超时。原33项失败全部修复或补齐已存在运行环境；第二轮1项调度竞态也修复。最终只补Jiuwen测试的类型注解，定向回归与完整tsc通过 |
| 存储默认整组 | 498执行：324通过、174未提供可选引擎配置而跳过，0失败，58.031秒；ResourceWarning作为error运行 |
| 新Evidence专项 | SQLite21/21；PG21/21(26.468秒)、原生OG21/21(27.695秒)，两关系库实际断言只读REPEATABLE READ捕获中外部writer可提交，而当前捕获仍旧值；事实sink为MemoryFacts，不混称CH闭环 |
| 类型/静态 | 完整tsc通过；新Evidence文件及草稿路由ESLint通过；既有文件的遗留lint错误不宣称已全仓消除；diff检查通过 |
| 真实CH/HTTP | 新导入fixture：32KB完整输入、66KB最终输出、2个交互、浮点/Unicode扩展读回；snapshot哈希独立重算，相同内容稳定、注解改变hash；伪造user无效、其他owner403、矛盾ID400；旧Prisma Execution/Session对应行均0 |
| 原浏览器 | 原“加入评测集”→字段映射→数据预览完整走通，保留三个字段及原按钮，证据读回后确认按钮可用；随后取消，**未执行新库评测集保存或模型评测**，console无error/warn |

证据目录`exclude/storage-core-followup/20261113-ptxxwb8o/`：`verification/result.json`、三轮full日志（full-first/full-second与当前verification）、`evidence-http-evidence.json`、`original-draft-preview.png`。关系库日志及源码hash在`/var/folders/.../storage-evidence-relational-axs2f3i1/`。CLI复用了原隔离CH数据目录恢复服务，core仍schema5、52张物理表；没有迁移、覆盖现有业务库，也未新增006。

### 尚未完成的业务链路

此批只完成统一取证和草稿读取。真正的评测集backflow新库保存/多版本、实验运行器与结果/人工修分、结果修改自动重评、诊断会话/消息/SSE、AgentDebug报告/DiagnosisRun、RAS事件等仍待逐项接管。现有旧模式和未迁移领域仍有既有路径，不能把全量旧模式回归与草稿预览通过解释为全部领域已切库。

诊断已形成[phase6§10](phase6-trace-vertical-slice.md)：必须先把诊断Agent自身完整Trace的成功/失败recorder及可信工作区接入core，之后才实施006会话/消息和SSE。禁止通过关闭recordTraceAs或丢记录换取“两张表已迁”的结论。

## 005 原界面兼容验证（前一批次）

原登录、导航、Trace页面、客户端身份/API封装与`789e8d047b6c9b80b2054c8eac666342cbdfe368`一致；`src/app/(main)`、`src/app/login`、`src/components`、`src/lib/auth`和`src/lib/client`全部目录对该基线的git diff为空。移除本分支曾增加的替代UI。模式开关改为仅服务端；保留旧public变量作为服务端弃用别名。

- 新增`trace_legacy_ids`、`trace_annotations`、`trace_tags`、`trace_tag_links`，001–004不改。独立验收库升级4→5前创建新备份；34张既有非schema_meta表的行数与内容指纹保持一致。又在原7条路由别名回填前备份；原业务库未执行迁移。
- 旧Key先经原认证核验，再通过0600显式映射绑定当前IAM主体/空间；伪造user/workspace不能扩大范围。无映射、撤权、core故障不回落旧Trace库。删除要求独立delete能力；成员只能删除本人资源，read/write API key不能删。
- 旧列表/统计/筛选、单Trace session structure/interaction/interactions/full、标签CRUD/关联及bundle v1 import/export已接线。nullable否定筛选、平均耗时分母及工具错误百分比保持原合同。未知token不伪造为零。
- 普通结构逐页读取200 Span，最多100000条/16MiB，结构阶段不读正文；点击后按精确revision读取单点。opaque `_payloadVersion`绑定Trace/Span身份与结构版本，防止并发插入造成索引位移后错填正文。原Langfuse节点路径因前端直接消费nodes保留完整正文，不计入普通懒加载证明。
- 导入50MiB/500 execution，全树预检，旧ID与嵌套引用碰撞重映射，原始扩展/调用ID及空/null Session保真。显式receipt按同内容恢复；原UI无receipt时只恢复同主体/空间/内容的未完成operation，完成后再导入可建副本。全部batch indexed并校验mark_completed后才返回成功。完整响应上限128MiB。

### 本批取得的证据

隔离服务继续使用`http://localhost:58388`，原界面验收页为`/trace?taskId=compat-ui-demo-task`。原登录方式不变；该样本属隔离admin。控制库、CH及Prisma旧业务样本库均在专用目录，未指向默认业务数据。证据集中在`exclude/storage-core-acceptance/20261112-e25e83fe/compat-unchanged-ui/`。

| 验证 | 最新结果与准确边界 |
|---|---|
| 存储默认测试 | 477次执行：303通过、174项因未提供可选实际引擎配置而跳过，19.416秒；非477项全部实机通过 |
| Web专项 | 33/33通过，0.754秒；含原目录/五入口基线、旧接口桥接、认证映射、DELETE空体与大导入/导出头 |
| TypeScript / lint | 完整`tsc --noEmit`通过；新兼容桥接三个文件ESLint通过。受改动路由全量lint仍有原有3个any错误/1个未用参数警告，相关旧行与HEAD相同，未作为本批通过项 |
| SQLite/PG/openGauss元数据 | 各18/18通过；openGauss7官方Linux ARM64驱动/原生SHA认证17.817秒，PG14.444秒。最新完整源码指纹见`/tmp/agent-insight-storage-forward-final-evidence.json` |
| 已有真实CH读取 | 8 Span和10000 Span两条通过，2.192秒；万Span结构0正文、末条按版本lazy读取 |
| 原浏览器真实闭环 | 通过原导入对话框上传v1文件，原列表及详情显示；点击Span显示完整input/output；原打标创建并关联1标签；原导出按钮下载。导出全部executions/session与输入相等，任意opaque扩展保留，控制库证实owner=admin、全部indexed、operation completed |
| 原采集Key HTTP | 原Key→OTLP ack仍空JSON；新native ID别名、query投影及正文读回通过；伪造user、他人Trace及其他workspace均不能越权；`http-evidence.json` |
| 应用全量 | 隔离HOME/SQLite运行`npm run test`，600.03秒后因evaluator-scoring-http停滞终止自有进程组，未取得完整汇总；截至终止已报告5项失败（其中首次注册环境缺PyYAML）。**全量未通过**，日志`verification/npm-full.log`与result.json保留 |

所有输入均人工fixture，无真实LLM调用、客户数据迁移、千级并发或HA结论。旧004数据未自动补投影；相同源revision重放会幂等跳过，不能伪增source版本回填查询字段。

### 仍未完成

评测回流/结果编辑的自动重评交接、诊断与故障事件、Infra关联、协作关系、实验/评测结果联动、各非OTLP采集写端，以及所有其他领域的语义迁移和资产多版本业务接管仍需逐项实施。当前final_result编辑明确冲突，不能当作原自动评测已触发；旧复合条件删除也尚未接回。列表当前枚举授权数据，上限100000；索引下推、队列/写锁并发优化、所有超大Trace全量导出性能仍需专测。**原界面恢复及Trace专项通过不代表原有全部功能已完成新库接管。**

## 004 Trace垂直链路技术验证（历史专项证据）

日期：2026-11-12。实现已接通，**HTTP采集到万Span技术样例已验证，原产品兼容性未验收**。范围与接线见[phase6](phase6-trace-vertical-slice.md)，隔离启动见[操作指南](../../../docs/zh/how-to/platform/storage-core.md)。下列只记录已取得结果，不替代之后的最终集成证据。

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


## 2026-11-13 Trace 报告切片

追加冻结 007 两表保存 AgentDebug/Skills 报告运行及当前版本指针，完整输入证据、报告和进度存入私有 hash 制品。原报告 API 的 core 早分支、可信读取上下文与后台 CAS 已接；故障诊断追问从同一空间/来源 Trace 权限下读报告。首轮旧任务不能覆盖新运行，删除后不能复活；发布前后重新授权，正文错误和网络失败不回读旧库。诊断执行器读写同一冻结工作目录；Skills 的原 LLM 业务步骤提取改用冻结 interactions，保留原提示词和输出合并，计分与建议流程继续使用共享冻结模型、取消信号与 core recorder。静默长任务按原超时运行，15 秒 checkpoint 续租并及时响应撤权。

本子任务已跑 SQLite、实际 PostgreSQL、官方原生 openGauss SHA256 报告领域各 19 项，Next 生命周期 10 项、文件 I/O/业务提取 4 项，与既有报告定向回归合计 37 项通过；三库追加迁移保留旧表行指纹。POST/PATCH 在网络模糊提交后有限重试相同私有 operation，服务端严格匹配输入、版本、actor、租约及当前 head；重复提交不会再推进版本或再启动 Agent。workspace write 预检使不能录入自身 Trace 的凭证在模型启动前拒绝。模型管线定向测试使用可控响应，不能冒称真实 OpenCode 或外部模型已验收。原报告 DTO 与产品界面未重新设计，旧模式继续既有链路；完整应用测试、真实 OpenCode 及文件工具、最终 HTTP/浏览器验证见下方本批验收记录。

本切片优先覆盖 Trace 页的诊断报告、Skills 核验与追问引用；涉及尚未迁移 Experiment/Case/Skill 优化写链的 DiagnosisRun 仍是后续范围。不得把报告存取或 §9 草稿构建写成评测回流、多版本评测集或全产品功能已切换完成。


## 2026-11-13 诊断自身 Trace → 会话/SSE → 报告隔离验收

本批接通上述诊断切片，未改变原产品页面、组件、导航、登录与交互。对比`789e8d047b6c9b80b2054c8eac666342cbdfe368`，`src/app/(main)`、`src/components`、`src/app/login`、`src/lib/auth`零diff；唯一客户端传输变动是让原`apiFetch`向`/api/fault/diagnosis/`携带既有Key，账号切换、退出及显式Key行为均有回归。

自身运行保留实际provider原文、工具参数/结果、失败/中断及上游session身份；稳定Span和修订使完整快照重投不重复累计。工具carrier的结构投影按真实父Span回挂，首次读取无需正文；新Task/Skill保留原白名单结构字段，详情按单条精确版本读取。源hash/原文不变，同source revision重放不回写已存在facts/heads。早期已索引记录若未包含Task/Skill链接投影，完整正文仍准确保留，结构完整恢复需要后续显式重建派生投影，不自动重写旧数据。单工具或无carrier整组摘要超过2KiB时structure明确413，完整视图仍保留原文；core多工具分散到独立carrier，避免单assistant数组的2KiB瓶颈。

006会话/消息和007报告运行/head只追加表，三套001–005 DDL原始字节均未改。隔离SQLite目标显式备份后由5升级至7，38张原非schema_meta表的行数/内容摘要一致；原marker保留。诊断消息按seq/CAS与lease/fence提交，SSE完成前核验自身Trace的真实indexed receipt；报告冻结完整输入、持续续租、发布前复核授权，force/delete阻止旧任务回写。运行器、模型与工作目录按可信账号冻结，禁止通过客户端user越权或转用成员模型凭据。组内管理员可读已授权历史，跨actor续用同一上游返回409，可新建本人的上游。

| 验证层 | 最终结果及边界 |
|---|---|
| 应用全量`npm run test` | 5421条，5399通过、22明确跳过、0失败，161.766秒；Node24.22.3，独立HOME/SQLite，未改测试脚本或依赖 |
| 存储Python全套 | 578条，402通过、176外部环境条件跳过、0失败，34.351秒；ResourceWarning作为错误；开启已有真实CH只读夹具，含万Span结构零正文读取和单条精确版本 |
| 类型与退出清理 | `tsc --noEmit`通过；隔离/清理专项31通过。Prisma子进程关闭checkpoint后台写入；后台重试完成后再清库，超时仍恢复环境、断开连接并保留仍可能写入的隔离目录 |
| 三库事务合同 | SQLite覆盖于全套；真实PG与官方原生openGauss分别验证诊断27项、AgentTrace16项、报告19项，及追加迁移保留旧行；分别记录的领域合同，不冒称每种组合都跑过整套产品 |
| 真实运行链 | 真实OpenCode进程+本地OpenAI协议Mock+实际文件工具；两轮SSE为3次模型请求、1次工具调用、2次回答，历史4条；原AgentDebug runner为2次模型请求、1次文件写工具，报告done并有自身Trace receipt |
| HTTP/原界面 | 原故障页读回报告与两轮历史；自身Trace工具计数1，展开得到原调用ID、参数和输出；原Skills入口在无Skill样例下明确skipped。非空Skill步骤提取及调用使用定向测试，未据此声称非空Skills全流程真实模型验收 |
| 数据与进程隔离 | 新自身Trace在旧Prisma Execution/Session均为0行；本轮未对默认业务库迁移/清理。运行结束确认隔离OpenCode进程退出；仅保留验收用Next、存储与CH服务 |

最终本机证据在`exclude/storage-core-diagnosis/20261113-jk0keh_o/`：`npm-certified.log`、`python-certified.log`、`tsc-verified.log`、`real-final-runtime-results.json`、`public-original-ui-data-final.json`、`acceptance-migration.json`、`preservation-final.json`，以及`final-desktop-diagnosis.png`、`final-desktop-self-trace-tool.png`。原生三库证据分别在其`relational-006`、`relational-007`、`relational-recorder-final`子目录。临时凭据、备份及原文不提交。

验收服务为`http://localhost:58388`，沿用原`admin`登录方式；当前样例明确使用本地Mock模型，不代表外部真实LLM质量。旧聊天/报告尚未自动导入，生产切换、千级混合容量、DiagnosisRun/实验回流及其他尚未接管领域仍是后续任务，不能用本批零失败结果替代这些验收。


## 2026-11-14 Dataset 版本、回流与生成切片

本批沿原Dataset入口完成普通CRUD、字段/Case编辑、历史版本摘要/全文、Trace草稿回流及重复追加去重、原Trace批量生成/进度/取消/删除查询。008/009追加3表；复用资产release/私有gold制品及现有CH样本表。请求和worker绑定真实IAM主体，旧用户名参数不授予权限；未接可信上下文的消费者拒绝回退旧库。原组件JSX与基线eeab7c96逐字相同，只增加草稿ETag/If-Match和必要错误状态处理。

- 草稿基线缺失428、陈旧409；精确网络重试恢复原操作响应。历史ETag不冒充head。普通写入与新release/receipt原子提交，重复回流不制造空版本。分页/历史/完整样例读取受独立预算约束。
- 来源冻结保留真实Agent身份、准确head及完整文本摘要，Python验证工具大正文，JS仅消费采样所需事件；原normalizer/生产采样/content processor保持。完成时同事务提交Dataset版本、任务终态及receipt；CH成员异步物化，accepted与indexed分别检查。
- 任务30秒租约/epoch，撤权/取消/删除/重新领取后旧worker失效；制品慢I/O后重查来源与租约。重启只由原actor的有效进度请求触发恢复，不持久化Bearer。
- 实际HTTP暴露并修复两个问题：空DELETE body流应作为无请求体；Node24不能直接复制框架包装Request，改为从URL/方法/头/原body流显式构造。两项均先取得失败回归再修复，真实HTTP复测通过。

### 取得的证据

证据目录：`exclude/storage-core-datasets/20261113-1eyhms1l/`；内核三库补充证据在同级`20261113-ze2t7sek/`。失败尝试和成功结果均保留。

| 验证 | 结果与边界 |
|---|---|
| 全量应用 | 最新`npm-delivery-final.log`：5450项，5428通过、22跳过、0失败，180.544秒；隔离HOME/SQLite，非所有可选外部环境实机验证 |
| 全量Python存储 | `python-resume-final.log`：646项，467通过、179跳过、0失败，51.995秒；跳过为可选真实引擎配置，不能算实机通过 |
| 类型与独立复核 | 完整tsc与六个存储桥接文件ESLint通过；独立最终复核37/37通过，组件JSX对基线一致；diff-check通过 |
| Dataset内核 | SQLite+实际CH最终41/41；PG和原生openGauss各37/37基线，另各3/3最终预算增量；不是声称单轮40项全矩阵。关系库测试facts sink为内存，SQLite组含真实CH部分失败重投 |
| 生成内核 | SQLite完整23/23；PG/原生openGauss各19/19基线及各4/4最终source-members撤权/取消/epoch/来源删除增量。关系库facts为内存，不冒充HTTP+CH全链路 |
| HTTP与CH | CRUD24次请求，可信owner、Unicode/小数/false、重试、两历史版本、成员隔离/组管理员、原Trace完整回流、去重、删除均通过；真实公开OTLP携带约3MiB工具输出，经原采样生成完整问答，CH release成员1条，工具正文未进入Dataset；最终生成13次请求通过 |
| 取消/恢复 | 私有入口创建并领取可控中断任务，原公开接口取消/删除回执/重复取消204、旧checkpoint409通过。真实重启Next/helper，三组已有Dataset保留；实际旧租约过期后，原actor进度触发恢复并发布，旧epoch仍409。该证据不声称无人请求自动恢复 |
| 原浏览器 | admin原登录态进入原`/dataset`：新建、单个添加、样例编辑、新增字段/值、刷新与重启保留通过；编辑期间另一请求推进head，旧草稿显示原保存失败且未覆盖新值，刷新后保存成功。最终页console无错误，截图`ui-dataset-final.png`，冲突截图`ui-stale-draft.png` |
| 数据保留 | 隔离core7→9先创建新备份，42张旧非schema_meta表内容指纹一致；旧Prisma的Dataset/job/receipt/Execution/Session五表在实际HTTP写入前后行数一致，最终五表完整内容指纹亦一致，见delivery-postflight.json；未迁移默认业务库 |

验收地址为 `http://localhost:58388/dataset/f6fe5758-96cc-4529-bd8d-8aadee44193b`，使用原admin方式登录，隔离服务保留运行。现有历史源库和失败fixture均保留。

### 当前仍未完成

实验/评测/重测/DiagnosisRun的业务消费者、Evaluator/Skill/Agent/Benchmark完整多版本管理和RunPlan/结果联动、非OTLP各采集写端、旧96模型逐字段语义导入/在线增量/停写切换与回退仍须继续。系统FI目录是只读动态视图，未来运行应冻结有效目录；完整Benchmark受控导入不是本批成果。1000在线采集端混合负载、细粒度写锁、HA与生产恢复仍未验收。不能将本批Dataset闭环说成全产品完成切库。


## 2026-11-14～15 实验、评测结果与 RunPlan 接入

010–014当前物理核心为62张事务表（含`schema_meta`，业务/控制表61张）和13张CH表，共75张。010增加8张实验索引，011增加2张诊断绑定，012增加5张Benchmark控制表，013修正空证据制品约束且保留012校验和，014增加1张派生Issue解决注解表。原始001–009不改字节；字段、主键、外键、索引和版本规则见字段字典。表结构存在不等于所有入口完成接管。

已接入普通实验创建/列表/详情/Case/评分/人工评分/评论/重评、比较实验、直接轨迹评测、Evaluator版本资产、后台监听与恢复、Trace/FI生成及取消、结果诊断预览/提交/报告读取。沿用原评分算法和DTO；模型、Dataset、Skill与Evaluator在RunPlan固定。只追加机器receipt与派生Issue解决注解，人工分和解决状态绑定实际机器回执。网络丢响应先查精确操作回执，不凭当前槽状态推断成功，不因此重发Agent。来源内容推进保留旧快照，来源撤权/删除及路由世代改变仍实时阻断私有读取和结果发布。

当前证据根为`exclude/storage-core-experiments/20261114-bemtvk1v/`。使用Node24、独立HOME/Prisma SQLite、独立事务库及CH database，未将默认业务库作为迁移目标。新服务58488/helper58487与先前58388验收服务独立。隔离core显式停写备份后11→12→13→14；备份和迁移报告均保留。

- 实际原HTTP创建并运行实验，Exact Match机器100分、人工0分、原操作精确重放、评论读回、单项重评100分与旧review不漂移均通过。旧Prisma Experiment/Case/Result的本批ID行数均为0。真实CH读回2条机器事实、3条指标、2条选择与3条发布成员，分别保留原运行和重评。
- 实际原HTTP预览→提交→重复提交→OpenCode/文件工具→诊断报告读回完成；Mock模型请求2次、工具调用1次，报告包含真实运行统计。诊断Agent自身Trace在新库具备绑定。使用固定本地Mock验证执行/存储链路，不代表真实LLM诊断质量。
- 实际验收暴露并修复详情页执行Skill关联投影缺失，以及HTTP body已消费后后台身份上下文克隆失败；保留红→绿证据。模型连接v2增加headers指纹，v1仅在无headers且原连接hash一致时兼容，旧计划不被重写。
- 源码AST比对：本批2个TSX文件共12个JSX根与HEAD逐字一致，仅隐藏认证调用适配；原布局、功能入口和显示结构不变。原浏览器已查看Trace、实验列表/详情、Case结果详情及实际诊断报告；本批保留UI状态和HTTP读回证据，未生成新的截图。
- Python存储中间整组891项，712通过、179因未提供可选引擎配置跳过、0失败，134.947秒；并非891项都实机执行。010/011/013/014另有PG及原生openGauss定向矩阵，详细日志保留。应用全量中间整组5710项，5685通过、22跳过、2失败、1取消；三处均为子进程/Worker超时，且宿主时钟有明显跳变；原三个文件定向复跑28.27秒通过，未改超时或产品逻辑。失败日志保留，继续最终全量复验，不据此宣称全量门禁通过。

- 一般Experiment、来源生命周期、gold隔离、Workbench取消和Benchmark失败事实投影，SQLite相关86项通过；真实PG/官方原生openGauss各100项通过，分别178.690/185.406秒。该矩阵早于随后Benchmark continuation来源标记增量，不能冒称覆盖增量。
- 服务私有合成凭据轮换4组、旧4组均撤销、新4组经真实HTTP身份验证；原业务/登录Key未改。轮换前已保留隔离库新备份，所有当时Outbox已sent且无运行中work；重启后普通实验100分、Workbench0分及诊断done均读回。成员bob新实验机器0分由组管理员正确读取，旧三张实验表对应行均0。
- 后台Benchmark恢复使用独立有界池，pending transport不会占普通监听的容量。来源内容升级不变更旧计划，来源凭据撤销仍阻断child scoring。多Case同时人工评分的发布互等已取得红→绿回归；索引进度与整批publication分离，未完成批次继续受限退避。

### 当前仍在收敛的范围

Workbench/Grayscale的创建、幂等、克隆、绑定Task、Case删除已通过真实HTTP；原本地OpenCode执行与固定Mock模型已完成，原Experiment GET读回机器0分与done，旧实验/Case/结果/Execution/轨迹结果/Evaluation六张表本批影子行均为0。冻结Dataset版本不随head更新，账号模型别名不参与授权，跨模块上下文与run范围取消均有回归。客户端验证及本地复测尚未逐个外部客户端真实验收。

Benchmark原创建/启动/实际device命令/提交/真实评测HTTP/规范化/后台恢复已取得隔离证据；Harness响应为受控夹具，不代表真实Agent运行或业务质量。失败来源分类器保留failed/null，不伪造零分或Harness执行；发布等待真实transport终态，未完成时Outbox保持pending，已索引事实不重复写入。补充评测、历史提交受控导入、单项重评、Case重跑和取消/删除已接通typed域；通用`/run`仍保持原202启动契约。外部执行未确认清理时不释放额度；native补充评测同Case/评估器历史的未知清理必须取得对应attempt/fence的typed回执才允许新重试。派生Issue的跨域解决通过可重放操作衔接，不宣称与旧静态Issue/优化计划有跨库事务。旧96模型全量语义导入、线上增量追平、生产切换与回退、1000在线采集端混合压测、队列分片/细粒度写锁及HA仍未验收。不得据此宣称全产品完成切库。
### 应用全量 v4b 的 Qoder PID 锁发布修复

本次应用全量快照的唯一失败 AC30 并非卸载等待时间不足：watch 先 `openSync(lock,"wx")` 暴露空文件，再写 PID，原测试和卸载按文件存在性观察时可能读到0字节JSON而漏停进程。临时HOME/自建child的真实bootstrap注入在open成功、write之前暂停，确定性复现卸载返回空PID集合且本次child继续存活；测试先红，未通过放宽超时回避。

上传器现先在同目录写完0600临时JSON并关闭，再以exclusive hard link原子发布完整PID；watch与oneshot复用同一acquire helper，保持活owner竞争拒绝、陈旧owner回收和只清理本owner锁的语义。临时文件在成功、竞争和可捕获异常路径均回收。既有卸载协议及等待时间不变。

既有Qoder测试新增完整锁发布/竞争watch/真实卸载与oneshot陈旧锁/替换owner保护；4文件共85项，84通过、1项平台条件跳过、0失败（14.15秒），JS语法检查通过。所有进程和目录均为本次独立夹具，清理只针对本次child/temp root；未触真实Qoder用户目录或运行进程。证据为`qoder-lock-publication-red.log`、`qoder-lock-publication-final.log`，位于本轮实验隔离证据目录。此处只记录该全量失败根因与修复专项，不提前替代Root后续最终应用全量门禁结果。


## 2026-11-15 本批最终集成验收

本批完成实验、评测结果、RunPlan及其Workbench/Grayscale、Benchmark、版本分析、优化点/FI、Trace流程分析和诊断优化部署消费者的新存储接线。保留原页面/布局、公开入口及评分算法；静态配置、客户端命令等尚属原控制域的记录仍在其真实存储，不将本批解释为全部96模型及整个平台切库。

| 验证 | 最终结果与边界 |
|---|---|
| 应用全量 | `integrated-current-final-v7.log`：5773项，5751通过、22跳过、0失败、0取消；275.74秒。独立HOME/Prisma SQLite、Node24.22.3，未修改依赖或测试scripts |
| 存储默认整套 | 948项，769通过、179项缺少可选实际引擎配置跳过，0失败；316.213秒。另有下述真实关系库及CH专项，不能把跳过计为实机通过 |
| 真实PG / 原生openGauss | Benchmark前一冻结阶段各77项主矩阵及6项补充通过；最后详情投影修正后，各10项（5项实际readView/投影/附件来源权限+5项取消身份）通过，33.61/34.87秒。最新版完整83项因与全量并行负载预计超4分钟而主动中止，日志保留；不将较早矩阵泛称为最新版完整83项通过。native清理重试guard另在两库各1项通过，源码边界及hash见各manifest |
| TypeScript / 静态检查 | 完整`tsc --noEmit --incremental false`零输出通过；34个新增src文件ESLint零错误，仍有未用变量警告。全部受改文件ESLint仍有70个既有/移动代码错误；HEAD对照确认Evaluator effect及version-analysis规则数量未增加，不宣称全仓lint通过。暂存新增文件后默认diff-check报6个EOF空行告警（4份已应用DDL、2个Python文件）；保留冻结字节以保护DDL校验和，仅忽略blank-at-eof的diff-check通过，未忽略行尾空格/其他空白错误 |
| Benchmark真实HTTP/CH | 原通用run启动、设备poll/提交、Harness HTTP、raw恢复、历史导入、补充失败、单项重评、取消cleanup及Case重跑均有隔离证据。原Case POST返回202、运行中重复409，2次fixture命令和2次Harness评测，新CH结果/selection/publication各2份；11张旧动态表本fixture行数均0。设备/Agent与Harness内容为受控夹具，不是真实客户Agent或正式Benchmark质量成绩 |
| 原详情阻断修复 | 实际Next暴露缺Benchmark投影导致500；改为授权后的完整typed read_view，保留真实attempt/progress/嵌套时间及制品。修复后原详情、分页和Case定位三路200、真实75分；原提交物/评测证据下载专项通过，私有gold未泄露，不完整投影明确拒绝 |
| 原界面与历史读回 | 两个TSX文件12个JSX根与HEAD逐字一致。此前浏览器已看原Trace/实验/Case/诊断报告；最终服务重启后，原实验100分、Workbench0分、诊断done再次真实HTTP读回。新增Benchmark浏览器验证因CUA无可用浏览器/窗口未完成，仅有原HTTP验收，不冒称浏览器通过 |
| 数据保留 | 28个001–009/CH旧DDL与HEAD字节一致；隔离core schema14且integrity正常。4份迁移前/凭据轮换前备份分别schema11/12/13/14，均保留且只读完整性检查通过。默认业务库未作为迁移目标，失败尝试与旧样本未删除 |

补充的Flow实际HTTP验收产生6次Mock模型请求、6条indexed Judge Trace和3份机器receipt，派生Issue进入新域；部署实际原handler及设备poll/artifact/status链路完成，3 PRECHECK+1 DEPLOY为模拟设备回执，不代表用户机器实际安装。各自独立夹具的旧动态表零行只适用于对应fixture；主验收旧库保留已有15条Execution/Session，不作整库零行声明。

主验收有2条Flow结果Outbox仍pending：负面测试在机器receipt后主动删除来源Trace，真实删除屏障阻止后续投影，来源检查为409且继续退避。只读复核已精确对应原删除测试，不是缺失发布成功，也未修改来源或伪造sent。正常Benchmark Case验收自己的Outbox均sent。所有293个代码/测试/schema候选文件在最终全量运行前后SHA一致；设计与指南不在该源码冻结集合中。

当前服务为`http://localhost:58488`，原实验验收页`/evaluation/3ccd2aac-489c-4a05-8c73-ebd9b0b61e71`，Benchmark详情`/evaluation/bexp_76829620a1207944ab1d9e2f29868045`；沿用原admin登录方式。证据仍在本批`exclude/storage-core-experiments/20261114-bemtvk1v/`，最终源码manifest、whole logs、`final-review/`、各实际HTTP报告均保留。

旧库96模型语义导入、线上增量追平/停写切换/回退、尚未接管的静态控制领域及非OTLP写端、infra、final_result关联重评、1000采集端混合压测、细粒度写锁/队列分片和HA仍未完成。以上为本批消费者集成验收，不能直接作为生产切库授权或整个平台迁移完成结论。


## 2026-11-15 剩余消费者盘点、语义计划与首批闭环

已按当前源码重新盘点并登记[phase7清单与依赖](phase7-consumers-and-legacy-migration.md)。96模型按15域无遗漏分组，机器目录涵盖1250个物理字段、键/关系/owner/敏感处理。现有原始export、限定Trace转换和新的只读plan是不同能力，普通CRUD/启动不能替代历史事实导入。

本批完成：

1. `plan-legacy --database --source-id`只读诊断。检测schema/键/FK与有限逻辑引用、owner/归一化歧义、native身份冲突、循环、秘密处理及预算；不完整扫描不对未读父表误报语义孤儿。仅显式SQLite源，未实现导出目录输入，所有计划仍blocked/full_migration_ready=false，不连接目标、不apply。
2. 原优化点GET/resolve PATCH与新派生Issue闭环。真实actor、Skill范围、当前机器selection及来源验证，静态/feedback原域，派生只追加014解决注解；混合跨库不称原子。无threadId通过真实操作receipt保留公开null，014字节不变。只读凭据和其他owner/管理员均不能代为解决；长请求键通过稳定hash保持有界。
3. 原价格GET的observed模型只读当前IAM范围内的真实Trace model facet，价格、占位过滤、排序及DTO保留；PUT原样保留旧配置控制域。补原apiFetch对pricing GET、优化点GET/resolve PATCH的精准Key传输，账号切换/退出/显式Key与prefix不变，没有TSX/CSS改动。

| 验证 | 本批最终结果与边界 |
|---|---|
| 应用全量 | 5794项，5772通过、22跳过、0失败/取消；205.54秒，Node24、独立HOME/SQLite，无依赖/scripts变更 |
| 存储整套 | 969项，790通过、179项可选引擎配置缺失而跳过，0失败；234.244秒，ResourceWarning作为错误；不把跳过计实机通过 |
| PG/openGauss | 最新resolution12项+迁移保留1项，两库各13/13，无跳过；39.727/41.470秒。各13个自建schema已清理且回查0，host/native源码副本140文件SHA前后及当前源一致。未把SQLite专用旧库plan宣称为PG旧源导入能力 |
| 静态/复核 | 全仓tsc零输出通过；本轮6个受改/新增TS源文件ESLint零输出通过；设计本地链接检查通过。T1、T2、T3分别spec与独立quality复核，发现的认证传输遗漏和长key/预算边界均有RED→GREEN；新文件暂存后仍检查空白 |
| 真实原HTTP/CH/IAM | 全新SQLite+独立CH database，原handler通过真实HTTP使用实际apiFetch生成的Key：优化点可见→混合解决2→刷新隐藏→新请求重复0；无thread公开原DTO不增字段，typed关联仍null。read-only/他人/组管理员403，匿名401；Alice/Bob各自模型，组管理员本组两者可见，伪user不提权。13次请求通过，无LLM/Agent执行、无浏览器验收 |
| 无旧动态影子 | 上述夹具旧Execution/Session/Experiment/Case/Result/轨迹结果/动态Evaluation/动态Issue八组计数均0；两个真实旧static Issue保留且只有被选中者解决。不把静态域存在当成动态回落 |
| 只读迁移计划实际命令 | 原Prisma实际96表、4条合成静态业务行，显式owner映射；计划完整扫描并准确报告旧User行缺失4处，仍blocked。源db/WAL字节和mtime不变，不输出值，不尝试修复或导入；另有完整96空表与多类异常专项 |
| 已有验收环境保留 | 刷新前新SQLite备份保留，原服务无活动work；重启没有覆盖UserSettings/模型配置。前后62张core及96张旧表内容指纹均一致；旧原Key→新IAM映射、100分实验、0分Workbench和诊断done读回；原Next pricing GET也200且伪user无效。没有修改默认业务库或生产连接 |

证据目录为`exclude/storage-core-phase7/20261115-8n_yeuoj/`：`npm-final.log`/`npm-final-result.json`、`python-final.log`、`final-source-manifest.json`、`t2-relational-current.json`、`acceptance-v2/original-http-report.json`与`legacy-plan-proof.json`、`main-ui-preservation.json`和readback。首次隔离尝试的loader/断言失败与数据均保留，没有重置原fixture；当前16个源文件与全量开始时SHA一致。原GUI仍在`http://localhost:58488`，可见组件/布局零改动；本轮未在浏览器中验证。

### 后续依赖及未完成项

优先继续统一授权摘要/当前selection与Agent元数据，再接Dashboard/Fleet/Task/Quality/Skill动态统计；不能用假failure/注册信息、缺字段补零或读完整Trace正文取代摘要契约。之后按phase7接final_result/rejudge/cancel、Batch/旧Trigger闭环和可信采集接收/积压重放，再推进RAS、Infra、FI/客户端事务、Goal Plus/协作/Usage及逐域历史导入。

特别修正此前“非OTLP”概括：**OTLP logs、OTLP metrics与legacy spool consumer也仍在旧写域**，不能视为已迁。旧spool不得仅凭payload.user转用IAM身份或在未indexed前推进cursor；尚未进行迁移/清理。Skill/配置/工作台等静态或控制域仍为原权威，迁移要保留其真实事务与秘密边界。生产停写/切换/回退、96模型完整逐字段apply、千级混合压测、HA等未完成，仍不能宣称全产品完成新存储切换。


## 2026-11-15 第一版统一授权摘要与原统计消费者验收

第一版范围按用户要求收口为原有功能等价与数据支持替换。原组件、布局、操作流程及统计口径保留；万级Span、统计水位cut、016迁移、复杂虚拟导航及千级混合容量优化留到第二版。第二版草稿与失败试验数据隔离保留，未进入当前运行协议或迁移目录。

本批接通Dashboard、Fleet趋势/分布/Agent/可靠性、Task统计、Quality Agent列表/执行记录/报告，以及RAS事件采集事实。业务通过统一授权摘要读源使用当前Trace选择、Owner、版本及当前评测/诊断来源；不回落旧动态表，不以假注册信息或缺字段补零取代原含义。原生Trace级可选用量只接受明确来源。后台生成投影，读取仅做有界分页和当前来源复核，版本冲突最多重试三次；临时子执行直接钻取其真实所属Trace，在原Agent树查看。

新增关系库015三张表及CH002两张表，当前为65张事务表、15张CH表。001–014与CH001既有43份DDL字节不变。迁移和CH新表初始化均显式执行；未将第二版016放入当前schema。

| 验证 | 本批最终结果与边界 |
|---|---|
| 应用全量 | 5826项，5804通过、22跳过、0失败；169.35秒，隔离HOME/SQLite，无依赖或scripts变更 |
| 存储整套 | 999项，820通过、179项可选引擎配置缺失跳过、0失败/错误；188.66秒，ResourceWarning作为错误。恢复后的147个Python文件与该已测V1快照逐字节相同 |
| PG / 原生openGauss | 各51/51真实引擎检查通过，无跳过；每库37个自建schema清理后回查为0。不是全产品生产迁移验收 |
| 真实CH | 15张表，11项身份/当前选择检查及8项预算边界检查通过；没有执行万级Span或千级混合容量验收 |
| 原HTTP与授权 | 新隔离SQLite/CH中原handler与实际apiFetch共18次请求通过，旧动态读取0；包含真实临时子执行统计→所属Trace钻取、无Key/跨用户拒绝与现有评分来源 |
| 原浏览器界面 | 原Trace页、Dashboard、Quality报告、Agent/Skill筛选、空结果和执行记录实际验证；当前浏览器控制台0错误/0警告。TSX/CSS零diff，没有替换产品界面 |
| 类型及静态 | 完整tsc零输出通过；10个新增TS文件ESLint零错误/警告；受改旧文件与HEAD对照无新增lint问题，仍有旧问题，不宣称全仓lint干净。diff-check通过 |
| 数据保留 | 已有隔离环境备份后14→15；旧96张表内容、旧13张CH逻辑内容及既有业务/认证行保留，SQLite integrity_check为ok。4组过期测试服务凭据追加续期，原登录Key未改；两条既有负面Outbox仅正常更新重试元数据，事件及payload保留。默认业务库及生产未操作 |
| 历史读回 | 原普通实验100分、Workbench0分、诊断done通过真实HTTP再次读回 |

证据在`exclude/20261115-ob765mlu/`，包括`v1-final-full.log`、`v1-types-final.log`、`acceptance-v1-final/original-http-report.json`、`main-ui-preservation.json`、`main-ui-readback.json`、浏览器截图及日志；Python、关系库与CH冻结报告在其`kernel-wire-final-*`目录。原界面仍可通过`http://localhost:58488/dashboard`验收，沿用原admin登录方式。

这次完成首批统计消费者接线，不代表全产品迁移完成。Skill/Agent其余动态消费者、RAS专项剩余读/删控制、OTLP logs/metrics和旧spool、其他phase7消费者及96模型完整语义apply仍按清单推进；静态配置/客户端/FI原控制域继续保持真实权威。生产切换及回退未执行。下一步继续补原功能的数据链路和历史迁移，不扩展第二版容量机制。


## 2026-11-15 第一版 Skill 与 Agent 剩余动态查询接入

本片只替换原Skill列表、版本页和Agent管理GET的动态数据库调用，保留原UI、DTO、7/14天窗口、800条及每版本30条规则、成功率/P95/趋势和真实agentId统计。静态Skill/版本/static evaluation/RegisteredAgent继续原控制权威。原POST/DELETE逐字保留，没有新增表、迁移或parser协议。

版本页仅为显示记录读取完整输出，使用显式`view=execution`及独立`agent-insight.trace-execution`格式，合法无Session执行可读且不伪造轨迹；默认完整Evidence仍对缺失Session返回404。原生根Agent ID恢复三个明确别名，后代ID不能冒充根。Agent元数据复用既有来源验证，每批200条，仅发送真实身份及role/agent/subagent_name；bundle索引、Langfuse secondary、原生资源优先及agent.record.v1的消息顺序/工具carrier均按各自原协议处理。最近300条补注册只选本人，IAM规范用户名与旧静态Owner别名分别保留，组内/共享读取不成为代注册权限。core失败保持明确错误，不回落旧动态表或伪装0调用。

| 验证 | 最终结果与边界 |
|---|---|
| 应用全量 | 5846项，5824通过、22跳过、0失败/取消，269.78秒；独立HOME/SQLite。首次全量5845项零失败后，因新增真实Owner别名回归再次完整运行 |
| 存储整套 | 最终1012项，833通过、179项可选引擎缺配置跳过、0失败/错误，178.39秒；ResourceWarning作为错误。148个源/schema/test文件运行前后SHA相同；早期全量与审查修复并行导致manifest改变，不作为最终源码验收 |
| 真实PG / 原生openGauss | 各12/12通过，无跳过；分别35.13/39.79秒。每库12个自建schema回查无残留；包含Agent元数据、无Session execution view及native根/后代身份，事实sink为测试MemoryFacts，不混称CH矩阵 |
| 真实HTTP/CH | 全新SQLite和独立CH database，原handler、真实Prisma静态域与apiFetch共9次请求通过；动态旧表毒化读取0。覆盖完整Unicode长输出、空输出、无Session、真实Agent ID计数、实际Recorder自动发现、私有Skill/Agent、无Key401及伪user不扩权，无LLM执行 |
| 原浏览器界面 | 原Agent概览、Skill管理列表及版本历史实际验收。真实隔离Agent已显示，Skill列表2项/7天3次调用；既有示例卡片保留，不将示例数据当作真实统计证据。当前页控制台0错误/0警告；TSX/CSS零diff |
| 现有隔离环境数据保留 | schema15不变，刷新前core/legacy两库备份完整性正常；65张core表和96张旧表既有业务/凭据保留，13张旧CH逻辑内容相同。8条真实observed注册新增，原注册行保留；两条既有负面Outbox仅正常更新重试元数据。没有操作默认数据库或生产 |
| 既有链路读回 | 普通实验100分、Workbench0分、诊断done再次真实HTTP读回，4组既有服务身份仍有效，原登录Key不变 |
| 静态及复核 | 完整tsc零输出通过；新增文件及对应测试ESLint通过，受改旧文件另有HEAD规则基线对照。Skills和Agent各经spec及quality复审，发现的sessionless/native身份、Recorder格式和Owner别名问题均有回归；diff-check通过 |

证据仍在`exclude/20261115-ob765mlu/`：`consumer-v1-final-full.log`、`consumer-v1-python-final-v2-{manifest,report}.json`及日志、`consumer-relational-*`、`acceptance-skill-consumers/original-consumer-http-final-report.json`、`consumer-v1-main-preservation.json`、`consumer-v1-main-readback.json`和`consumer-v1-{agents,skills,versions}.jpg`。原验收环境仍在`http://localhost:58488/config/skills`及`/agents`，沿用原admin。

本片未接管Skill runs/logs、Agent删除、独立rejudge/cancel、Batch/Trigger、其他采集/Infra/RAS/配置域与完整历史导入；它们继续按phase7推进，不据此宣称全部功能迁移完成。万级Span/水位/容量机制继续留第二版，未执行生产切换。

## 2026-11-16 第一版运行记录、可靠性与独立答案评测接入

本批接通 Skill runs/logs、RAS 专题 GET、Trace 可靠性详情、FI Run 的 Trace 纯读，以及独立重评、Final Result 编辑、取消和 Query 编辑。保留原筛选、版本、分页、状态、评测算法、DTO 与前端界面。静态 Skill/版本/Config/RegisteredAgent、FI 控制记录仍是原控制域权威，不将这些域宣称为整体迁移完成。没有新增表、迁移或 parser 版本，仍为 015、65 张事务表和 15 张 ClickHouse 表。

答案评测复用内部 Outcome Experiment、现有 RunPlan、工作回执及 lease/fence；Trace、Skill 记录和统计读取同一专用当前结果，普通实验分数不覆盖答案。保留真实 0、未知 null、原失败分析和历史已知主版本，实际调用版本单列。Query 编辑事务封存原算法重算的路由快照并清分，不启动模型；无 Session 的合法执行可编辑 Final Result，无 Config 时仍保存并产生原未知分含义。真实 owner/write 检查先于 Evidence、Config 和模型读取。组内可见不成为代写权限。

取消期间，迟到录制仍被原 fence 拒绝；仅明确录制拒绝分类或非 uncertain 的 attempt 拒绝，并经当前 Outcome、原 slot 与再次当前状态授权复核证实已取消或替换，才返回原取消 DTO。录制失败、未知投递（包括 409/410）与权限查询失败继续报错，未放宽录制或来源验证。真实 HTTP 发现的结果 publication 内部状态误冲突、写预检和取消响应问题均有 RED→GREEN 与独立 spec/quality 复核。

| 验证 | 最终结果与边界 |
|---|---|
| 应用全量 | 最终冻结 v7 共 5915 项，5893 通过、22 跳过、0 失败/取消，522.27 秒；Node24、独立 HOME/SQLite，原 collector 类型预检与完整 test glob 均执行。Node 并行参数置于 glob 前，经独立探针确认限制为 4；项目 scripts/依赖未改。此前原 npm test 的 v5 为 5910 项零失败，未包含最终取消增量，不替代 v7 结果 |
| 存储整套 | 1068 项，889 通过、179 项可选引擎未配置跳过、0 失败/错误，290.15 秒；ResourceWarning 作为错误。153 个后端源/schema/test 文件运行前后及最终当前源码 SHA 相同；跳过不算实机通过 |
| PG / 原生 openGauss | 各 56/56 通过、无跳过，425.91/437.24 秒；每库 56 个自建 schema 回查残留 0。PG 在 host psycopg2，openGauss 在原生 Linux aarch64 驱动环境；事实 sink 为 MemoryFacts，不混称三库与 CH 的完整组合矩阵。当前后端与实测快照一致 |
| 真实原 HTTP / CH / IAM | 全新 SQLite 与独立 CH database，原 handler、真实静态 Prisma 与实际 apiFetch 共 51 次请求通过；7 次本地 Mock 模型 HTTP 调用及真实 Judge Trace 录制，非外部模型效果验收。覆盖精确重试不重复模型、服务重启、真实 0 分的 Trace/Skill/统计一致、Query 重算、无 Session/无 Config 编辑、运行中取消及迟到录制拒绝；旧动态表读写毒化访问计数 0 |
| 原 Next / 浏览器 | 实际 Next 的原重评、取消及编辑入口能加载并按真实权限拒绝不可用来源；非成功写入证明。浏览器刷新后保留 2 个 Skill、3 条真实运行记录及原未知状态，v0 空结果提示正常；原激活版本未改，控制台 0 错误/警告，TSX/CSS 零 diff |
| 类型 / 审查 | 全项目 tsc 通过；相关 ESLint 0 error，flow 文件既有 unused catch warning 1 条单列保留。各片 spec/quality 与最后取消增量均通过；最终 3070 个已列源码文件 SHA 未变，当前实现与冻结 overlay 相同，diff-check 通过 |
| 现有数据保留 | 原验收环境先备份 core/legacy 两库，schema15 不变。65 张 core 表、96 张旧表的业务内容、全部 15 张 CH 逻辑内容、原凭据和注册行保留；本次刷新 0 新注册、0 归属规范化，仅两条既有负面 Outbox 正常更新重试元数据。早一轮曾由未改动的原 normalizer 规范化 4 个已知系统 Agent 的 ownership，独立前后证据保留，未将其宣称为逐字节不变。数据库 integrity_check 为 ok，默认业务库和生产未操作 |
| 历史读回 | 4 组既有身份有效；普通实验 100 分、Workbench 0 分、诊断 done/report 再次通过实际 Next HTTP 读回，原登录 Key 保留 |

证据位于 `exclude/storage-core-next-consumers/20261115-dz8_dnl_/`：`consumers-final-v7-node-full.log`、`consumers-final-v5-python-sequential-{report,manifest}.json`、`final-v4-relational-*`、`acceptance-current-consumers-v9/{outcome,current-consumer}-http-report.json`、`final-v7-code-verification.json`、`final-v7-consumers-main-{preservation,readback}.json`、`final-v7-next-runtime.json` 与三张 `final-v7-*.png`。失败、超时和被后续审查替代的快照均保留；v4 三项应用失败中两项为 OTel 测试时序假设（已本地提交受控时钟回归），另一项超大输入去重在低竞争隔离单文件复验 38 秒通过；v4 存储整套触及脚本 900 秒上限，不算通过，最终顺序运行结果如上。没有扩大业务超时或放宽原断言以换取通过。

原验收入口仍为 `http://localhost:58488/config/skills`，沿用原 admin。下一步按 phase7 接 Batch Trace evaluate/retry/abort 与当前进度，再接 Dataset start/retry、Trigger、可信采集和旧积压确认；Agent/RAS 删除、Infra、FI/客户端控制、静态资产/配置/会话、Goal Plus/协作/Usage 及 96 模型完整语义 apply 仍未完成。生产停写/切换/回退未执行，万级 Span/水位/千级混合容量继续留第二版，不把本批接线当作全产品切换完成。

## 2026-11-16 第一版 Batch Trace 接口接入

本片接通原 Batch Trace 的 evaluate、retry-evaluate、abort 与进度查询，保留 collection 创建时 JSON 字符串、detail 解析后的 JSON、原 flat CaseState、0 分 done 仍为 pass 的含义。静态 BatchEvalTask/配置仍由原控制域保存，动态 Case、冻结输入、RunPlan、当前工作与结果使用现 Experiment 接口；不把 Dataset 执行或整个 Batch 宣称为已迁移。原前端 TSX/CSS、数据库表和迁移均未改。

现私有 Experiment RPC 的 `batch_scope` 按固定操作实时检查 read/write/execute，先于静态写、Skill/配置和模型读取；不按 workspace role 推断 API credential capabilities。主体验证使用真实 principal，兼容登录名与 IAM 名不同的旧数据归属。静态绑定及 PATCH 使用精确 CAS；启动与响应恢复共用已有 start operation identity/回执，完成后新意图建立新代；单条重试和取消不抹掉已完成兄弟，取消后仍可重试或追加 Trace。`coreWork` 从当前 slot/work/attempt 读取真实时间，机器 JSON 不能覆盖，普通 DTO 不枚举内部字段。仅已授权证实删除的 backing head 隐藏任务，未知/foreign 绑定不吞成删除。

apiFetch 仅为这两个 Batch POST 动作保存有界请求签名/UUID（最多32项，不存正文或凭据），响应丢失/坏 JSON 保留同 key；确认可解析的 `{ok:true}` 后才清除。显式 key、其他 API 及普通非 JSON 请求保持原行为。没有新增通用请求框架。

| 验证 | 最终结果与边界 |
|---|---|
| 应用全量 | 最终 v2 共 5973 项，5951 通过、22 跳过、0 失败/取消，406.12 秒；原 collector 类型预检与完整 test glob，Node24/独立 HOME/SQLite/并行4。旧 v1 为客户端 ACK 新回归主动中断，3023 项中 412 取消，不作为通过 |
| 存储整套 | 1073 项，894 通过、179 项可选引擎未配置跳过，0失败/错误，238.50秒；ResourceWarning作为错误。153个后端文件前后和最终源码SHA相同，ACK后续只改客户端及测试/说明 |
| PG / 原生 openGauss | 本片5项新合同及5项关键回归，各10/10，无跳过；26.54/31.66秒，各10个新建schema回查残留0。原生OG为Linux aarch64驱动；测试事实sink不是CH，不宣称全矩阵 |
| 原HTTP / CH / 模型 | 原handler+实际apiFetch在新SQLite/独立CH中46请求通过，6次本地Mock模型HTTP调用、最大并发确为配置1；真实0分仍pass，单条重试使用当前时间，取消保留完成兄弟，取消后可重试及追加Trace。丢响应重试不重复模型，另一个Node进程能恢复进度。旧动态表毒化计数0，9张旧动态表实际均0行 |
| 补充真实合同 | 原HTTP软删后集合仍200且仅隐藏删除项、单查404；完整但坏JSON的200正文被拒绝，同操作恢复后确认并清key，Run/Work/receipt计数均不增加；有execute权限的真实组管理员可读成员源200，但私人评分403且模型配置读取0。Readonly、write-only、无execute的同主体权限路径均实际验证 |
| 类型 / 复核 | 最终tsc与目标源ESLint退出0；eval-producers测试原有两项lint与HEAD对照未新增。主体和ACK增量分别spec/quality通过。3072个已列快照源码SHA不变，当前实现与冻结overlay相同；无schema/TSX/CSS变化 |
| 原环境保留 | 刷新前core/legacy两库备份及完整性检查通过，schema15、65张core/96张旧表保留，原凭据、注册行、业务行未删除/修改。原评测页首次打开触发**未改动的既有内置可靠性数据集初始化**：只追加1组定义/发布/兼容索引、133个工件元数据、1个发布Outbox及两张CH各33条新数据集事实；逐行证明旧记录全部保留，CH排除该新dataset/release后的逻辑哈希与原15张表相同。两个旧负面Outbox仅正常更新重试元数据。没有操作默认业务库/生产 |
| 实际原界面 | 原Skill评测概览/用例分析布局正常，原导航、控件、原admin登录保留；当前浏览器0错误/警告。未启动真实外部Agent或把本地Mock当模型效果验收；Dataset执行未作浏览器运行验收。普通实验100分、Workbench0分、诊断done/report和4组身份再次通过实际Next读回 |

证据：`exclude/storage-core-batch-trace/20261116-sj_6m2rd/` 中 `batch-v2-node-full-{result.json,log}`、`batch-v1-python-full-{report,manifest}.json`、`native-v1-*`、`acceptance/batch-*-report.json`、`ack-no-duplicate-work-proof.json`、`batch-http-storage-proof.json`、`batch-v2-main-{preservation,readback}.json`、`final-code-verification.json`、`main-original-case-layout.png`。最初缺少隔离SQLite空文件的harness失败、被替代的v1和数据保留校验首次假设过窄的失败均保留，未重置夹具、放宽旧记录保留或修改原断言换取通过。

下一依赖在原用例页面审查中明确：未独立重评的普通Trace，其compact兼容DTO还缺主Skill/版本引用，前端严格root_skill匹配可能无法选择；已在隔离普通checking@1源实际复现，不能因主验收环境3条grayscale按原规则隐藏而误判。先补该原DTO/筛选来源（不改UI、不猜未知版本），再接Dataset start/retry-execute、Trigger与后续phase7清单。生产切换、完整历史apply与第二版容量目标仍未执行。


## 2026-11-16 普通 Trace 主 Skill 与历史字段补齐

本片补齐原 Case/Trace 列表所需的真实主 Skill、历史版本、调用引用、历史答案/Skill评分、原因、失败与 Skill issues；未重评普通 Trace 不再依赖后续 Outcome 才能显示主引用。未知版本仍为 null，0 有效；显式关系空集、未捕获关系与全局 facet 降级分别遵循原规则，当前专属 Outcome/reset 与筛选共享同一选择。合法 JSON 字符串 null 保留原字段语义，非法集合仍拒绝。

复用 analytics 私有 execution_metadata 与现来源/IAM 校验，1..200项、含RPC外封装8MiB、同次列表所有分页实际工件读取累计128MiB，超限413。无新 schema/parser/公共路由/前端变更；读取 carrier 仍可能涉及 Session 字节及 Span 元数据，不能声称零正文读取或容量已达标。

| 验证 | 结果与边界 |
|---|---|
| 应用全量 | 5973项：5951通过、22跳过、0失败/取消，618.73秒；candidate-v1冻结快照。其2367个Web源码文件与最终candidate-v2完全一致；后续仅Python合法null/响应cap及测试、文档变更，由最终后端全量与真实接口补验，不混称两个后端快照相同 |
| 最终后端全量 | 1090项：911通过、179环境条件跳过、0失败，241.27秒；155个源码/目录文件指纹前后及当前一致 |
| PG / 原生openGauss | 各17/17专项、无跳过，41.91/48.41秒；各21个自有schema清理后残留0，159个测试来源文件读回一致。Facts为内存夹具，不称全CH组合矩阵 |
| 独立审查 | Spec与Quality均通过；合法encoded-null与RPC外封装cap问题修复后17/17复审通过；RED与旧失败日志保留 |
| 真实原HTTP/界面 | 实际CH+SQLite上增加3条隔离普通Trace：版本1、0与未知；原页面v1/v0各只显示对应1条、v1可勾选，未知不补最新；控制台错误/警告0。原实验100分、Workbench0分与诊断done/报告继续读回 |
| 数据保留 | 刷新前2份SQLite一致性备份；65控制表、96旧表行保持，只有既有负例Outbox重试时间/次数元数据推进；15个CH表逻辑摘要保持。3条验收Trace为明确新增隔离样本，未迁移/清理默认业务库 |
| UI与性能 | 本片TSX/CSS零变更；对原恢复基线，已有4个前端文件仅请求鉴权/ETag快照处理变化，28个JSX根源码全部相同。32条可见Trace空闲原HTTP为4.09/4.44/4.92秒，门禁高负载重叠曾触及原15秒超时；未扩大超时或放宽来源一致性，第二版再做容量与读取优化 |

证据：`exclude/storage-core-next-consumers/20261116-m6gj2c0f/` 的 `final-code-verification.json`、`candidate-v2-final-python-python-report.json`、`candidate-v2-native/`、`normal-source-http-green.json`、`normal-case-final.png`、`normal-case-v0.png` 和 `candidate-v2-main-preservation.json`。原验收界面仍为 http://localhost:58488/skill-eval ，已有隔离账号保持。

下一片按 phase7 已补齐的 Dataset Batch 计划继续：先补 autoEval=false 与持久准备/消费，再多数据集固定版本、重试/取消、原平面进度及真实录制回执闭环。静态 Batch/配置权威、其他采集与控制域、96模型语义迁移仍未完成；本片不代表全产品接管或生产切换。


## 2026-11-16 第一版 Dataset Batch 执行接入

原数据集批量任务的 start/retry-execute/retry-evaluate/abort 已接现有 Experiment、RunPlan、工作回执及可信 Agent 录制；静态 Batch/Skill/配置继续原控制权威。一次选择可跨多个固定 Dataset release；同 Task 新启动采用新切片，单 Case 重试沿用自己的原输入、gold、Skill/评估器/模型，不随其他 Case 的新启动漂移。autoEval=false 保留执行 Trace 与时间但不启动评分；自动评测取父执行封存参考答案并保留后续 Case 输入与参考答案编辑。版本0、真实0分、空/null、完成兄弟保留及取消后迟到结果拒绝均有验证。

返回成功前持久提交所有选中执行工作，使用准确 prepared/submitted CAS 与 operation receipt；读进度不启动模型。恢复同实例已观测结果时先重放原 waiting_trace checkpoint 和时间，再提交完成；硬重启无物理退出证明仍 pending/503，不自动重跑。受保护内部绑定和机器结果不能被 PATCH 覆盖，所有 Case 和版本先校验再事务批量写。客户端只保留账号/Task 范围内有界签名，严格成功 ACK 后清除，abort 成功只清同作用域。Agent Recorder 明确携带的 skill_version 映射到原 canonical skillVersion，0 保留，缺失不补最新，不改写历史。

| 验证 | 最终结果与边界 |
|---|---|
| 应用完整测试 | 冻结 V5：6020项，5998通过、22跳过、0失败/取消，659.86秒；Node24、完整原 glob/collector类型预检、并行4、独立HOME/SQLite |
| 后端完整测试 | V5：1101项，922通过、179可选引擎环境跳过、0失败，628.83秒；ResourceWarning作为错误，155个来源文件前后稳定 |
| PG / 原生openGauss | 各18/18，无跳过；117.15/220.67秒，各21个自有schema清理后回查0，159个来源文件前后/当前一致。事实sink为MemoryFacts，不冒称全CH组合矩阵 |
| 真实原HTTP与录制 | V4独立SQLite+CH、实际原handler/apiFetch、168次请求、11次本地Mock调用和真实OpenCode通过，旧动态表毒化访问0；覆盖多Dataset/新cut/旧Plan重试、固定v0、取消/迟到、丢ACK、新进程进度、权限和gold不入Agent。V5只增Benchmark投影窄修复与回归，最终原Next另完成真实Agent→评分0→原详情→Trace，耗时6.0s，无外部模型效果验收 |
| 原界面与限制 | 原数据集面板显示1用例，原实验/Case详情显示完成和有效0分，原Trace展开1 Agent/2 LLM/1工具。TSX/CSS零改动；应用console错误/警告0，IAB Electron宿主另有2错误单列。原双Judge兼容接口只识别任务完成度/轨迹质量ID，精确匹配结果在该页缺双分而显示失败，原映射未改；不将此画面当双Judge评分通过 |
| 数据与历史保留 | 刷新前2份SQLite备份；65张core、96张旧表原记录及15张CH旧事实逐行/哈希子集保留，仅旧负面Outbox重试元数据正常推进。2个明确新增隔离Dataset（含harness首次成功创建后Python取method错误保留的样本）、1任务/实验/原生Trace与相关事实追加。原4身份、100分实验、0分Workbench和诊断done/report再次读回；默认库/生产未操作 |
| 静态与独立审查 | 142项聚焦、tsc通过；lint0error，local helper既有2 unused warning保留。V4及V5均经Spec→Quality，V5独立各8项。3078个冻结来源及26个overlay与当前字节一致，无schema/parser/purpose变化，仍015/65+15；用户AGENTS.md未提交 |

完整回归发现的26个后端/7个应用Benchmark失败来自新的coreExecution投影误把Benchmark publish槽当普通execute槽。V5只在scope=benchmark、准确work/run/Case/slot及execute-kind job全部匹配时保留原Benchmark投影，普通缺失/阶段损坏仍明确失败；Benchmark+Experiment157项及完整最终门禁通过。首次完整后端另有1次Trace导入鉴权错误，独立原例及最终整套未复现，失败日志保留，不把首次运行称通过。原生OG首次检查时隔离gaussdb已退出；确认stale PID后用原数据目录gs_ctl恢复，未重建库，失败日志和重跑证据分别保留。

证据在 `exclude/storage-core-batch-dataset/20261116-khyxgzb7/`：`final-code-verification.json`、`candidate-v5-result.json`、`candidate-v5-final-python-report.json`、`candidate-v5-native/`（PG）及`candidate-v5-native-opengauss-recovery/`、`acceptance-native-v4/batch-dataset-http-report.json`、`main-dataset-http-report.json`、`main-data-preservation.json`、`main-regression-readback.json`与三张`main-original-*.png`。仅本地检查点，不切生产/不执行完整历史apply。

后续先排查原Trace读取：多原页面轮询时，单条lookup与列表曾触及原15秒超时；关闭其他轮询后同条原HTTP200、3.998秒，页面最终正常展开。现兼容列表在解析taskId前物化所有可见记录，是需优先验证的窄改进方向；不通过扩大超时/放松来源校验解决，也不将此称千级容量通过。之后继续旧Trigger运行/录制/优化点/AI起草，再按phase7推进采集/控制域及96模型语义迁移。万级Span与容量机制继续第二版。


## 2026-11-16 原 Trace 准确定位读取修复

原Trace详情用taskId/executionId定位时，兼容接口此前先物化所有可见Trace再过滤。现在先按实时IAM解析原别名/内部ID，按taskId、executionId、taskIds原交集读取所选Trace；复用原Record投影、源字节预算、Outcome选择及授权/删除/来源前后复核。保留route.created_at_ms和bucket校验；缺事实、缺失/foreign选择、0/null、排序/统计/分页均与原结果一致。tags/skills/values全局facet继续原范围，未知facet继续正常过滤。普通列表未优化，不改UI、表结构、parser、purpose或15秒超时。

| 验证 | 结果与边界 |
|---|---|
| 完整应用 | 6020项，5998通过、22跳过、0失败/取消，777.90秒；Node24、原完整glob/collector预检、并行4、独立HOME/SQLite |
| 完整后端 | 1112项，933通过、179可选引擎缺配置跳过、0失败，813.47秒；ResourceWarning作为错误，155个来源文件稳定 |
| PG / 原生OG | 各18/18、无跳过，404.94/340.95秒；各18个自建schema回查残留0，159个来源文件及当前源一致。Facts为MemoryFacts，不称完整CH组合矩阵 |
| RED/GREEN及审查 | 写者151项通过；Spec独立18项及588组新旧DTO/统计/分页/facet组合全部一致；Quality17项含201ID两批对照、第二批撤权拒绝部分结果与privateJudge访问，全部通过。3078个冻结来源和6个overlay与当前相同 |
| 真实原HTTP/CH | 同一原生Trace与旧冻结代码读真实CH的DTO逐字段相同；原Next连续0.311/0.212/0.166秒，四个并发同ID0.606–0.660秒均200。此前原HTTP空闲3.998秒，旧冻结直接读2.843秒；匿名401、伪user不扩权、missing返回空。不同边界分别记录，不把该少量样本当千级容量验证 |
| 原界面/数据 | 原Trace首次打开即正常展开1Agent/2LLM/1工具，当前console错误/警告0，截图original-trace-green.png。只刷新原隔离helper并保持Python解释器与Next服务不变，先备份两库；65core/96旧表原记录保留，15CH在刷新后读验期间逻辑内容相同，旧100分实验、0分Workbench、诊断done/report及4身份仍可读。旧负面Outbox只正常推进重试元数据；默认库/生产未操作 |

证据：`exclude/storage-core-trace-lookup/20261116-9l5_pk9r/` 的`final-code-verification.json`、`candidate-v1-result.json`、`candidate-v1-final-python-report.json`、`candidate-v1-native/`、`lookup-spec-*`、`lookup-quality-*`、`old-frozen-real-dto.json`、`main-http-report.json`、`main-data-preservation.json`及`main-browser-report.json`。没有启动额外Agent/外部模型，没有修改或重导旧Trace事实。

本片仅恢复准确定位的正常读取，不解决一般列表的完整物化、N+1选择读取及第二版容量目标；后续按已审计的原Trigger、可信公共采集和Infra必要存储缺口继续推进，完整旧库/旧spool迁移及生产切换仍未完成。


## 2026-11-17 第一版 Trigger 评测完整接入

原 Trigger 的 run/runs/cancel、真实采样 Trace、聚合优化点/自动及手工解决、AI 起草的独立版本与占位 CAS 已接入新动态存储。保留原 live 路由算法、原 direct LLM 提示词/宽松解析、最新 Skill 起草与固定评测版本0、原模型选择及环境兜底；RunPlan封存数据集、Skill历史/竞争配置和模型连接，恢复不重选来源。Set DELETE 按原行为只删除 Set，保留完成及在飞 Run/Evaluation/Issue；仅准确终止已丢占位的 draft，迟到结果不复活。原 API/DTO 与277个TSX/CSS不变，schema仍015、65事务表+15CH，无新增parser/purpose。

最终复核修复两项实际跨链路问题：原首次 reload 将 runs 的409误读为空且停止轮询，现在仅准确 TRIGGER_READ_CHANGED 的 GET 在原15秒预算内有限重读，其他错误沿原catch保留状态；Python canonical JSON 的键序变化导致 ready 确认误冲突，现在对原静态 itemsJson 做结构等价比较，仍拒绝值、数组顺序、空白及扩展字段的真实编辑，原SQL CAS不变。

| 验证 | 最终结果与边界 |
|---|---|
| 完整应用 | 最终V3：6078项，6056通过、22跳过、0失败/取消，267.39秒；Node24、原完整glob与collector预检、并行4、独立HOME/SQLite，3102个来源文件与最终源一致 |
| 完整后端 | 1141项，962通过、179可选引擎跳过、0失败，494.37秒；ResourceWarning作为error，160个来源文件稳定 |
| PG / 原生openGauss | 各27/27、无跳过；307.263/266.217秒，各27个自有schema回查残留0，164个来源文件稳定。事实sink为MemoryFacts，不称完整三库×CH矩阵 |
| 真实原HTTP/CH/OpenCode | 104次原请求，8次本地provider调用（5次原生OpenCode、3次direct draft），4个原生Session与2个direct Trace均indexed；三条业务Run覆盖0分、干净自动解决、100%但竞争低级问题及手工解决。原聚合文本/提示词精确对照，丢ACK同Run不重启，ready真实提交后丢ACK可恢复，失败/删除占位不复活，旧动态Trigger写入0。没有外部LLM效果验收 |
| 原界面 | 原Next58488实际手编数据集0分→AI新建v2（旧v1保留）→v0 Skill复测100分，两个Run历史可读，应用console error/warn为0。AI按钮调用期间IAB控制曾超时，关闭自有页重开后实际ready v2与provider draft回执均存在；没有声称原生确认弹窗控制已验证。页面及布局未改 |
| 独立审查 | A–E均完成Spec→Quality；最终E3 Spec58项及真实Python→Prisma八种编辑拒绝，Quality60项（含实际SQLite并发CAS）及3项后端迟到/删除/不可变专项通过；来源指纹一致 |
| 数据保留 | 刷新前2份SQLite备份及integrity ok；65core/96旧表原行、15CH原事实摘要子集保留，仅既有负例Outbox重试元数据正常推进。隔离admin模型列表明确追加一个本地验收配置，旧模型配置/active选择及密钥不变；新增隔离Skill、两版Set、两Run与录制事实。原实验100分、Workbench0分、诊断done/report及4身份再次读回。默认数据/生产未操作 |

全量初轮失败保留并已定位环境原因：OS维护/闲置睡眠与四项超时/一取消时间重叠，保持同源与原超时的醒着专项119项零失败；随后四项PowerShell异常来自旧便携运行时Modules目录为空。同一官方7.7.0运行时在隔离证据目录恢复后，旧新二进制SHA相同、236个模块文件，35项专项和最终完整6078项通过。共享损坏运行时未修改，无依赖版本、测试超时或系统电源配置变更；仅测试进程临时防睡眠。原失败日志与运行时hash分别保留，不将首次运行称通过。

证据：`exclude/storage-core-trigger/20261116-lrv_m9yj/` 的 `final-code-verification.json`、`final-v3-restored-result.json`、`final-v3-python-report.json`、`final-v3-native/`、`acceptance-final-v3/native-http-final-v3/report.json`、`spec-e-v3-report.json`、`quality-e-v3-report.json`、`main-data-preservation.json`、`main-regression-readback.json`、`main-trigger-final-http-readback.json`和 `main-original-trigger-{zero,pass}.png`。原隔离验收页为 http://localhost:58488/skill-eval/trigger/storage-trigger-20261117-31b888?version=0 ，沿用原admin账号；本地模型服务保留供验收。

下一片：先落地可信公共source/快照及completion的持久回执，再接原upload、proxy、logs/consumer；Infra需要原功能必要控制/采样模型，之后继续其他控制域及96模型旧数据语义导入。旧Trigger历史也仍在显式迁移清单；本片完成不代表全产品接管、千级容量或生产切换。


## 2026-11-17 可信公共采集身份与写权限预检

完成公共采集前置身份范围：实际API凭据、真实设备注册主体和私有旧用户名映射分别核验；双有效凭据必须同principal/workspace，坏一份时按原规则接受另一份，失效设备不绑定clientId；当前权限不足403不借另一凭据扩权，映射缺失/歧义/目标不可核验均拒绝。`/v1/compat/collector-source`首片只接受scope，不持久化数据；实际IAM API capability与workspace角色均检查write，不能把auth/me成员角色当写授权。品牌范围不能复制伪造，token不进入身份JSON，重核设备/映射/权限，私有后续RPC沿固定origin传输并在实际请求前后拒绝实例变化。

| 验证 | 结果与边界 |
|---|---|
| 应用完整 | 6097项：6075通过、22跳过、0失败/取消，341.09秒；原完整glob/collector预检、Node24、独立HOME/SQLite，3105个来源与当前代码一致 |
| 后端完整 | 1146项：967通过、179可选引擎跳过、0失败，336.21秒，ResourceWarning作为error，161个来源文件稳定 |
| PG / 原生openGauss | 真实新HTTP各5/5、无跳过，19.975/20.211秒；各5个自有schema清理后残留0，165个来源文件稳定。无CH调用，不能称新采集事实闭环 |
| 原生身份链 | 实际Node helper、真实sidecar、实际Prisma注册/撤销设备及旧User映射，21次HTTP请求通过，无网络stub；只读Key即使personal角色仍403，双主体/空间冲突拒绝、两种坏一份回退正常、撤销后重核401。预检前后65表完整行哈希不变；明确撤销只在本片新建夹具内 |
| 独立复核 | Spec独立29Node/5HTTP通过；Quality额外9Node/3HTTP通过，含真实重定向第二origin收到0请求、检查间角色降viewer返回403、复制/Proxy品牌、设备owner变化与错误ACK。7个交付文件复核前后hash一致，随后仅修正ZH/EN历史Trigger标题 |
| 兼容与数据 | 原upload/completion/proxy/logs公共handler、schema及277个TSX/CSS未变；未刷新原58488验收环境，不改已验收Trigger或默认业务库/生产。无新增用户界面，本片不另称浏览器采集验收 |

证据：`exclude/storage-core-collector/20261117-i_wpbhkw/` 的 `final-code-verification.json`、`candidate-v1-{result,python-report}.json`、`candidate-v1-native/`、`identity-real-http/report.json`、`identity-real-http/preflight-no-mutation.json`、`spec-identity-v1-report.json`和`quality-identity-v1-report.json`。初次原生PG启动因之前/tmp测试连接配置缺失而失败；从同一个已核验loopback PG15测试容器私下恢复配置，未改服务或重置数据，失败日志保留，后续各5项实测通过。初始临时bundle模块路径与stdin退出均为验收harness修正，不影响产品源或全量门禁。

快照接收、completion、原upload/proxy/日志indexed确认尚未启用；下一片继续source幂等回执、completion先到及原快照合并/缩小语义。身份预检不是最终持久接收证明，实际接收事务仍需当前IAM复核；不切生产、不处理无映射旧spool，不将本片当公共采集全功能完成。


## 2026-11-17 公共 Source 快照与完成意图的私有存储基础

A完成：公共source专属账本、原输入/静态前态工件、CAS快照/丢ACK回放、completion先到、固定bucket、稳定实体/缩小墓碑与全部indexed屏障。新增私有collector-source/v1证明及collector-source-plan/v1编码，复用65事务表/15CH和现有worker，无DDL。公共upload/completion/proxy/logs未激活，277个TSX/CSS未改；缺interactions后completion创建空Session、子Agent/线程、原异步分析及原公共DTO/ACK留待B/C，不能称采集全链完成。

| 验证 | 结果与边界 |
|---|---|
| 完整应用 | 最终v2：6098项，6076通过、22跳过、0失败/取消，613.68秒；原glob/collector类型预检、Node24、独立HOME/SQLite，3108个代码来源与最终源一致 |
| 完整后端 | 1192项，1013通过、179可选引擎跳过、0失败，659.10秒；ResourceWarning为error，163个来源稳定 |
| PG / 原生openGauss | 各43/43，370.256/341.378秒，各43个自有schema清理后残留0；167个来源稳定。MemoryFacts专项，不称完整三库×CH矩阵 |
| 原语义基线 | 原冻结Next handler+实际Prisma九组golden，覆盖Pi缩小、OpenCode单调合并/query保护、完成先到/跨日、nullable framework、缺interactions与后续空Session；出网fetch为0，保留供B/C逐字段对照 |
| 真实私有HTTP/CH | 48请求、0模型调用：五组原portable完整快照逐字段相同、旧commit ACK不回退新快照、300消息两包仅一包indexed时503、同属/只读/签名边界通过。私有Session有额外规范化Span字段，原公共DTO/UI等价不在A声明范围 |
| v2缺摘要故障与保留 | 另16次真实HTTP读已有v1数据；真实CH响应层暂时隐藏摘要行时summary/list/filtered list返回503，合法CH筛选仍为空，恢复后正常四条Source。未删除物理数据；65事务表及15CH表逻辑哈希前后一致，integrity ok |
| 独立审查 | v1 Quality发现已indexed但缺摘要被当空结果的P1；v2增加有界存在性查询，Spec独立46+2、Quality46+8及3Node全部通过。来源/别名/桶/修订校验与读后权限复核保留 |

证据位于 `exclude/storage-core-collector/20261117-i_wpbhkw/`：`source-a-v2-final-code-verification.json`、`source-a-v2-final-{result,python-report}.json`、`source-a-v2-final-native/`、`spec-source-a-v2-report.json`、`quality-source-a-v2-report.json`、`original-upload-golden-v3/report.json`、`source-a-real-http-v2/report.json`及`source-a-v2-readback/report.json`。首次真实harness错误将私有投影当公共DTO，随后UInt64字符串比较错误，均保留原失败日志并以新独立夹具验证，未覆盖失败证据。自有两套临时HTTP进程在pending清零后停止，数据保留；原58488验收环境及模型服务未刷新，默认数据库/spool/生产未操作。

后续按B原准备算法与静态选择、C原upload/completion/子Agent线程及异步分析和indexed ACK继续；再接proxy/logs/consumer、Infra必要模型和其他控制域，最后显式映射旧96模型/旧spool。当前仍非全产品迁移完成，未切生产，也未做第二版容量验收。


## 2026-11-17 原采集共享准备与可信静态捕获

B完成共享准备基础：原upload quick/save共同复用消息合并、query/label/版本、OpenCode/Langfuse、Session默认时间、子Agent切片、Thread自然键和命名hook计算。core准备绑定实际actor、source operation/revision、原输入hash/前态/封存时间，仅捕获相关Skill必要版本及匹配静态元数据；模型只保存非秘密摘要。没有启用公共core upload/completion，不把内存capture或Thread计划称为已持久接入；原UI、schema及侧车不变。

| 验证 | 结果与边界 |
|---|---|
| 完整应用 | 最终v3：6140项，6118通过、22跳过、0失败/取消，354.27秒；Node24、原glob/collector预检、并行4、独立HOME/SQLite。仅对两个旧runtime测试旁路记录loopback响应/子进程状态，不改产品或测试超时；3111个代码来源与当前相同 |
| 实际原行为对照 | 冻结旧原代码与当前v3各自真实Prisma/原HTTP handler：18组、20写请求、外网/模型0，原Session/portable/children/Thread/非空配置逐字段相同。22个生成ID按自然身份映射；63个明确系统默认时钟须在各自真实运行窗口，显式时间/0/null/正文/扩展精确 |
| 规格与质量 | v3 Spec独立64/64、5套实际反例及v2九组SQLite/一组headless回归；Quality独立71/71及四组真实反例复演全部通过。8交付文件哈希前后一致，277个TSX/CSS未改 |
| 类型/lint | 全项目tsc通过。scoped eslint显式关闭遗留no-explicit-any后0error/2既有warning；原raw lint错误日志保留，不称全仓lint clean |
| 后端/数据 | 163个后端来源、原Prisma与DDL均与A相同，保留A的1192后端/PG43/OG43证据，非B新跑。所有真实写入仅本片新建SQLite夹具；原58488/helper与模型服务未刷新，默认库/spool/生产未操作 |

Spec v1发现并修复falsy timestamp拒存、metadata-only新增解析坏旧Session、headless再次完成重置首次时钟；Quality v2进一步发现并修复旧坏graph无关解析、显式null/empty框架误允许缩小丢消息及缺省框架相反行为、底层adapter实际全库正文读取、切换Thread错误套旧ID。新增实际存储/可信品牌捕获、JS大小写语义、原shrink/Thread时序矩阵，保持旧坏字节及现有记录。首次比较器漏列系统默认clock的失败报告保留，随后只补精确clock路径并检查实际运行时间窗，未放宽显式值检查。

v1完整测试因已知Spec回归主动停止，取消项不当功能结论；停止前xiaoo两秒fixture曾返回timeout，原同源/原超时专项8/8。v2完整6115项仅旧opencode-core-capture重启夹具失败，未改A与v2的带诊断并行专项各2/2；最终v3完整6140项零失败。历史两项原因尚未证明，保留失败及旁路诊断，不称已定位或通过调大超时修复。

证据：`exclude/storage-core-collector/20261117-i_wpbhkw/` 的 `source-b-v3-final-code-verification.json`、`source-b-v3-final-result.json`、`source-b-v3-backend-fingerprint-reuse.json`、`source-b-v3-legacy-golden/{report,legacy-equivalence}.json`、`spec-source-b-v3-report.json`、`quality-source-b-v3-report.json`、`source-B-v3/`和`source-b-v3-full-runtime.jsonl`；旧失败/反例与v1/v2完整输出分别保留。

下一片C：首次capture/完整计划持久CAS、可信typed flow前态、空Session/Thread控制与child图持久化、原Node Session投影、公共upload/completion全部indexed ACK，以及原异步分析/Flow/Outcome及内部采集身份闭环。pure skipped并不等公共handler停止分析，需按原route完整对照；仍未完成public采集整体、proxy/logs/consumer、Infra/其他控制域或完整96模型历史语义导入，未切生产。


## 2026-11-17 私有采集准备持久化与旧未完成请求恢复

C1a完成016单表 `collector_preparation_receipts`，现为66事务表+15CH。首次原Node JSON表示、封存前态/捕获及纯准备计划只追加封存；begin与A预留在同一事务内，commit只应用已封存计划，accepted/indexed仍以A和实际worker为准。保留旧A回执/工件，无法恢复的旧键序明确标为legacy_canonical；当前已应用source revision才允许复用原Session字符串。完成先到保存真实空Session及首次时间，不生成虚假事实；已有Execution缺Session时补齐原空会话，后到快照保持首次时钟。当前手工标注不被旧采集输入清除。

独立Quality发现并修复一个P1：旧A尚reserved的请求接入C1a后，旧commit/complete可绕过首次封存计划。现在所有仍reserved的接管及已有receipt恢复均在同事务内补齐守卫，旧入口拒绝绕过；已经committed的旧历史及ACK不改。两条反例在冻结v1实际复现，在v2实际返回409且封存正文/空Session真正保存。

| 验证 | 结果与边界 |
|---|---|
| 应用完整与类型 | v1完整6141项：6119通过、22跳过、0失败/取消，696.58秒。最终v2的3119代码文件仅2个Python文件变化，全部Node/TS/DDL/JSON逐文件相同，复用该完整应用门禁，另做v2实际Node私有HTTP/CH；不称v2重新完整执行。tsc首轮180秒无输出超时，保留记录；同源降低并行后33.39秒exit0，未改测试超时或产品。原因未单独证明 |
| 最终后端完整 | v2：1213项，1034通过、179可选引擎跳过、0失败，364.59秒；ResourceWarning为error，169个来源稳定。v1因已确认P1主动停止，旧日志不是通过证明 |
| PG / 原生openGauss | 最终各62/62、无跳过；250.724/265.644秒，各62个自有schema回查残留0，173个来源稳定。事实sink为MemoryFacts，不称三库×CH完整矩阵 |
| 真实升级与CH | 独立015副本先保留两条未完成A请求，再备份升016；实际Node、sidecar和CH共193次HTTP、外部/模型调用0。封存后重启恢复首次字符串/捕获，300消息多包半索引503，全索引后完整读回；旧ACK不重复写，旧两条绕过409，空completion后上报保留首次时间 |
| 独立复审 | Spec32项、Quality27项通过；包括first seal、resume_pending、已有receipt缺守卫恢复、事务失败回滚、committed旧ACK/annotation不变；16交付文件hash一致 |
| 数据与界面 | 原65事务表/15CH原行及357工件保留，隔离旧静态库96表43行未改；所有277个TSX/CSS与Trigger验收时相同。未刷新58488原验收服务，默认库/spool及生产未操作，无新浏览器验收声明 |

证据：`exclude/storage-core-collector/20261117-i_wpbhkw/` 的 `source-c1a-v2-final-code-verification.json`、`source-c1a-v2-node-fingerprint-reuse.json`、`source-c1a-v2-final-python-report.json`、`source-c1a-v2-native/`、`source-c1a-v2-upgrade-fixture/real-node-ch-v2-report.json`、`after-upgrade-preservation.json`及 `spec/quality-source-c1a-v2-report.json`。

公共upload/completion/proxy/logs仍未接线，public_ready恒false；非空子Agent/Thread/退休计划在root副作用前返回pending，ThreadOnly只有不造Trace的准备回执，实际图写入/原DTO/原异步分析留待C1b/C2/C3。继续第一版原功能等价，不增加万级Span或容量增强；随后仍需Infra、其他控制域及完整旧库语义迁移，不代表全产品接管。


## 2026-11-17 子Agent与Thread接线：开发检查点，待集中验收

C1b逻辑实现017三张Thread head/event/member控制表（代码目标69事务表+15CH），复用A账本及batch vector做整图原子提交/indexed屏障；ThreadOnly不造Trace，子Agent独立Session字符串/未写评分字段及缺时钟时原开始时间保留，派生退休保留Session/aliases/工件。首次capture同事务预留实际图成员，普通child不能把父graph派生pending误接管为普通upload。Skill/origin复用原纯处理并保存在source精确投影。

按最新执行节奏，只做开发快检：后端130项（102通过/28可选环境跳过），随后最终Graph10项通过（与前130有重叠，不相加）；根再次独立执行Graph10项、2.284秒通过。Node采集47项和直接相关旧Skill53项通过，最终tsc及diff-check为0，21交付文件hash一致，原TSX/CSS未改。证据在同collector目录source-c1b-development-checkpoint.json及/tmp/collector-c1b-handoff.json所列日志。**未对本片做完整应用/后端、真实PG/openGauss/CH、016→017演练、浏览器或独立Spec/Quality验收；这些统一留到剩余接入逻辑完成后。**

公共入口仍未激活；C2/C3继续补read-capability的原Session/Thread/精确Skill来源读取、原Node DTO流水线、upload/completion/分析/hooks及proxy/logs消费者。公开pending:Codex必须在begin前拦截；root seal后commit前删除的派生成员协调需在公共接线时补齐。016已sealed但缺graph_context的旧私有图保持明确pending，不重封首输入；独立来源alias不隐式认领。当前为开发检查点，不作为全功能完成或生产切库依据。


## 2026-11-17 公共采集整域：逻辑完成，待合并依赖及集中验收

按连续编码节奏接完原Session Node四视图读取、headless/退休Session、Thread/关系、upload/complete、原分析与proxy end、持久模型意图/回执、源版本/手改/删除fence、proxy生命周期/CAS追加、logs/traces/Claude context可信packet journal、原多框架聚合与Jiuwen缝合/孤儿退休、OpenClaw/内部SkillGenerator旁路。公共OTLP恢复原解析/聚合后进入同collector canonical-by-task，专门native core端点保持独立，不隐式认领别的native源；只有全部对应graph向量indexed才确认新消费游标。旧无证明spool/cursor保留，core不再盲启旧consumer/uploader。无新增表，代码仍017。

开发快检：准备golden+公共链路45项通过、最终公共HTTP/Session/auth3项通过（存在重叠，不累加）；后端新专项8项通过；根另跑整个public模块21项、4.294秒通过（包含导入Graph及继承重复，不等同21个新增用例）；tsc/py_compile/diff-check通过，59文件hash一致，原TSX/CSS未改。原验收58488与默认/生产数据未刷新。证据为同collector目录collector-public-development-checkpoint.json及/tmp/collector-public-domain-handoff.json列明日志。完整Node/后端/三库/CH/原UI/真客户端/迁移演练及独立审查仍集中后置。

L6静态UserSettings/Skill/Config/设备凭据/会话由独立019分支合并，collector-preparation与真实owner后台模型执行边界已对齐；L7 GoalPlus/协作元数据及其旧Execution FK仍待相应域迁移，Trace端已换新源，不造旧Execution占位，失败hook保持pending。独立native alias冲突仍明确拒绝；真实双native/snapshot客户端待统一验证。这是接线开发检查点，不称全部原功能已验收。

Infra也已在独立分支2800da7d完成整域逻辑（018两控制表+CH003，一共71事务表/16CH），源CRUD、push/pull、history/export/diagnose、Trace自动/人工关联、旧analytics v1 endpoint窄补读均接线；Node快速128项、后端8项和相邻50项通过，根模块51项通过（含43旧Source+8Infra），tsc通过。已集成为9b8d9b3d，待与其余域一起完整验收；未对018真实CH/native/升级/浏览器作通过声明。精确证据同目录infra-development-checkpoint.json及/tmp/storage-infra-implementation-handoff.json。


## 2026-11-17 RAS/FI整域逻辑汇总，统一验收待完成

主树fc5206ef汇总RAS DELETE、Session-only/RAS-only删除屏障、FI任务/运行/worker控制、claim/stop/collect与Experiment发布校验，复用019固定控制记录及既有RAS事实，未新增表。原客户端首次lease缺claimToken仍可完成；真正reclaim后的旧无证明结果明确拒绝。提取Trace删除事务时保留collector派生成员取消，删除不复活迟到source。019正式控制实现仍待下一批集成，不以当前静态合并称完整功能可用。

开发快检为隔离Python10项（FI6、RAS4）、原handler loopback HTTP1项、tsc/py_compile/diff-check通过；无真实worker故障执行或模型调用。精确43文件与7借入文件hash、共享接缝及未验收清单见`/tmp/storage-ras-fi-adapter-handoff.json`。本批不重复完整测试/三库/真实CH/原界面/迁移演练，统一留待L6、L7及语义转换逻辑全部完成后；默认库/spool和原58488验收服务未切换。


## 2026-11-17 019静态控制域汇总与迁移运行保护（开发检查点）

39f59b08汇总152个交付文件，019一张固定领域表使目标为72事务表+16CH，40原领域kind/488字段；元数据轻量查询、版本/私有文件、真实request上下文、客户端安装/设备凭据/改绑/命令、工作台会话/消息/VFS/任务/候选和新用户示例均接原流程。4个TSX仅批准的请求封装及runtime动态header变化，原JSX/CSS/文案/布局保持。writer快检Python13项、Node9项及tsc通过；root集成后tsc通过。证据交接/tmp/storage-control-implementation-handoff.json，不能把此开发检查点称完整原功能已验收。

运行保护复用legacy-inert-control/v1回执，不改历史status/时间：普通read保留，执行选择排除历史Task、设备/install不鉴权、Infra选取和真正scrape前复核、FI不领取、Experiment/Benchmark不启动/claim/callback。旧username已绑定实际IAM时，bootstrap先沿唯一旧User记录返回其当前有效API凭据，不重建principal或权限。新任务允许新ID；Agent删除复用同事务TraceMetadata._delete，保留collector图预留取消。Python7项与Node同actor上下文2项快速通过，初次Node新增用例缺隔离URL的失败日志保留并修正fixture。诊断/report保护与完整历史转换仍在接，history fence version仍0；集中完整套件、原生三库、真实CH、原UI、迁移演练均尚待。日志见exclude/storage-core-collector/20261117-i_wpbhkw/integrated-control-history-development/。


## 2026-11-17 GoalPlus、协作与Usage整域汇总（开发检查点）

主树250d8aca汇总55文件，020新增5事务表、CH004新增3事实表，总计77事务表/19CH。原Goal快照/Run/候选/迭代/完整性与精确Trace关联、两层协作report/bind/graph/Trace投影、真实actor携带的Usage队列/去重/日报/管理员统计均接线，未增加TSX/CSS变化。writer开发快检Python6项、Node2项通过，后者包含原handler→loopback Python→隔离SQLite+MemoryFacts以及部分owner失败只重试未完成项；最终tsc实际exit0。实例使用已indexed Trace关联，旧Goal/协作/Usage表0行，core关闭后legacy分支也验证；不是原生数据库/真实CH/UI验收。精确handoff与未验收边界在同collector目录semantic-usage-development-checkpoint.json。

功能接入已汇总，剩余历史转换和diagnosis/report/generation运行保护仍在各自工作区连续实施；它们全部冻结后统一执行完整/三库/CH/原界面和迁移演练。旧数据/原58488服务保持，不切生产，第二版容量不实施。


## 2026-11-18 集中验证与原界面验收

功能逻辑汇总后集中修正实际请求授权上下文、FI owner范围、未登录配置探测、取消receipt归属和历史运行保护。旧历史状态保持原值，运行marker阻止Experiment取消生成命令、历史Infra采样落盘以及旧任务/设备重新执行。HISTORY_FENCE_VERSION已显式启用1，允许通过计划校验的离线导入；未知owner、缺附件、来源漂移、目标碰撞仍阻断，full_migration_ready及production_cutover_ready继续为false。

| 验证 | 实际结果与边界 |
|---|---|
| 后端完整套件 | 冻结8511aba9：1421项，1242通过、179可选引擎跳过、0失败，1347.83秒，来源218文件未变；随后历史导入/运行保护49项及无名Agent3项通过，后两批是变更专项，不能相加冒充最新完整套件 |
| Node完整套件 | 最终冻结af2854b8：6167项，6145通过、22跳过、0失败/取消，1067.53秒。前轮CLI15秒夹具启动超时已通过测试环境关闭npm通知/出网修复；另一次唯一失败为history版本断言仍要求0，更新为实际默认1后原保护流程专项通过，随后本轮完整重跑通过。原失败日志保留 |
| 最终小修与类型 | af2854b8完整套件后，匿名Agent汇总、旧settings别名、Infra鉴权与下载小修以当前c9853cb1的32项Python、12项Node集成专项、完整tsc（exit0，27.96秒）及真实原UI验收；这些是变更专项，不冒称该新来源重新跑过完整Node/Python |
| 原生关系库 | PG15与原生openGauss7各113/113、0失败/错误/跳过；每库113个自有schema清理后残留0，另有4个SQLite专用排除项。来源caa0a53a，Facts使用MemoryFacts；后续HTTP及历史保护有单独专项，不能称最终三库×CH全矩阵 |
| 新接领域真实CH | 原Node处理器/DTO、真实CH004：GoalPlus、协作、Usage、Infra、RAS五域读写及owner/只读/幂等检查5/5；是隔离人工输入，无外部执行或物理抓取效果声明 |
| 保留式升级 | 独立016副本备份后升020及CH003/004，原66张事务表全部行多集、15张CH逻辑表及711份工件内容保留，源未修改 |
| 旧库语义迁移 | 先46条样本，后在独立副本增加1条合法running BatchEvalTask：实际export/plan/apply/verify CLI校验47条、重复apply重放47条，源字节/内容未变；HISTORY_FENCE_VERSION为实际默认1。原running字段可读、execute筛选不选旧任务，work_items/attempts/runs/运行命令/执行outbox均0；12条自有存储outbox正常indexed。96表schema仅13表有样本，不代表全部客户内容/外部assetPath已验收 |
| 原界面真实闭环 | 原standalone登录admin→原upload别名→列表/详情→Span完整输入输出→原导出按钮，筛选无匹配0/重置1；原Dataset两张内置卡、Evaluator页面和Dashboard实际读回。原opaque扩展及framework保留，旧Prisma User/Execution/Session/Dataset/Skill对应表仍0。没有将其他全部页面按钮或真实LLM/SSE/物理设备宣称为本批重跑 |
| 最终无名Agent修复 | 真实旧handler+SQLite对照确认generic未给agentName时原DTO省略agent/agentName。新适配只去掉该命名空间的collector缺省，显式collector/unknown和native OTLP不改；旧prepared/receipt原内容不变，新快照正常递增，旧receipt不回退。新真实CH任务经原upload/list/session及原Span面板通过，旧验收行未自动重写 |
| 前端保持 | 对789e8d04的277份TSX/CSS：263份字节相同，14份仅请求鉴权/CAS/runtime header/下载接线。独立与根AST复验14文件共162个顶层JSX根原文字节完全相同，CSS变更0；保留原展示文案、结构和布局。先前4份/8份为对应历史片段口径 |

原界面地址：http://localhost:62632/trace?taskId=storage-acceptance-final-20261118 ，原登录输入admin。运行产品代码已刷新至c9853cb1。运行环境位于独立acceptance-v2，使用专用SQLite、CH数据库、HOME和依赖副本；服务通过原scripts/develop_start.sh启动，runtime配置只调整隔离distDir及Turbopack根/缓存。原58488验收服务、默认业务数据库/spool、生产均未切换，未推送远端。

异步分析切换revision的真实过程中观察到短暂409/503，原自动刷新在indexed稳定后恢复，最终原详情和完整正文可读；这段日志保留，不能声称全程无错误。原界面没有为本次后端重构调整展示。当前验收入口保留的是最终新任务，旧synthetic任务及其旧captured语义仍保留。

证据目录仍为exclude/storage-core-collector/20261117-i_wpbhkw/：consolidated-v4-result.json、consolidated-v3-python-report.json、consolidated-v1-native/、consolidated-v4-domain-smoke-20261118-3ee65686/report.json、consolidated-v2-upgrade-semantic-rehearsal-20261118/report.json、consolidated-final-history-cli-20261118-45e72e56/report.json、consolidated-acceptance-checklist.json及acceptance-v2/{browser-acceptance-report,final-anonymous-http-evidence}.json、final-trace-detail.jpg。首次失败、超时及初次未索引迁移的Conflict日志全部保留。最终完整应用结果为consolidated-final-v4-result.json，当前变更专项为final-transport-delta-regression.json，完整类型结果为consolidated-final-types-result.json，真实当前入口截图为acceptance-v2/final-trace-after-transport.jpg。

尚未验收/不纳入本版完成声明：客户真实全库owner/附件/spool映射及正式停写迁移；所有原界面流程逐按钮的真实外部模型/设备/物理故障场景；当前小修后未再次重跑同来源完整Node/Python（已有变更专项、完整types和原UI证据）；第二版千级采集端容量和万Span优化。异步分析切版本时短暂409/503仍是已记录限制。已实现的旧模式分支继续保留，不能把legacy代码存在直接算为未接管消费者，也不能因新模式通过就擅自切生产。


### 当前原界面补查与下载复验

补充原Agent、Skill工作台、实验、Infra与诊断页只读检查时，真实HTTP揭示Infra空状态掩盖401、旧/api/settings别名不附Key、直接ZIP/Infra下载不经header及无名Agent summary索引缺省字段引起400。现21处Infra请求统一复用apiFetch，三个Skill下载入口和Infra导出经受鉴权Blob；当前actor来自header，user只保留兼容标签，凭据不进URL。原SSE/Abort/FormData和导出query保持；浏览器先缓存完整下载Blob，不声称仍直接流式落盘。

修复后实际浏览器Infra请求200，summary agents与settings别名HTTP200；原Skill管理“下载zip”按钮真实下载linux-messages-auth-triage-demo-v0.zip，13份文件逐字与原内置bundle一致。原Agent、工作台、实验、Infra和诊断只读页均可打开，后者显示2条Trace/0异常。无真实外部模型调用或物理设备。初次401/400日志及截图继续保留，不能将当时空页面记为成功读取。

证据补充：acceptance-v2/{final-transport-http-evidence,original-ui-skill-download-evidence,final-transport-refresh-evidence}.json、original-ui-skill-download.zip、final-skill-download.jpg、final-infra-authenticated-page.jpg；consolidated-final-ui-transport-review.json为独立静态审查，consolidated-final-ui-root-recheck.json为根独立复验。当前完整字段/schema版本没有再变化，用户AGENTS.md原哈希保持。

## 2026-11-18 分析更新读取一致性修复（最终回归进行中）

本片针对上轮实际观察到的分析更新短暂409/503。保持后端完整快照与身份校验，通过私有TRACE_INDEXING/TRACE_READ_CHANGED识别可重新读取的索引等待与同身份版本变化；Node重新执行完整授权读取，固定origin/actor并响应取消。只重试GET，模型开始后及写入不重放；来源改绑、删除、权限撤销、事实缺失/损坏继续失败。Session缓存绑定来源身份/source/annotation版本，RAS新私有签名token区分版本变化与身份变化，旧token不放宽。最多32次，15秒为等待与新尝试启动窗口，单次I/O超时不改。

当前专项：Python81/81；原四个handler→实际Python索引等待→真实ClickHouse更新后均200，正文/标签为新值。独立审查的model preflight吞错、origin/取消后继续RPC及等待耗尽仍发请求三个P2已修复并复验。尚不把这些专项称最终全量结果；后续以冻结来源完整Node/Python结果及原界面复查为准。新证据独立保存在exclude/storage-core-read-transition/20261118-z7j6zhaw/，不覆盖上轮失败和通过日志。未改TSX/CSS/schema，未刷新旧58488环境或切生产。
