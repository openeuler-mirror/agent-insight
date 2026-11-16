# 剩余消费者与旧数据迁移：盘点、依赖与实施计划

日期：2026-11-15；首轮盘点基线`945af229`，最新完成情况见第4节及实施状态。用户已授权按依赖自主实施，保留全部原功能/可见界面，只用隔离环境，不切生产。当前工作副本继续使用`codex/storage-core-refactor`，不重置已有数据、不推送远端。此清单按调用链核对，不能把Prisma命中数量当作尚未迁移数量。

## 1. 已接管与剩余功能清单

Trace CRUD/标签/bundle、Dataset版本/回流/生成、实验/比较/直接轨迹评测、结果/RunPlan、诊断会话与报告、Workbench/Grayscale、Benchmark、Flow和版本比较已有typed接管。它们的legacy分支不是待迁证据；仍真实使用的旧静态配置和事务控制域也不能先删或全局拦截。

| 依赖层 | 尚未接管或未闭环功能 | 实际入口与依赖 | 验收要求 |
|---|---|---|---|
| L0 | 96模型、真实物理字段、关系、owner/凭据与未知数据迁移计划 | `services/storage/legacy.py`、`__main__.py`、`prisma/schema.prisma`；原inspect/export仅原始快照，migration-plan仅核心DDL升级 | 新工具只读、无apply；未知/孤儿/owner歧义/缺转换器不得ready，原导出不放松 |
| L1 | 优化点旧页面resolve回调 | `skills/by-name/[name]/optimization-points/resolve`仍只更新旧SkillIssue；新列表已合并typed派生Issue | 原PATCH/DTO不变；真实actor、Skill范围、当前机器selection；静态/feedback仍原域，新派生只写014注解；重复可恢复，threadId缺省保留null语义 |
| L2 | Skill运行/日志等剩余动态消费者 | `skills/[id]/runs`、`skills/logs`仍需完整运行/评测快照；Dashboard/Fleet/Task/Quality、定价observed models、Skill列表/版本、Agent列表已接通 | 复用原快照与聚合算法；保持真实结果语义，不以泛化实验分数替代answerScore，不回写历史版本 |
| L3 | final_result编辑、独立rejudge/cancel | `trace_service.py`明确409；eval/rejudge及evaluation/cancel仍旧库 | 编辑→冻结证据/配置→持久任务→lease/fence/取消→实际结果与Issue；不可仅去409；新编辑不改旧运行输入 |
| L3 | Batch与旧Trigger评测 | debug/batch-tasks缺typed context；旧trigger运行仍写SkillTriggerEvalRun/Evaluation/SkillIssue，被新聚合过滤 | 保留任务/评分/运行DTO；Dataset/Skill/Evaluator版本、进度/取消/重启与空Issue替代语义一起闭环 |
| L4 | upload/proxy/OpenCode complete、OTLP logs、旧spool重放 | logs→各framework spool→consumer→saveExecutionRecord旧Execution/Session；core下consumer仍启动 | 新接收需真实actor/来源证明及durable ack，旧积压不可仅按payload.user推断授权；原解析/合并/去重保留，确认indexed后才推进cursor |
| L4 | OTLP metrics/Infra采样与关联 | metrics/poller→旧InfraSource/InfraMetricSample；infra树与人工SessionInfraLink读旧Trace | source配置/密钥、CH时序事实与人工关系分域；新Trace root/endpoint/model/window完整，不猜目标 |
| L5 | RAS事件与FI Trace消费者 | RasAnomalyEvent及关联/删除仍旧库，FI runs/:id/trace读旧Session | 先接事件事实与稳定Trace关联/删除屏障，再迁FI控制事务；已有实验collect桥接不能误报双写 |
| L6 | 资产/配置/会话与客户端控制域 | Skill/版本/文件、Config/UserSettings、RegisteredAgent、Workbench/优化会话/计划、客户端凭据/命令/配置、FI Task/Run/Worker | 真实事务权威逐域迁移；迁移在线/busy/lease/outbox只能历史化，不能自动重启外部执行 |
| L7 | Goal Plus、协作、Usage | goal-plus/collaboration ingest/query/resolve及usage queue仍旧域 | 来源同步checkpoint、事件/快照与关系解析、计量去重；daily与event不双计 |
| L8 | 旧库完整语义导入、增量、切换/回退与容量 | 需L0登记的所有转换/身份/制品依赖，所有旧消费者逐项接管 | 显式停写/备份/最终快照/影子读/回退另行授权；本轮无生产操作，无1000采集端/HA认证 |

### 决策与取舍

先补只读迁移计划和已接领域的窄操作闭环，再接共享摘要读源，能提前发现数据归属/漏字段并恢复原页面行为。直接批量替换Prisma或让旧writer盲转新库会绕过原授权、版本与接收回执；完整新表重建所有静态域又会延迟现有页面恢复。本轮沿已批准的双存储和不可变事实架构逐域推进，不引入替代前端。

## 2. 96模型旧数据迁移清单

[旧迁移设计](legacy-migration-design.md)原96行保留；下列修正其粗分类，不将“mapped”当作已有importer。机器目录须列每模型真实物理表/列、主键/唯一键、声明关系、owner字段、敏感字段和目标域；Prisma的PlaygroundSession/PlaygroundMessage与CollaborationEvent bodyJson/bodyHash映射必须正确。

| 领域 | 模型数 | 数据处理与依赖 |
|---|---:|---|
| User/UserSettings/UserGuideState | 3 | 显式principal/workspace归属、IAM登录名归一化冲突；旧Key/密码/配置秘密隔离，不直接成为新凭据 |
| Skill/SkillVersion/Config/CustomEvaluatorList/AgentEvalDataset/RegisteredAgent/SkillTriggerEvalSet | 7 | 资产identity、cutoff观察版release、正文/文件/gold；Config是标准答案/期望行为资产，不只是普通配置 |
| Execution/Session/TraceThread/TraceThreadEvent/ExecutionSkill/ExecutionSkillOrigin/Tag/ExecutionTag | 8 | Trace/Span/正文/来源关系/当前可编辑标注；现有import仅Session/Execution允许字段，synthetic/unknown明确标记，Langfuse树尚隔离 |
| TraceEvaluation/Evaluation/SkillIssue/ParsedFlow/ExecutionMatch/SkillSnapshotEvaluation/DebugHistory/DebugJobResult/TrajectoryEvalResult/SkillTriggerEvalRun | 10 | 实际运行与机器事实/selection、人工修改/解决；可重算缓存保留真实来源和算法，不能用最新内容伪造历史 |
| 生成/优化/Workbench会话、消息、计划、候选、Task/OptimizationRecord | 11 | 当前事务状态/文件快照和历史消息/迭代分离；外部session历史不自动恢复为新运行 |
| FaultDiagnosisSession/Message、DiagnosisRun、AgentDebugReport/SkillsAnalysis | 5 | 已有新存储，不等于有旧历史导入；保留原报告、输入hash/Trace映射，不重跑模型补历史 |
| BatchEvalTask/GrayscaleTask、Experiment/Cancellation/LocalExecution/Group/Case/TraceAttempt/EvalResult/EvalComment | 10 | 专用inert历史导入；普通create/start剥历史时间/结果，不能冒充历史迁移；机器/人工/评论逐项追溯 |
| BenchmarkDataset/Case/Binding、CaseRun/Artifact/DispatchOutbox、Evaluation/Artifact/DispatchOutbox | 9 | public/private/原提交/字节制品与历史job分离；已有可信dataset_import可复用，旧未完outbox不自动重投 |
| SessionInfraLink/InfraSource/InfraMetricSample | 3 | 人工关联是OLTP权威覆盖，source配置秘密单独封存，指标入CH |
| FaultInjectionTask/Run/Worker、RasAnomalyEvent | 4 | 真实协议/目录冻结；旧心跳/busy/租约仅历史，事件入新事实域 |
| Reliability install/client/deployment/events/credential/command/config/snapshot/delivery/load | 10 | 旧凭据过期/隔离后重新签发；旧命令与投递历史不自动执行；制品storagePath不是已搬迁证明 |
| GoalPlus Source/Goal/Run/Candidate/Iteration/AgentSession/ExecutionLink/SemanticSnapshot | 8 | cutoff来源与运行快照、历史事实和解析状态，不能从当前值反推历史 |
| Collaboration/Event/EndpointResolution/SessionBinding | 4 | 事件事实、当前解析/绑定与来源精确映射 |
| PlatformUsageEvent/Daily | 2 | 原事件和汇总分开保留，禁止双计 |
| TraceDatasetGenerationJob/OperationReceipt | 2 | 旧进度/receipt转换；旧lease/checkpoint不自动成为有效租约 |
| 合计 | **96** | 除Session/Execution限定转换外，不宣称已有完整逐模型语义导入 |

迁移依赖顺序：严格只读计划/问题清单→显式身份与稳定legacy ID映射→Skill/Agent/Evaluator/Dataset/Benchmark资产及私有字节→Trace全字段/Thread/Skill origin/标注→实验/评测/诊断历史→工作台/候选/发布关联→其他控制/事实域→逐入口影子读→另行授权的停写/增量/单写切换与回退。稳定ID用source_id+物理表+源主键，不将会变化的内容hash当永久实体ID；内容摘要只绑定本次计划/receipt。

## 3. 当前实施任务与验证门禁

### T1：严格只读迁移计划（先实施）

- 新增`services/storage/legacy_plan.py`、版本化`services/storage/schema/legacy-catalog.json`及`tests/test_legacy_plan.py`；CLI增加明确的`plan-legacy`，不与DDL migration-plan混淆。
- 用已安装Prisma DMMF离线生成基线目录（96模型、物理列/关系），不得连接默认DB或升级依赖；运行时不依赖Node。目录绑定schema hash，漂移明确阻断。
- 先测RED：真实物理别名/@map、未知表/列、缺字段/类型/主键漂移、FK孤儿和关键非FK引用、owner映射缺失/冲突、IAM名称归一碰撞、敏感值不输出、源字节/WAL/mtime不变、确定性/有界诊断。GREEN后复验旧inspect/export/trace importer。
- 当前仅支持显式SQLite源（`--database`），不支持`--directory`；已验证原导出仍由现有verify-export独立处理。只读数据库诊断可收集FK违例并标blocked，原export遇违例仍拒绝。源诊断不输出行值；owner mapping需显式且不含可用凭据，默认不自动映射任何人。
- 每列区分已有有限转换、私有原始保留、未实现、需secret处理/明确省略；不存在全量transform时不得ready。普通JSON无法证明字段语义，整体视私有待转换，不猜秘密。逻辑关系覆盖声明必须有界且说明尚未覆盖项，不能靠只有FK检查宣称完整。
- 计划绑定source_id/schema/content hash/catalog版本/mapping hash与依赖图，无apply、无目标连接、无生产切换。只在合成数据验证。

### T2：旧优化点resolve回调闭环（依赖现有014）

- 修改原`optimization-points/resolve/route.ts`及`storage-core/derived-issues.ts`，必要时扩展`experiments.py`的已签名resolution动作；不改UI和014 DDL。
- 先测原PATCH当前新派生ID返回0的失败。core先建立真实actor上下文，忽略body.user；按原Skill名/owner选择静态/feedback候选，派生Issue以typed lookup及当前selection验证，禁止旧dynamic/trigger影子回退。
- 保留`{resolvedCount}`、缺省threadId公共null语义、重复请求/部分跨库失败可恢复。core事实解决和旧静态修改分别幂等提交，不宣称跨库原子事务；有错先返回，不做成功假象。
- 受限ID/字节预算、跨Skill/跨owner/匿名/陈旧selection/撤权/重复重放专项，实际HTTP/CH夹具读回机器事实不变，解决状态正确隐藏。沿原页面有真实输出才调用的交互，不新建操作入口。

### T3：授权摘要读源与首批统计消费者（T1/T2后）

- 按L2实际查询字段/关系列覆盖目录，优先Dashboard/Fleet/Task统计与模型列表；仅有精确覆盖才复用原聚合，缺字段明确失败。
- 新Trace有数据、旧动态表空/毒化的隔离夹具；普通用户本人/显式共享、组管理员本组、不采纳旧环境白名单为全域授权；读取前后IAM/生命周期复核。
- 不加载全量Session正文，有限分页/100000条及字节上限明确；未知Token/结果不伪0。若原算法依赖当前机器分则先接selected receipt，不从旧缓存补。

本轮每个实际实现切片都单独记录完成与未完成，运行相关测试和完整应用门禁后本地提交；不因清单存在就把L0–L8标为完成。现有验收服务/备份和用户`AGENTS.md`改动保留。新增数据模型或公开API需要继续补领域设计/字典，本计划不是批量空壳建表授权。


T2契约补充：允许显式`resolved_run_id:null`，014物理非空列保存本次真实operation receipt的稳定引用（不是运行/优化已执行的证明），公开投影从hash校验后的精确receipt恢复null。查receipt按workspace/actor/kind/key/request_hash及issue成员校验，receipt所属实验按批次首issue验证，支持同一批跨实验。旧非null值不改。内部`derived_lookup allow_missing:true`只为raw确实不存在的ID返回判别；已知对象来源错误仍失败。静态写前后调用只读`derived_resolution_scope`核验read/write能力和scope指纹。跨库返回计数是core该operation回执计数加本次静态新写计数，不承诺整次HTTP精确回放；前后复核不是跨库原子撤销。

T3首个可独立落地消费者限定为原`modelconfig/pricing GET`的observed模型：复用已授权`observe/data facet=values&column=model`，仅返回真实IAM范围内的模型名，不拉Trace正文或猜per-call统计。保留原内置/自定义价格、忽略占位模型、排序/DTO与部署级价格配置控制。Dashboard/Fleet仍依赖更完整的摘要字段/当前选择与Agent元数据，不能用假failures、注册信息或缺字段补零提前宣称完成。


## 4. 本批执行结果与剩余依赖

| 切片 | 状态 | 实际边界 |
|---|---|---|
| T1只读迁移计划 | 已实现/隔离验收 | 96模型1250列，SQLite源只读；无转换apply，无导出目录输入，始终不可切库 |
| T2原优化点回调 | 已实现/隔离验收 | 原入口、混合static/typed、null/重试/授权、Key传输；不更改014、不宣称跨库原子 |
| T3模型列表首片 | 已实现/隔离验收 | 只迁pricing GET observed模型；价格PUT及其旧控制域不迁 |
| T3授权摘要与首批统计 | 已实现/隔离验收 | Dashboard/Fleet/Quality/Task使用当前授权投影，保留原统计算法、DTO及界面；原Trace钻取、筛选、空结果及执行记录已验证 |
| T3 Skill/Agent列表与版本 | 已实现/隔离验收 | 原Skill列表、版本usage/trend/执行输出和Agent列表/自动发现；sessionless、真实Agent ID、原Recorder来源及登录别名兼容已回归，UI不变 |
| T3其他动态消费者 | 待实施 | Skill runs/logs及其他剩余读写继续按清单接入；Agent删除与静态配置控制域未迁，不将本片视为全部领域完成 |
| L3–L8其他消费者及历史迁移 | 待实施 | 按本文依赖，不能拿清单/目录或测试绿替代业务接管和历史apply |

最终应用5794项（5772通过/22跳过）、存储969项（790通过/179跳过）均零失败，PG/nativeOG解决注解及迁移保留各13项通过；实际HTTP/CH/IAM和数据指纹证据见[实施状态](implementation-status.md#2026-11-15-剩余消费者盘点语义计划与首批闭环)。当前只读计划时间预算在SQL/循环边界检查，最终deadline复核保证超时不返回完整内容hash；max_bytes限制原始读入字节而非进程RSS。原前端JSX/CSS未改，本轮无浏览器验证。此记录只结算三片已验收工作，不将后续条目标为完成。


### T3 第二批实施契约：统一授权统计投影

Dashboard、Fleet、Quality、Task 统计保持原路由、DTO、聚合函数及前端。统一数据源先用真实 IAM 筛选可见 Trace（排除私有评测/诊断自身 Trace），禁止信任查询参数 user 或旧管理员白名单。注册 Agent、价格等仍属原配置控制域，配置元数据只能按已验证身份（Quality另保留公共NULL配置）富化，不能成为扩大观测权限的通道。

统计投影由真实源证据后台计算，包含 Execution 标量、真实 failures、原 callStats、ExecutionSkill 关系、结构化错误摘要、Session 时间与派发边；不得以工具错误计数伪造 failures/RAS，不存原 interactions 或完整 Trace。沿用 computeCallStats/buildFaultPathSteps/buildAgentCallTree 的原规则与护栏，保留原始 latency 数值和原接口的单位解释，本批不顺便改变统计口径。零分、零 token 与 null 区分；覆盖不足、超预算、未索引明确失败，不能当作空库。

新增独立 ClickHouse 统计事实表；事务库仅记录当前发布边界/哈希。001–014 以及 ClickHouse 001 历史迁移保持不变，新增迁移在 SQLite/PG/openGauss 等价执行。私有 prepare/publish RPC 同时要求真实 actor 与 trace-analytics/v1 控制器签名；边界包含路由 incarnation/epoch、源 head 版本、别名、owner、annotation。发布前后和读取前后重新检查权限、删除屏障与源版本，过期发布不得成为当前摘要。统计读取不加载 Span 正文或完整 RunPlan；首次未就绪启动有界后台构建并返回 503 和重试标识，后续只读摘要。

Quality 的机器结果只能来自当前 selected_result_id 且未隔离的 receipt；问题来自当前选择的未解决派生项，诊断来自当前 done 报告头。它们实时富化，不冻结成过期 Trace 统计。保留最多 5000 Trace、400 错误 Trace 解析、201/200 协作 Session 截断标识与原排序窗口。Fleet 可靠性使用真实 RAS anomaly/action_result，不能以普通工具异常推测恢复结果。

执行顺序：先用失败测试锁定投影字段/授权/版本与原聚合口径，再实现存储 RPC 和生成器，接 Dashboard/Fleet/Quality/Task 消费者，最后执行隔离 HTTP、ClickHouse、三种事务库、完整测试及 UI 文件一致性检查。全部使用新隔离数据库和证据目录，保留旧数据库；本批不切生产、不自动执行旧库 apply。


T3容量与验收边界：严格源版本CAS保持当前摘要正确性。持续追加可能在构建窗口内反复改变head而导致暂时pending；本批没有放宽为未标记的旧版本读，也没有宣称千级混合读写已达标。增量物化与显式统计水位是后续容量任务。原生可选cache/reasoning仅接纳明确的Trace级来源，不能把子Span单次用量当总量；冲突明确失败。


### 第二版预留：万级Span与统计水位（第一版不实施）

**范围收口**：第一版仅验收原有功能等价、原界面与操作流程、统计口径以及数据保留。水位cut、016、复杂虚拟导航、万级Span专项和千级混合容量优化均延期；草稿与试验数据隔离保留，不随第一版交付。以下为第二版草案，不能当作第一版运行协议。

真实隔离万Span Trace连续追加40Span/6.51秒时，初版严格全head CAS得到200×1、409×12、503×4；停止后10.87秒恢复。这说明消费者已接通，但实时看板可用性不能按初版验收。保留该失败证据，不以旧缓存冒充当前源。

新增016只追加统计cut描述表，015与CH002保持原字节；摘要格式和既有parser_version=1不变，以generation=2进入boundary命名空间。后台在单次只读事务捕获prepared head向量，从不可变源工件按哈希/版本还原真实快照；不要求构建期间Span停止追加，也不把CH尚未追上的正文冒充已经验证。普通TraceEvidence/评测冻结协议保持原严格行为。

cut描述包括源Trace revision、语义生命周期哈希、捕获时间、证据hash和服务端签名。发布仍要求真实actor/控制器及当前权限，允许Span head前进；不允许路由/owner/alias/用户注解或删除屏障变化。生命周期注解包含所有用户字段和override_fields，排除只用于实时快照的内部agent_record_v1及通用updated_at/revision，避免内部采集更新伪装成用户编辑。

读取选择同生命周期下最高源revision的已接受cut，旧任务完成不能倒退当前选择。源head未变化的cut持续有效；head已前进时最多允许120秒可测滞后，并立即安排合并后的后台刷新。无有效cut、超过滞后预算或缺失事实时明确503/413，不能漏掉相关Trace补空值。API成功DTO不变，通过x-analytics-watermark、x-analytics-lagging-traces、x-analytics-max-lag-ms头声明水位；前端页面、图表、筛选与既有聚合不改。

最终授权/删除/归属/注解立即复核；评测选择、问题解决状态、诊断头和资产ACL仍逐版本复核，RAS当前回执仍独立复核。普通Span追加只推进统计水位，不再使所有读请求409。此方案解决单Trace持续追加时的可用性，千级采集端混合读写仍需独立容量压测，不能由cut机制存在推定达标。


第一版统计钻取保持简单：真实独立执行仍使用自己的Task引用；仅由父Trace临时投影的子执行，其Fleet统计钻取直接打开实际所属Trace，再通过原有Agent树和Span详情查看。不新增虚拟Trace/Session、不引入新的导航令牌或解析协议。


### 第一版后续接入批次：复用已有数据库接口

用户已确认以原功能等价、替换数据库调用为主。第一片为原Skill列表与版本页：统计改用现有授权摘要，沿用原7/14天窗口、800条上限、成功率/P95/趋势及DTO；版本页仅为已选执行记录读取原Trace证据中的完整输出。静态Skill/版本/静态评估仍是原权威，不新增表、迁移或第二版投影协议。身份由真实凭据确认，查询user不扩权；core读取失败保持明确错误，不伪装零调用。精确补齐这些GET入口的现有apiFetch凭据传输，不改变UI或未迁写操作。

执行步骤：先写旧动态表毒化、旧算法DTO等价、授权/空结果/错误透传及凭据传输的RED测试，再替换数据源并GREEN；之后审查、隔离真实HTTP与全量门禁。下一片继续Agent动态查询与Skill运行/日志，再接独立重评、取消和Batch/Trigger。跨库任务优先复用已有实验/RunPlan能力，保留原操作契约；不以通用CRUD替代真实状态闭环。所有验证均隔离，保留当前验收数据，不切生产。


第一版Skill版本执行摘要补充：已有`GET /v1/compat/observe/evidence`支持显式`view=execution`，返回`agent-insight.trace-execution`，仅包含完整execution及来源manifest/hash，不返回或伪造session。合法导入的`session=null`记录可读取完整输出和真实Agent引用；缺省Evidence视图及`readTraceEvidence`契约仍要求原Session，缺失继续404。新`readTraceExecution`复用相同IAM、身份/字节校验和错误处理，仅供对应执行字段消费。执行视图独立计算snapshot hash，当前统计返回前仍复核原摘要版本；无新路由、表或parser版本。


Agent管理GET复用现`analytics`端口增加只读`agent_metadata`动作，每批至多200个已授权Trace/boundary，读取前后复核，返回真实Execution ID/Agent ID和可选注册输入。复用已有经验证的源元数据读取，不改015或parser。静态RegisteredAgent仍原权威；今日调用/最后调用仍按真实agentId计数，不凭名称猜关联。仅本人最近300个实际Execution请求role/agent/subagent_name，按原interaction顺序及原extractObservedAgentRegistrations补注册；Langfuse用原secondary interactions，空/缺Session不造注册。native沿用原Session的resource agent/service覆盖和raw优先语义。源artifact在本地可能包含正文，但不组装完整Session、不从CH拉tool正文，Node只收到上述小字段。Agent DELETE暂不在此片迁移。


第一版后续清单继续执行：Skill runs/logs仅替换原readRecords动态来源，复用原routing/outcome计算，所有合法历史字段和unknown版本保留，不进行读时版本回填。RAS专项GET补齐真实事件、摘要及Trace关联；现analytics端口增加ras_read/validate_ras_read只读动作，覆盖先于Trace到达的事件，普通成员本人/显式共享、组管理员本组，私有Judge Trace的他人事件仍隔离。OLTP receipt校验CH精确hash与当前revision，读取前后授权/版本复核，不使用payload.user授权；沿用原去重/摘要/生命周期投影，DELETE另按删除屏障接入。没有新表、parser或前端界面变更。

Trace内可靠性详情复用同一真实Execution及RAS读取，保留原`ts ASC take200`窗口、marker/恢复状态算法及中英文DTO；RAS有界selection显式加入order并绑定读取token，缺省DESC保持专题页旧行为。不存在的执行仍返回原200 unknown，拒绝/错误不读取旧动态表。上报事件仅按真实来源归属匹配，不通过查询user扩大权限。

FI run Trace纯读沿用原FI控制域及模型/marker优先级，使用真实兼容账号限定Run/Task与worker inventory；动态Session与真实RAS改读授权Evidence/事件，返回前复核源及RAS选择。尚无轨迹/Session保持原空轨迹，拒绝/损坏不回旧动态表。FI控制事务未在此片迁移，原FI markers不冒充真实RAS事件；仅精确GET补Key传输，无界面变化。


### 第一版独立重评、取消与答案编辑：沿用原算法的事务接线

沿用原judgeAnswer/analyzeFailures及返回DTO，在现ExperimentStore复用一个由workspace/owner/Trace/incarnation确定的内部Outcome head、固定Case与专用evaluator slot。每次请求对应现有experiment_runs.generation，不新建通用任务/水位系统。新增私有outcome_begin/outcome_lookup动作：事务外捕获真实Evidence与冻结的静态Config/Skill/模型选择/当前Flow步骤，事务内核对本人owner、head/annotation/alias及Flow来源，再更新可选final_result、修正冻结证据hash、取消旧工作、建立新RunPlan/work/操作回执；任一步失败回滚正文。旧成功结果、RunPlan及失败/取消事实保留，后到结果受现fence阻断。

原final_result编辑trim后立即返回原成功消息，但成功前任务必须持久化；无匹配Config仍可保存并按原save规则产生未知分/缺配置原因。独立rejudge无Config仍400并同步等待原结果DTO。PATCH字段仍按feedback→label→query→final_result的原优先级，只处理首个命中。取消按真实owner及当前run/fence处理，不只改Node内存。只读凭据、组管理员及共享读取不能代替owner重评/编辑。

计算hook使用现worker及冻结runtime；judge的core模型调用复用既有checkpoint/真实Agent Trace记录/取消包装，取消、Trace记录失败或不确定投递不能被旧catch吞成0分或空失败。结果只接受专用coreOutcome marker及其来源hash，不能拿其他实验generic score覆盖answer字段。lookup使用当前slot selection；pending/cancel保留旧score时按同head历史generation取最近已完成结果。Skill/Trace/统计读同一Outcome；内部head从普通实验列表隐藏，不引入新可见界面。先验证原子回滚、请求幂等、替换/取消late receipt拒绝、冻结配置重启、0/null、无Config编辑及混合授权，再进行隔离HTTP/三库与全量门禁。

后续继续依赖顺序：Batch/Trigger任务和评分闭环→可信采集及旧积压确认后推进→Infra/RAS/FI与客户端事务→静态资产/配置/会话→Goal Plus/协作/Usage→完整旧库语义导入和隔离迁移演练。所有原有功能需逐项完成、逐项验证；生产切换另行授权，万级Span/容量仍第二版。

### 第一版 Batch 后续执行顺序

先接原Trace模式的evaluate/retry-evaluate/abort与进度读取，再接Dataset的start/retry-execute。BatchEvalTask、Skill/版本暂保留原控制权威，必须限定真实兼容账号；不能将控制外壳仍在旧域说成Batch整体已迁。原路由、原状态名、响应JSON和页面保持。动态来源用真实TraceEvidence，评测复用ensure/add/startEvalExperimentCases及现RunPlan、worker、lease/fence和冻结评估器，原通过/失败、均分和耗时解释不变。

Trace批次先校验所有来源/Skill版本/已关联评测任务属于实际actor，持久记录准确的backing Experiment及Case绑定，再对选中Case一次封存并建立工作；返回原成功响应前必须有durable任务。任务状态和分数由当前typed work/result选择投影，JSON中自报的分数/状态不能冒充机器事实。取消持久化，单条重试只替代该Case当前代，其余已完成结果保留。响应丢失和静态控制更新失败时重用同请求操作回执/稳定绑定，不能盲启新模型请求；重启只恢复现worker已冻结的可执行工作，unknown投递仍pending。Dataset/外部Agent执行另用现可信录制与执行receipt闭环，不以改入库入口代替采集完成确认。

独立重评取消的返回规则补充：模型晚返回后的录制仍受原attempt fence约束。只有录制边界明确的409/410拒绝（或明确取消类型）穿过Judge及模型投递包装，并且授权复核证明同一Outcome的本次run已取消或已被新run替换，等待中的原重评请求才返回原`{success:false,cancelled:true,message:'Evaluation cancelled'}`。未取消、来源漂移、真实录制失败、未知投递、授权或状态复核失败继续报错，不能通过泛化catch把它们当取消；不向已失效attempt补写checkpoint或迟到结果。
