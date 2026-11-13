# 存储核心、IAM、default项目与三库适配实施状态

日期：2026-11-13。已完成001–007基础、原界面Trace兼容、诊断自身Trace/会话/SSE与Trace报告接管。全量应用测试已恢复零失败，实际OpenCode及文件工具在隔离环境验证；详细范围与最新证据见文末。全产品数据迁移仍未完成，不能作为生产切库或完整验收。总体目标见phase1/phase2，当前兼容批次见[phase6](phase6-trace-vertical-slice.md)。

## 产品验收纠偏（2026-11-12）

用户明确要求保留原有全部功能，仅变化其背后的数据支持。此前core技术样例的单Trace导航、全页替换、独立登录后落点和未接管操作501不符合此要求；本批已撤回前端替换，恢复原页面与登录。**产品验收未通过；先前“可打开验收”仅证明技术样例可运行，不能代表原产品完成切换。** 下文历史实测数字与截图继续保留，完成状态按此纠偏解释。

已核对当前源码有52个`src/app/(main)`页面文件及290个API `route.ts`文件（含本批新增auth路由）；这是物理入口数量，不是已验证功能数量或完整迁移清单。原界面已恢复；全部API/后台调用逐项映射、所有既有功能回归及产品切换仍未完成。实施顺序与首轮分组见[兼容清单](phase3-development-plan.md#修正后的实施顺序与兼容清单)。

## 基线与交付

- 工作分支`codex/storage-core-refactor`基于已同步的`upstream/master`：`298d1d5b10ab3ab67a955b41a1665b0cd4d26b54`，旧库基线96个Prisma模型。
- `001_core.sql`四套原始字节均保持不变；新增SQLite/PG/openGauss三套`002_iam.sql`、`003_projects.sql`、`004_observations.sql`、`005_trace_metadata.sql`、`006_trace_diagnosis.sql`、`007_diagnostic_reports.sql`与机器字段目录。
- 当前物理核心为 **43张事务表+13张CH表=56张**：001含21张事务表及13张CH表，002新增10张IAM表，003新增项目目录与workspace归属2张，004新增可靠采集与实体版本2张，005新增旧ID/标注/标签4张，006新增诊断会话/消息2张，007新增报告运行/当前指针2张。完整字段/类型/约束/索引见[字典](core-table-dictionary.md)。这不是原59张逻辑目录的全部实现。
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
