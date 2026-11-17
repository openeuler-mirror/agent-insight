# 剩余消费者与旧数据迁移：盘点、依赖与实施计划

日期：2026-11-15；首轮盘点基线`945af229`，最新完成情况见第4节及实施状态。用户已授权按依赖自主实施，保留全部原功能/可见界面，只用隔离环境，不切生产。当前工作副本继续使用`codex/storage-core-refactor`，不重置已有数据、不推送远端。此清单按调用链核对，不能把Prisma命中数量当作尚未迁移数量。

## 1. 已接管与剩余功能清单

Trace CRUD/标签/bundle、Dataset版本/回流/生成、实验/比较/直接轨迹评测、结果/RunPlan、诊断会话与报告、Workbench/Grayscale、Benchmark、Flow和版本比较已有typed接管。它们的legacy分支不是待迁证据；仍真实使用的旧静态配置和事务控制域也不能先删或全局拦截。

| 依赖层 | 当前状态与剩余功能 | 实际入口与依赖 | 验收要求 |
|---|---|---|---|
| L0 | 96模型、真实物理字段、关系、owner/凭据与未知数据迁移计划 | `services/storage/legacy.py`、`__main__.py`、`prisma/schema.prisma`；原inspect/export仅原始快照，migration-plan仅核心DDL升级 | 新工具只读、无apply；未知/孤儿/owner歧义/缺转换器不得ready，原导出不放松 |
| L1 | 已实现/隔离验收：原优化点resolve回调；历史导入另待 | 原入口已分别解决 typed 派生问题和合法旧 static/feedback；旧 dynamic/trigger 历史不普通回退 | 原PATCH/DTO不变；真实actor、Skill范围、当前机器selection；静态/feedback仍原域，新派生只写014注解；重复可恢复，threadId缺省保留null语义 |
| L2 | 已实现/隔离验收：Skill runs/logs 与统计读取；历史导入另待 | 原 runs/logs、Dashboard/Fleet/Task/Quality、定价 observed models、Skill 列表/版本、Agent 列表已接通当前授权快照 | 复用原快照与聚合算法；保持真实结果语义，不以泛化实验分数替代answerScore，不回写历史版本 |
| L3 | 已实现/隔离验收：final_result 编辑、独立 rejudge/cancel；历史导入另待 | 原编辑、rejudge/cancel 已走私有 Outcome 持久任务、可信录制与当前投影，原页面保留 | 编辑→冻结证据/配置→持久任务→lease/fence/取消→实际结果与Issue；不可仅去409；新编辑不改旧运行输入 |
| L3 | Batch Trace/Dataset 与原 Trigger A–E 已实现/隔离验收 | Batch 原执行/重试/评分/取消已接管；Trigger 运行/录制/聚合优化点/解决/AI起草及Set删除语义已闭环；旧历史导入另待 | 保留任务/评分/运行DTO；Dataset/Skill/Evaluator版本、进度/取消/重启与空Issue替代语义一起闭环 |
| L4 | 身份与私有Source基础已验收；原upload/proxy/OpenCode complete、OTLP logs、旧spool接入仍待 | 原公共handler与logs→framework spool→consumer→saveExecutionRecord仍旧Execution/Session；B准备与C完整ACK未激活，core下consumer仍启动 | 新接收需真实actor/来源证明及durable ack，旧积压不可仅按payload.user推断授权；原解析/合并/去重保留，确认indexed后才推进cursor |
| L4 | OTLP metrics/Infra采样与关联 | metrics/poller→旧InfraSource/InfraMetricSample；infra树与人工SessionInfraLink读旧Trace | source配置/密钥、CH时序事实与人工关系分域；新Trace root/endpoint/model/window完整，不猜目标 |
| L5 | RAS事件与FI Trace消费者 | RasAnomalyEvent及关联/删除仍旧库，FI runs/:id/trace读旧Session | 先接事件事实与稳定Trace关联/删除屏障，再迁FI控制事务；已有实验collect桥接不能误报双写 |
| L6 | 资产/配置/会话与客户端控制域 | Skill/版本/文件、Config/UserSettings、RegisteredAgent、Workbench/优化会话/计划、客户端凭据/命令/配置、FI Task/Run/Worker | 真实事务权威逐域迁移；迁移在线/busy/lease/outbox只能历史化，不能自动重启外部执行 |
| L7 | Goal Plus、协作、Usage | goal-plus/collaboration ingest/query/resolve及usage queue仍旧域 | 来源同步checkpoint、事件/快照与关系解析、计量去重；daily与event不双计 |
| L8 | 旧库完整语义导入、增量、切换/回退与容量 | 需L0登记的所有转换/身份/制品依赖，所有旧消费者逐项接管 | 显式停写/备份/最终快照/影子读/回退另行授权；本轮无生产操作，无1000采集端/HA认证 |

### 决策与取舍

执行节奏按2026-11-17最新用户要求调整：先连续完成剩余逻辑，模块间只做必要类型检查/快速专项并保存本地检查点，接入全部完成后再集中独立审查、全量/三库/原界面端到端/旧数据迁移演练。后续不再为内部小片逐轮停下来做完整验收；开发检查点不等同完整验收，不切生产。可并行只读梳理无共享写入的后续调用点，编码仍按依赖推进。

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
| T3 Skill runs/logs | 已实现/隔离验收 | 原运行/日志使用已授权历史快照与原聚合；Agent删除、静态控制域和旧历史导入仍未迁 |
| L3 Trace Outcome | 已实现/隔离验收 | 原 final_result/rejudge/cancel 已走新持久链路，保留原页面及历史输入 |
| L3 Batch Trace/Dataset | 已实现/隔离验收 | 原采样/数据集执行、评分、重试与取消链路已接管，旧 shell/静态资产及历史导入另待 |
| L3 原 Trigger | A–E 已实现/隔离验收 | 原 live、实际 indexed Trace、聚合优化点/自动与手工解决、AI起草/占位CAS及Set删除均闭环；原页面0分→AI新版本→100分完成，旧动态历史语义导入仍待 |
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

Batch 原 `startedAt`/完成时间只投影当前结果槽位 `run_id + work_item_id` 的 typed `coreWork` 时间。内部 `coreWork` 仅含当前工作身份、工作创建时间、当前 attempt 起止时间；attempt 按该工作内递增 `attempt_no` 选择，同时间戳不能混入旧代。只查 control metadata，不加载 RunPlan，queued 尚无 attempt 时起止可空；不改其它域原 `createdAt` 含义，也不向公开 Experiment DTO 暴露内部元数据。

Trace evaluate/retry-evaluate 的一次逻辑请求使用独立 `idempotency-key`。apiFetch 仅对这两个原动作保存有界 SHA-256 请求签名（含账号凭据、任务和selection参与计算，但不落盘正文/凭据）与 UUID/时间；网络或完整响应体丢失保留同键，完整 JSON 可解析且 `ok: true` 后清除（200 坏 JSON 或非成功确认仍保留原键），后续明确操作另起新键。静态 binding/ack 使用原 config/state 精确 CAS；prepared 或同请求重试先查已有 start receipt，命中只激活该原工作，避免再次读取最新模型/重新freeze。不同活动请求保留原409；原 agentMaxConcurrency 继续传给 typed worker。取消仅影响未完成工作，完成兄弟保持原结果，取消后可复用准确Case重试或通过原case_upsert加入新本人Trace。

独立重评取消的返回规则补充：模型晚返回后的录制仍受原attempt fence约束。只有录制边界明确的409/410拒绝（或明确取消类型）穿过Judge及模型投递包装，并且授权复核证明同一Outcome的本次run已取消或已被新run替换，等待中的原重评请求才返回原`{success:false,cancelled:true,message:'Evaluation cancelled'}`。未取消、来源漂移、真实录制失败、未知投递、授权或状态复核失败继续报错，不能通过泛化catch把它们当取消；不向已失效attempt补写checkpoint或迟到结果。


Batch 静态 shell 继续服从实时 IAM capability：现私有 Experiment RPC 增 `batch_scope` 只读动作，operation 固定映射为 read / read+write / read+write+execute，不写 head/receipt，不从角色猜 API credential 权限。所有入口在访问静态 Config/Skill/模型或写 Prisma 前预检；同主体 read-only、write-only 和 write-no-execute 均按实际 capability 拒绝。read 可携 `experiment_id`，仅同 principal 经 `_head(deleted=True)` 证实 lifecycle=deleted 时隐藏 Task；unknown/未迁/foreign 继续报错，通用 read 的删除语义保持不变。


### 第一版普通 Trace 的原列表字段补齐

原 Case 页面在未重评的普通 Trace 上依赖 `root_skill/rootSkill`；兼容列表从真实源 Execution 补主 Skill、原历史版本、显式 `ExecutionSkill.isPrimary`、两种调用 Skill 别名及历史评分/原因/失败/Skill issues。根执行自身主引用优先，其次显式 primary，再用自身真实引用兜底；不从子调用猜根，不读最新 Skill 回填未知版本，0 与 null 保留。原已捕获的 compact 集合在源字段缺失时保留，默认 `is_skill_correct=false`、`skill_issues=[]`。

复用现 analytics 私有端口新增只读 `execution_metadata`，每批1..200个已授权 Trace/boundary。只返回上述白名单与原可选 token 指标，不组装完整 Trace/RunPlan，不向 Node 返回 Session/query/output；原 failures/Skill issues 的业务内容依旧按原 DTO 保留。复用 GenerationSources 的不可变工件校验和来源/路由 incarnation、epoch、owner、注解、head revision/hash 与 IAM 指纹前后复核。源工件可能包含 Session 正文字节，仍需枚举 Span 元数据；parser1 未声明字段完整性，不能因其缺字段就当空值，所以本片仍需读取源。响应含封装不超过8MiB，实际读取的工件文件字节累计不超过128MiB；同一次旧列表枚举的所有分页共用预算，超限413，不截断伪装完整。015、parser1的发布hash及前端不变。

筛选以源是否明确捕获 ExecutionSkill 关系区分：显式空数组表示可用空集，不能把 root 偷补进关系筛选；未捕获关系才按真实 Execution.skill/version 降级。Skill facet 在整个可见关系集合为空时才按真实主引用降级，未知版本只保留名称。当前已验证 Outcome 的 record_projection 明确提供调用引用时，列表及关系筛选/facet共同使用它；否则保留源历史值。Query reset仍清当前答案，原调用/路由引用沿用原封存规则，不以普通实验分数填答案。查询SQL先排除他人的私有Judge Trace，组管理员普通列表不会因该项整体403。


本片性能边界：隔离环境32条可见Trace的原Next列表，在本任务全量门禁结束后的三次读取为4.09、4.44、4.92秒；Node/Python/原生库门禁同时运行的高负载期间曾触及原15秒请求限制，返回502，页面按原错误处理显示空列表。未扩大超时、放宽来源一致性或新增缓存协议。此证据不代表容量验收，逐Trace来源校验和重复CH读取的性能优化留后续专项；普通UI验收应与压测负载分别记录。


### 第一版 Dataset Batch 执行接入计划

1. 原 `start/retry-execute/retry-evaluate/abort` 增 core 分支，沿用实时 `batch_scope`、实际兼容账号和原平面 DTO。静态 Batch shell 仅保配置、内部绑定及 prepared/submitted 操作，PATCH 不得伪造动态成功或覆盖内部绑定；旧模式继续原路径。
2. 从实际选中的多个 Dataset 固定不可变 release、Case 归属、输入与参考答案，复用 `coreAssets.releases[dataset:<id>]`；固定 Skill/Evaluator/模型，重试不转向最新 casesJson。执行侧不读取私有 gold。
3. 在现本地执行 helper 内拆出准备与消费步骤；返回原成功响应前，一次 `execute_start` 持久建立全部选中 execute work。后台只消费该 run/case，不重复 force-new；保持原并发槽和 `skill-debug-executor` 参数，可信 recorder indexed 后提交执行回执。
4. 在既有 frozen execution_request 支持 `evaluate_after_execution=false`（默认 true），同现完成事务跳过子评测；关闭自动评测时原状态为 executed，后续 retry-evaluate 保留 Trace 与执行耗时，只启动评测。零分、部分成功均分及全失败语义沿原算法。
5. 同操作优先核对准确回执，再恢复 prepared/submitted，不因响应或静态 CAS 丢失重新运行 Agent。单行重执行只替代该 Case；取消先持久 fence，再核实本地进程退出。queued 未启动工作可恢复，running/清理未确认/未知投递不得当作安全重跑；硬崩溃后的旧进程清理证明仍是明确边界。
6. 先 RED/GREEN 覆盖上述状态、两数据集版本固定、权限、丢响应、取消与迟到回执；再独立审查，隔离真实 HTTP/本地 Mock/原界面与后端全量、三库专项。保留已有数据，不改 schema/前端，不切生产，不把本片称为静态控制域或全部旧库迁移完成。

Dataset Batch实现补充：同Task新start按当前选择建立新cut，并以Task CAS先预留prepared意图；旧Case/RunPlan不删除。retry-execute/retry-evaluate通过现私有source_execution_run_id验证当前Case→execute slot→run后派生原封存输入/配置，记录parent_execution_run_id；不以最新全局配置代替Case历史。新增coreExecution仅为派生私有字段，默认公开read view隐藏，按run局部缓存计划。controller既有purpose覆盖源引用及runtime时刻；autoEval=false不创建evaluate work且未启动占位槽skipped。自动评分使用父execute封存gold，保留Case用户编辑。只读GET无激活动作，queued恢复需要授权的原操作POST；同实例已观测完成可重送回执，硬重启无退出证明仍pending/503。客户端abort严格成功后仅淘汰同账号/Task的待确认意图。后续最终验收结果由implementation-status登记，不将实现或专项测试当作全产品/生产切换完成。

Dataset Batch 审查补充：固定 Skill/数据切片及全部选中 Case 的只读校验先于预留和 typed 写；Case 使用现事务批量 upsert。明确失败仅释放未提交 Case 批次的准确本次空预留，未知投递或已提交绑定保留。已观测本机结果恢复时先重放原 waiting_trace checkpoint 与时间戳，再提交完成回执。

Dataset Batch 真实运行补充：Agent 标准记录明确携带的 skill_version 在可信 Trace carrier 中映射到 canonical skillVersion，保留版本 0；缺失/null 不查询最新版本，已录制历史不改写。


### 第一版原 Trace 准确定位读取

原页面按 taskId/executionId/taskIds 钻取时，在当前 IAM 下先解析不可变旧别名或内部 ID，多个选择取交集，再以既有 route/summary 只装载所选 Trace。route 的 created_at_ms 保留原缺失 started_at 时的时间语义，bucket 变化明确拒绝；未 indexed 的事实与旧列表一样为空。投影继续复用原来源预算、主 Skill/历史字段、当前 Outcome 和末尾权限/删除/来源复核，不改 schema、parser、超时或前端。recognized 全局 facets（tags/skills/values）仍走原全局范围，未知 facet 按普通选择请求处理。

本片仅消除准确定位对无关 Trace 的枚举和源读取；通用列表/复杂筛选/容量仍按既有边界，不把准确定位改善称为所有读取性能或千级并发验收。先以禁止全局 list_traces/无关 source 的 RED 与原 DTO/时间/交集/权限/来源变化回归验证，再由独立审查、隔离真实 HTTP/原页面及后端/三库门禁确认。


### 第一版可信公共采集与 Infra 迁移前置核对

本节是剩余入口的只读源码核对及实施约束，不表示这些功能已接入。原OTLP Traces的[core提前分支](../../../src/app/api/ingest/otel/v1/traces/route.ts)与内部AgentRecorder已有真实身份、原包/分包、receipt和indexed确认，继续复用；它们下方legacy分支不是重复迁移目标。公共upload/空completion不能直接冒充带work/diagnosis来源的内部Agent记录，bundle导入的冲突ID重映射也不能替代持续快照更新。

依赖顺序为：受信公共source/快照receipt与设备身份桥接 → upload与completion → proxy和原分析/子Agent/线程写入 → logs聚合与新consumer确认 → 必要Infra控制/采样模型及原查询 → 显式映射的旧库/旧spool语义导入。原返回字段、原UI和客户端失败不推进checkpoint语义保持；继续不切生产。

- [upload](../../../src/app/api/ingest/upload/route.ts)、[OpenCode completion](../../../src/app/api/ingest/opencode/session-complete/route.ts)、[proxy存储](../../../src/lib/ingest/proxy-store.ts)与`saveExecutionRecord`仍在旧Session/Execution/ExecutionSkill/子Agent/TraceThread写域。接入需稳定source/revision/receipt、completion先到的空会话意图、后到消息合并与墓碑不复活；显式时间、0/null、扩展字段、技能版本和原消息完整保留。先评估现alias/capsule/生命周期载体，不为套用内部Recorder而丢空completion或改变原payload。
- [OTLP logs](../../../src/app/api/ingest/otel/v1/logs/route.ts)的原功能是多框架日志聚合成会话和Trace，第一版按该语义接入并保留原包/事件身份，不制造伪Span或顺手扩展完整原生日志查询。现ObservationIngest仅接resourceSpans；无完整severity/body/scope/flags等日志契约，不能宣称通用OTLP Logs存储已具备。
- [旧consumer](../../../src/lib/ingest/otel-consumer/consumer.ts)存在无归属记录丢弃但返回success的路径，core模式启动代码也仍启动这些旧消费者。新writer不能沿用这个布尔值推进迁移游标；逐原包/会话有明确disposition，所有相关批次indexed后才推进新durable cursor，源文件/旧cursor保留。半行、坏行、无Session和DeepSeek父子重复分片分别处理，不将未确认当成功。
- 接收时必须区分调用者身份与供应商Authorization。真实APIKey及已校验撤销/clientId的device注册主体需映射到IAM principal/workspace并封存接收证明，不能仅凭body.user、authenticatedUser布尔值、用户名/APIKey目录名、锁文件host/pid/token授权。已查旧server spool未持久化可验证credential身份或新receipt；缺证明的历史包进入blocked/mapping清单并原样保留。旧注册库可作独立核验来源，不能用一次新请求的凭据追溯授权所有旧字节。原keyless/proxy路径需明确受信接收主体配置，不猜成当前账号。

**Infra新模型是原功能必要承载，不是第二版容量扩展。** [metrics入口](../../../src/app/api/ingest/otel/v1/metrics/route.ts)、[源/采样存储](../../../src/lib/infra/store.ts)、[会话关联](../../../src/lib/infra/sessions.ts)及poller仍依赖InfraSource/InfraMetricSample/SessionInfraLink。现15张CH和65张control没有等价表：obs_events是Trace事件，eval_metric_facts绑定评测result_id，asset kind也不接受infra，不能假借这些域存指标。

最小设计应保留control中的source ID、workspace/访问范围、endpoint/scrape URL、push/pull、私有authHeaders、model/硬件参数、采样间隔/enabled及Trace↔source/model人工覆盖关联；CH采样需稳定样本/receipt、原tsMs含0、via、nullable model、gauges、累计counters、histogram buckets/sum/count、waitingByReason。保留+Inf、counter reset和原窗口/排序/最新n/导出含义；原全局唯一endpoint、无owner的历史源与人工关联必须显式迁移归属。后续在核心设计/表字典中细化必要增量迁移并验证三库，不运行或混用已延期的第二版水位/容量草稿。当前vLLM归一化不宣称覆盖所有OTLP metric类型、temporality或exemplar。

验收至少覆盖原客户端upload到原Trace页、同包/丢ACK/改包冲突、新快照不重复Trace、completion先到/迟到/重启/墓碑、APIKey/device冲突/撤销/伪造主体、分包或CH失败时pending且cursor不前移、旧源/旧cursor不变，以及Infra push/pull到历史/最新/model/导出/自动与人工关联及私有源隔离。容量与万级Span继续第二版，不能代替上述第一版原功能闭环。


### 第一版原 Trigger 评测接入：A–C 复核切片

原 Trigger 的 root、upload、draft、run、runs、cancel 入口先执行实际 IAM capability 检查，再使用可信兼容账号访问静态 Skill/版本、UserSettings 和 TriggerSet。请求中的 user 不授权。原页面和 API DTO 保留；core 下动态 Run 不读写旧 SkillTriggerEvalRun。此切片只覆盖授权及原 live 运行主链路，聚合 Evaluation/SkillIssue、自动 resolve、AI draft 和 Set 删除关联清理仍待 D/E 闭环，不能称为原 Trigger 整体完成或据此切换环境。

每次原 Run 建一个独立私有 Experiment、一个聚合 evaluate work，复用已有 RunPlan、lease/fence、controller proof 和操作回执，不增加表或 purpose。trigger_begin 同事务防止同实际主体、Skill、版本重复 active；相同操作丢 ACK 先恢复准确回执。409 保留现有 running Run DTO。latestOnly 只选 done，后续 pending/failed/cancelled 不遮住上一次完成。内部 head 排除原通用 Experiment 列表及其统计读取。

RunPlan 固定 TriggerSet ID/版本/完整 items、目标 Skill 完整内容和版本（0 有效）、其他 Skill 的启动时最新内容、其他被测版本历史及模型连接摘要和参数。省略版本只在启动时选择最新；执行/恢复不重新选择。原多 query、多采样、超时重试、>= threshold、竞争路由及空分母 0 逻辑保留，运行物化仍为原 description-only Skill；冻结完整正文供来源/历史和后续优化点使用，不把正文喂给路由测试。模型恢复必须匹配封存连接，未配置 key 时不向 OpenCode 新增空 key。

每个真实样本先写 intent，再调用原 live 算法。原 Session 消息经 work 绑定的可信 Recorder、全部 ingest 批次 indexed 确认后才删除 Session，随后保存 observed 结果；物理进程退出确认后保存关闭时间。样本响应 latency 在决策结束封存，不包含录制/删除等待；Run duration 保存真实完整运行区间，恢复不计入停机时间。已观测样本按原完成顺序聚合，恢复不重复模型。明确未创建 Session、尚未 send 且物理退出已确认的失败保留 failed；未知发送/录制、硬重启缺物理退出证明仍 pending/503。全 Session error 不生成成功分数。

取消先持久 fence，再以准确 attempt 身份核实物理退出/清理；新操作等待未确认清理。客户端沿原 success=true ACK，坏 JSON、丢响应保留原意图；取消仅根据可信 Run 操作摘要清理同账号、同 Skill、准确对应的未确认 start，不误清其他版本。只读 GET 不激活 work 或模型。读取已完成结果重新检查实际采样 Trace 的当前授权、来源和删除状态。

验证分层记录在本片 evidence：专项 Node、后端真实 Recorder+内存 facts、类型及 lint；本地 Mock 原生 OpenCode、原 HTTP/API 客户端、原界面、全量及 PG/openGauss 由最终冻结源验收记录补齐。内存 facts 或 VM 模型替身不等价于原生 CH/模型链路。旧 TriggerSet/Run/Evaluation/SkillIssue/resolve 关联仍须显式语义迁移，普通新 Run 不冒充导入历史。

A–C 独立审查修正：真实 withCoreExperiments 的 trigger_begin 序列化必须携带原 HTTP operation_key/operation_request，并在网络重试中保持完全相同；仅 stub rpc 的运行测试不能证明该契约。客户端 success=true 还须附带匹配 Skill/请求版本/测试集的完整原 Run 或有效版本 Set，只有 ID、缺日期/必要字段或错归属的 ACK 保留意图；取消还验证准确 Run ID 与可信操作摘要。通用 list 默认及按 ID read_view 均隐藏内部 Trigger，专用读取继续按原授权；普通实验读取不变。最初真实 HTTP 400、零模型调用的失败证据保留，修正后另建隔离验收环境，不覆盖旧证据。


### 第一版原 Trigger：D 聚合优化点与真实解决（复核切片）

抽原纯 builder，legacy persistence 与 core 使用同一套 summary/evidence/suggestedFix 构造，不改原算法或建议文案。core 只使用本次封存的完整目标版本和其他已测试版本历史；运行物化继续 description-only。独立旧源码提取的三组 golden 覆盖漏/误触发、Unicode 长 query、历史描述，以及全 pass 但有 competitor 仍生成一个 low issue；仅全 pass 且无 competitor 不生成新 Evaluation/Issue。

新完成结果携带 signed coreTriggerDerived，后端限定 sealed Trigger scope、原聚合 report、Skill/version、真实 sample Trace 和当前来源。每次最多一条 Evaluation、一条 dedupKey=trigger:<skillName> 的 Issue；generator=trigger-evaluator@1.0，runId 为原公开 TriggerRun ID，ruleId/dimension/reasoning 保留 null，owner 展示沿封存兼容账号且不用于授权。generic 结果不能伪造此 envelope。

接受完成结果、记录机器选择、生成新问题与解决同主体/Skill/version 旧 typed trigger 问题在同一事务。自动解决使用正式 derived_issue_resolve 操作回执及 014 注解，resolvedAt/公共 resolvedRunId 可追溯；故障回滚不留下半条解决记录。原 manual resolve 的 nullable context 和 includeResolved 历史继续可用。最新 clean 完成推进空 frontier；failed/cancelled/迟到提交既不解决旧问题也不产生新问题。

原优化点 HTTP/聚合仍读取合法旧 static/feedback，动态 Trigger/Evaluation/SkillIssue 不回落旧权威。已存在旧动态历史继续列迁移清单；本片不读时补造旧 Issue，不改旧库数据。list/detail/frontier/手工解决前后核对实际采样 Trace 的当前授权、来源和删除屏障。原页面/DTO、数据库 schema/purpose/parser 不变。D 专项与邻接测试不代替最终原生/原页面、全量与三库验收；E 的 AI draft、placeholder CAS 和 Set 删除关联清理仍待后续独立切片。


### 第一版原 Trigger：E 起草与 Set 删除（复核切片）

AI draft 保留原 direct createModel.invoke、SYSTEM/USER prompt、18条要求与原宽松非空解析；两条合法输出也接受，replaceUserEdited=true 不合并旧条目。每次以 operation 派生稳定 placeholder ID，固定实际最新 Skill 完整内容/版本（0有效）、用于提示的解析正文/description和非秘密模型连接摘要。返回 success+set 前已存在独立 kind=draft 的 typed work；内部 draft head 不混入通用 Experiment 或原 Trigger Run 列表。409 保留原 existingSet。缺模型配置封存为可追溯失败意图，后台 CAS failed，不以最新配置重试原意图。

复用既有 flow-model-delivery 单次 intent/observed，真实 direct system/user/assistant或失败消息经过可信 JudgeTrace、全部 indexed 后才记录 observed。记录缺失/未知提交保持 pending，不因5分钟占位过期重发；已观察响应/失败恢复不访问当前模型或再次 invoke。采样文本沿原 parser 解析，item ID 由工作和条目索引稳定派生，支持同一结果的静态 CAS 恢复。Model usage 映射保留真实0值。真实运行与只读恢复分别验证，不把 VM 模型替身当原生 provider 验收。

placeholder 完成只做按原 ID/owner/Skill/version/status/updatedAt/原 items/元数据的精确 updateMany CAS，不插入新行。相同 ready/failed 完成重放可确认旧 ACK；编辑冲突返回409并保留用户数据。typed result 与旧静态投影不宣称跨库原子，已完成 result 的静态确认可由原授权 POST 恢复；GET 仅读取，不启动模型或写回。ready 历史版本保留，新起草仍沿原规则清理 failed/stale 占位，活动或未知 typed 调用不当作僵尸重跑。

**删除口径更正：原 Set DELETE 只删 Set，不级联 Run/Evaluation/SkillIssue。** 旧 triggerSetId 是普通字符串，无 FK/cascade；隔离旧原 handler 对照为 Set/Run/Evaluation/Issue 由1/1/1/1变为0/1/1/1，history仍200。本片不删除 Run/Issue head；已有完成和在飞 Run 使用封存 Set 继续，原历史/优化点保持。删除后仅对缺失 placeholder 所对应的 draft 做准确持久 fence、物理调用结束确认与清理，取消状态阻止迟到提交；draft begin 后激活前重新核对静态占位，CAS 只更新已有行，删后不复活。DELETE 的 read/delete 能力用于专用 draft 清理，不借此取消 Run，也不要求额外 write。

实际 withCoreExperiments→requestCore wire 回归覆盖 begin、模型 checkpoint/complete 和删除清理的原 operation_key/request 及现有 frozen-assets purpose 签名。无新 schema、purpose、parser、模型框架或前端变动，旧 dynamic 历史仍在语义迁移清单。最终全量、PG/openGauss、真实本地 provider、原 HTTP/原界面及异常验收由冻结源统一确认；本片自身仍不授权生产切换。


E 复审修正：原 UI 首轮 reload 未检查 runs HTTP 错误，会把409错误 DTO 当成空历史并停止 running 轮询；已有 running 的 refresh 路径与首轮不同，必须以原函数对照。仅 Trigger read postflight 的 head revision/currentRun 变化携带 TRIGGER_READ_CHANGED，HTTP helper 只在 experiments RPC 白名单输出，Node transport 仅该端口/409识别，原 Trigger handler 增精确 retry header。apiFetch 只对原 GET /trigger/:name/runs 的对应409，在原15秒预算内最多3次重读；每次重新核对实时凭据/账号、尊重 Abort，既不扩大授权也不放松来源一致性。耗尽、普通409、403、404等进入原 reload catch 保留现有状态，不以错误 DTO 伪装空列表；普通源冲突/墓碑不重试，POST冲突及 existingRun/Set、其他 GET 契约不变。原 TSX/页面代码未修改，真实旧失败夹具保留，冻结 V2 后另跑实际 apiFetch→原 HTTP/模型链路，再跑最终门禁。


E 起草 CAS 跨语言修正：Python canonical JSON 会改变 Item 对象键顺序，不能用 raw JSON.stringify 比较确认已提交的同一 ready 结果。完成确认与启动前检查共用结构比较，忽略对象键顺序和 JSON 中不存在的 optional undefined，保留数组顺序、真实字段值及 null。ready 确认比较静态行原 itemsJson 的解析值，不经过会 trim/coerce/drop 字段的公开 DTO 归一化，因此 query/shouldTrigger/rationale/source、顺序、空白或扩展字段的真实编辑仍冲突。既有 SQL CAS 条件、JSON 写入格式和 owner/version/元数据保护不变，不泛化409为成功。Python sort_keys 往返到实际 Prisma ready/重放的 RED/GREEN 与编辑拒绝专项独立记录。


### 第一版原 Trigger 最终隔离验收（2026-11-17）

A–E 最终冻结源经 Spec→Quality 独立复核，完整应用6078项（6056通过、22跳过、0失败/取消），后端1141项（962通过、179可选引擎跳过、0失败）；PG与原生openGauss各27/27，关系库专项使用MemoryFacts，不等同完整CH组合矩阵。SQLite+真实CH+原生OpenCode的104次原HTTP请求及8次本地模型调用覆盖取消、丢ACK、ready回执恢复、原聚合文本与自动/手工解决，未调用外部LLM。原Next界面实际保留v0、手编0分、AI新建v2、复测100分及两条Run历史，应用console无error/warn。277个TSX/CSS与本批基线一致，无新增schema/parser/purpose。

刷新前两库备份，65个core/96个旧表及15个CH表原行摘要子集保留；仅负例Outbox重试元数据正常推进，并明确向隔离admin既有模型列表追加一个本地验收配置，旧配置/active选择及账号密钥保留。原实验100分、Workbench0分、诊断done/report和4身份再次读回。证据位于exclude/storage-core-trigger/20261116-lrv_m9yj，完整边界见implementation-status.md。原Trigger历史与其他旧动态表尚未语义导入；后续按可信公共采集、Infra及其他控制消费者依赖继续，未切生产。


### 可信公共采集第一片：身份与写能力预检（已隔离验收）

公共快照与completion接入前，先实现仅服务端使用的可信采集身份范围。现compatibilityContext只证明当前身份/成员，/v1/auth/me不返回凭据capabilities，因此不能凭workspace角色认定API token可写。新增私有POST /v1/compat/collector-source，首片仅支持action=scope、operation=snapshot或complete：在实际sidecar以api_凭据检查workspace write，再返回authorized/principal_id/workspace_id/operation，不写locator/事实或回执、不接管原公共路由。不新增schema或controller purpose；后续实际接收仍须事务内重核，预检不是最终接收证明。

Node helper保留原上传双凭据规则：API凭据与实际authenticateDevice独立核验，两者有效须同principal/workspace；一份失效另一份有效可接受，但失效device不得绑定clientId。设备主体使用注册库实际owner并按私有映射核验当前IAM，legacy用户名与principal登录名分别保留；同一owner多principal/workspace或匹配候选不可核验时拒绝，不猜选。只检查匹配owner的候选，其他owner旧凭据撤销不阻断本次；私有文件仍整体按原大小/格式/权限约束校验。报告clientId与有效device不符拒绝，payload.user、authenticatedUser或自报device布尔值不授权；侧车不可用503不伪装凭据失效。供应商Authorization与调用者身份头需由未来proxy调用显式分离，不能默认继承供应商Bearer。

身份范围为私有品牌对象，凭据保存在服务端闭包，公开响应/日志不携带。重核须匹配原principal/workspace/operation及有效device注册状态；调用者伪造对象不能作为可信scope。首片不改upload/completion/logs/proxy旧行为，待source回执与indexed确认完成后整体激活，不把预检存在称原采集已接入。

后续source片必须封存原输入、选择后的默认时间/身份、基准source revision、标准化快照及packet计划，恢复先命中同operation回执再读最新Skill/配置。completion先到持久保存空意图及原endTime，不制造交互/LLM；后到快照复用同locator/bucket并继承完成状态。上传2xx只在全部分包indexed后返回，pending/失联不推进客户端checkpoint。公共source不接受内部work/diagnosis context，保留原adapter merge与query/version规则，并完整支持既有snapshot-replace允许缩小框架；被移除实体以更高revision墓碑退出当前视图与汇总，旧制品/历史heads保留。原spool无可核验身份的旧记录仍blocked/mapping，不借新凭据追溯授权。

首片验证至少包含：真实read-only API即使成员为writer仍403、撤权与viewer拒绝；别名/登录名不同、设备有效/撤销/clientId冲突；双有效同/异主体与workspace、双向坏一份、无映射及多映射；伪造body/品牌范围、重新核验后归属变化、sidecar503不降级401。默认数据不触碰，独立schema/临时注册库，后续再做真实公共API到原页面与CH全链验收。

身份片最终验证：Node6097项（6075通过、22跳过、0失败/取消），后端1146项（967通过、179可选引擎跳过、0失败）；PG和原生openGauss真实HTTP各5/5，5个自有schema清理后回查0。实际Node helper→真实sidecar及真实注册/撤销设备的21次请求通过，65张事务表在预检前后完整行哈希不变。Spec与Quality独立通过；Quality另验证两次授权检查间角色降为viewer时403、真实HTTP重定向未向第二origin发送请求。3105个冻结来源与当前代码一致，原公共handler、277个TSX/CSS及DDL未变。证据为exclude/storage-core-collector/20261117-i_wpbhkw；本片不接管快照/completion，也不代表公共采集indexed ACK完成。


### 公共 source 持久链路：A/B/C 实施切片

A为sidecar公共source账本与可信投影：以 `collector-source/v1` 私有controller proof覆盖主体、空间和精确请求正文，扩展既有collector-source RPC的准备/读取前态、CAS提交、completion和状态；每次实际事务核验API write、私有来源归属、当前locator/别名与删除屏障。scope预检仍不要求proof、不写数据。write-only采集Key可使用持有私有proof的服务端操作；不得向任意只有write Key的调用者开放先前快照原文。新私有 `collector-source-plan/v1` 编码只能由已经提交且严格绑定账本operation/actor/source的batch驱动现观察worker，不接受通用OTLP自报删除、内部context或私有计划。沿现有locator/alias/annotation/artifact/batch/outbox/head模型，无新增DDL。

同一source保留原输入hash/操作、首次选择的默认时间/身份、基准与新revision、标准化完整快照/投影计划工件、分包和indexed回执。重试先查旧operation再选择新静态配置/时间；变更同key输入409。前一操作pending先恢复，后续CAS不能越过；只在全部分包indexed后返回上传2xx。annotation中仅有有界状态、hash和工件引用，不存API/device/controller credential。普通OTLP即使自报相同namespace/native ID，也不能凭namespace冒充受信source；已有route无正确私有账本或别名/owner不匹配仍冲突。

completion先到以首次选择的完成时间创建空意图、locator、私有ACL和别名，不制造任何交互/LLM/tool/CH事实。**locator bucket在首次创建即固定**：先completion则按该首次时间选桶，后到跨日真实消息仍用同桶，原始started_at照常保留；先snapshot则按真实启动时间定桶，后续completion继承。不能更改001的trace_identity_stable保护或把分区日期当业务时间。对已有事实的完成状态变更需真实indexed确认；无事实的空意图可按durable控制回执确认。

允许缩小的snapshot-replace保留原语义。消失实体写更高revision的CH墓碑并从当前汇总扣除，旧head和制品不删除，再出现沿稳定ID及更高revision。完整head向量继续作为来源fence；Evidence、Generation及其他当前读取只排除经过私有来源/工件hash确认的retired实体，不能采信请求体skiplist或放松通用OTLP完整性。元数据carrier不伪装真实LLM/工具调用。

B复用/提取原TS准备与静态选择：adapter.normalizeForStorage、monotonic合并的原顺序、query保护/强制改写、label版本绑定/历史版本不漂移、各框架允许缩小、Opencode/Langfuse派生字段及配置匹配保持。分离实际前态读取与纯计算，绑定源revision并封存后提交；不把原算法重写成Python通用CRUD。nested子Agent、Thread/traceThread与原后置处理属于upload等价范围，不能接通主记录后把它们隐藏成“其他功能”。

C在A/B独立验收后才一起激活原upload与completion，并把processUploadAsync的保存、流程图及失败分析接到source revision fence与已有真实typed writer，避免返回成功后再写旧Session/Execution。原内部AgentRecorder及core-recorded抑制重复uploader路径继续复用；SkillGenerator bridge仍有真实spool→upload依赖，不能把所有内部tag上传当重复删除。tag/persistedSession本身不授予跨主体写权限，需实际授权的接收身份及服务端验证的生成run/session绑定，或原运行入口向uploader传递可核验的专属身份；缺证明保持pending并留存原spool，不靠任务ID猜owner、不越权转归属。该部分须在C激活前完成实际桥接验证。

A首轮先验证真实事务/内存facts及私有原HTTP：同操作/改包冲突、写入CAS、completion先到/跨日/默认时间重放、分包失败pending和重启恢复、所有当前读取与允许缩小/再出现、撤权/删除/外来alias/伪造计划拒绝。随后真实CH、PG/原生OG与完整门禁；B/C另行补原handler/原算法对照和原浏览器采集验收。A存在不表示原上传已切换，原公共入口暂保持原实现。


A补充实现约束：原包接收与Source commit的重放hash先于后来completion/新快照选择，旧commit只返回原回执，不重写当前事实。只有尚未commit、无任何ingest batch的reserved意图可由持有私有proof且当前有权限的服务端执行reject_preparation，绑定精确input_hash及有限枚举的确定性输入/尺寸错误；原输入和failed回执保留，准确清除本意图pending并阻止迟到commit。RPC/CH暂不可用、模型/配置缺失或撤权不能冒充确定性预处理失败。旧失败重放不清除新pending。

设备绑定为signed verified_client_id，首次只能来自真实品牌身份；已有受信clientId遵循原resolveTraceClientSnapshot的existing优先，后续API-only或其他设备不能重写历史绑定。允许在同一实际owner下恢复之前已持久捕获的原device来源历史，但这不替代当前写入权限。只要新操作仍reserved，旧indexed事实仍可读；commit后所有分包indexed以前，当前列表/详情/证据都以pending拒绝，不返回部分计数或伪空成功。证据fullhead向量包含退休实体作为来源fence。

原TS无framework时允许Generic adapter，原nullable framework不能因存储重构被改成硬错误或虚构业务框架名；CH内部规范化可用显式fallback，原capsule保留null，绑定首次真实框架后拒绝冲突。合法0时间仅在受信collector纯规范化依赖中允许，普通OTLP/旧bundle校验默认不变，不通过伪造1ns表示。原会话未结束即使已有消息全部完成也仍running；会话completion改变后需真实CH投影再确认，不能制造伪LLM/工具Span来驱动状态。


A已完成最终隔离验收：6098项应用测试（6076通过、22跳过）及1192项后端测试（1013通过、179可选跳过），零失败；PG/原生openGauss各43/43、自有schema残留0。真实SQLite+CH的48次私有HTTP验证快照/墓碑/完成与分包pending；修复缺失摘要误返空结果后，另16次真实HTTP确认缺失503、合法筛选空结果及旧快照精确导出，65事务表/15CH表逻辑内容前后一致。Spec→Quality均通过，原公共handler、277个TSX/CSS及DDL未改。B/C尚未激活；私有Session含规范化传输字段，公共DTO等价必须在C复用原Node payload projection验证。完整证据与未完成边界见implementation-status.md。


B采用共享准备提取，而非通过“内存Prisma/recording DB”执行整个save。明确输入为canonical身份、源revision、原Execution/Session及线程/子树前态、封存静态业务配置和固定默认时钟，纯计算不访问DB/模型/当前时间。legacy save消费同一组原算法；注册Agent、历史身份规范化、GoalPlus/协作等真正副作用以命名post-hook显式列出。先抽确定性消息/query/version/Session/子树/thread，再集中静态Skill/config/score/key-actions捕获及原配置投影，B全部闭合才交付C。模型调用保留原analysis边界及冻结输入，不伪装纯计算，也不把凭据或完整含秘密UserSettings写入准备产物。

原等价基线已扩充为14组：原九组外增加Jiuwen独立child及重放、Langfuse四节点完整/单调合并、Codex两轮线程事件及双向execution关联。冻结旧Next handler与真实独立Prisma执行，15次写请求、出网0；位于同证据目录original-upload-golden-v5，提供完整portable/SessionDTO/child/Thread/ExecutionSkill对照。此前v4因仅子Span缺真实root导致aggregate返回null，属于harness输入修正，原失败日志保留。

B允许将原upload的quick技能提取/activeVersion选择窄提取为共享prepareUploadQuickData，并由原legacy handler直接调用同一函数；这不启用core提前分支，不改变鉴权、内部tag、保存/分析时序、返回及原副作用。故B验收口径是公共入口尚未接管新存储及原行为逐字段等价，而非upload文件字节完全不变；必须使用冻结旧原handler的golden对照，检查data原地变更对异步分析输入的影响。

C接缝须显式补齐：B的FrozenCollectorPreparation只是可序列化输入，不是已持久状态。A当前reserve只封存原请求/前态；C应在任何模型或后置处理前以同operation/input hash/base revision的首次CAS封存静态capture和完整计划，后续恢复先用该工件，不重新选择最新配置。ExecutionMatch须由既有typed flow_lookup捕获，不读旧动态表。headless completion还须持久保存原空Session/default startTime/label，供后到upload使用；不能伪造Execution或CH Span补载体。

C的图操作还需覆盖所有实际派生child、原sweep条件、root/child indexed确认和Thread控制状态。现65表没有独立TraceThread/Event权威，不能把B纯thread plan称已落库；先细化必要控制存储与threadOnly契约，复用现有模型只在领域含义匹配时使用。公共Session读取应复用原Node pipeline（Claude normalize、subagent name inference、OpenCode timing、payload versions/structure、parent/child与Thread，及既有Dify/GoalPlus/collaboration分支），不得凭规范化Span传输字段猜测裁剪原raw扩展。全部实际来源/删除/IAM屏障及合法空结果语义继续保留。


B已完成最终隔离验收（2026-11-17）：原quick/save共享准备、冻结相关静态输入、root/Session/skills/child/Thread/命名hook计划及completion纯计划；原legacy入口仍使用相同算法，未激活公共core writer。最终Node6140项（6118通过、22跳过、零失败/取消），原18组真实SQLite/API/Session/portable/Thread/config对照相同；Spec64项及实际反例、Quality71项及4组真实反例复演通过。8个交付文件与3111冻结来源一致，277个TSX/CSS未变，163个后端来源及DDL与A相同，沿用A已完成后端/引擎验证而非本片新跑三库。证据在同collector目录source-b-v3-*及两份review报告。

独立复核修正了原falsy timestamp/default clock、无关旧坏JSON不解析、headless首次Session时钟、framework缺省与显式清空的缩小保护、实际静态正文查询范围，以及Thread自然身份/原前置时序。legacy存储字符串保持原表示，不借此清洗/迁移旧数据；canonical core读取须由可信producer提供已校验数组。static capture用轻量目录保留JS折叠匹配，正文只取选中ID/必要版本；routing精确case版本与业务definition折叠case不能混用。

C额外边界：纯存储plan的skipped/background字段不代表原public handler全部行为。原handler并不检查save.skipped，autoEvaluation开启仍可进入异步分支；激活前需按原整体逻辑覆盖护栏跳过、threadOnly、pending-parent、in-progress/setting及响应flags，不能因plan早退静默关闭原分析。Thread前置可在snapshot缩小保护前生效，pending-parent原在Thread之前，均须按原时序保留。首次durable capture/wholeplan CAS、typed flow前态、无Trace空Session/Thread、图ACK及source-fenced异步结果仍属C未完成内容。


### C1a：首次准备持久化与旧未完成请求接管（已隔离验收）

016只新增collector_preparation_receipts（66事务表+15CH），与source预留同事务封存首次Node输入字符串、可信前态、capture及纯计划。首次封存赢得竞争/丢ACK，重试不重选静态依赖；A仍唯一决定accepted/indexed。旧A历史保留且无法恢复的原键序诚实标为legacy_canonical；仅当前applied revision的原Session表示可以作为后续合并前态。完成先到持久空Session/首次时钟，无伪Execution/Span；Execution-only后completion及稍后upload保留原行为。

旧reserved快照/完成意图转入准备协议时必须与receipt同事务设置preparation_required，含resume_pending及已有receipt缺守卫恢复；否则旧commit/complete可绕过sealed计划。最终v2修复并在真实015→016副本及两条privateHTTP反例验证409；alreadycommitted旧回放、手工annotation及原历史不改。

最终后端1213项（1034通过、179跳过、零失败），PG/nativeOG各62/62（MemoryFacts、schema残留0），Node→真实CH193次HTTP及数据保留通过，Spec32/Quality27通过。完整Node6141项（6119通过、22跳过）在v1完成，v2只2个Python文件变化、Node/TS/DDL/JSON逐文件相同，严格指纹复用并另外验证v2真实Node私有HTTP/CH；不称v2重新完整跑应用。完整证据和首次失败/超时边界见implementation-status.md与同collector目录source-c1a-v2-*。

此片public_ready仍false，未启公共采集，277个TSX/CSS不变，原验收服务未刷新。非空图效果提前pending，不以半份root成功冒充整个原行为；下一片按原功能接子Agent/Thread，再接原Session DTO与upload/completion/异步分析，随后proxy/logs/consumer及其余清单。第二版容量工作继续延期。


### C1b开发检查点：子Agent/Thread逻辑已接，集中验收待后续统一执行

017新增原Thread所需head/event/member三表，保留原upsert/reconcile、Thread-before-shrink、ThreadOnly及child前态/来源语义；沿A私有账本原子应用整图，ACK/读屏障核对完整member batch vector，派生退休保留Session与历史。seal_capture成员预留、普通child误resume保护和当前owner/别名/删除校验一起实现，不另造图状态系统。开发快速专项/类型检查已过，完整结果及未覆盖边界见implementation-status.md。

按用户新节奏直接进入C2/C3，不等待本片完整验收。接下来保留原Session Node算法，仅替换授权数据加载，接原upload/completion/异步分析/hooks和proxy/logs/consumer。待剩余全部逻辑接入后集中独立审查、full/三库/CH/原UI及旧数据迁移演练，当前不切生产。
