# 旧数据库迁移与回退设计

日期：2026-11-11；基线 `298d1d5b`。本轮只实现只读盘点和逻辑快照导出，不执行线上目标导入、停服切换或生产数据修复。

当前96模型的物理字段/归属修正、剩余消费者依赖和只读`plan-legacy`实施见[phase7](phase7-consumers-and-legacy-migration.md)。下文历史粗分类不代表逐字段转换器已实现；Config、可编辑Tag/Infra覆盖及Playground物理别名以当前目录为准。

## 1. 不变量与交付边界

源 SQLite 以 `mode=ro` 打开，不使用 `immutable=1`，因为已提交数据可能仍在 WAL 中。BEGIN 后在同一读取事务内完成 integrity_check、foreign_key_check、schema 和全部行的计数、哈希/导出，形成一致逻辑快照。逻辑快照不是介质备份：生产切换仍须独立演练 SQLite backup API 或停写后安全复制主文件/WAL 的备份恢复。

盘点返回表/列、计数、摘要、物理 schema、来源分类与未分类名单，不输出任何行值。未知物理表会被保留导出并标记 unclassified，禁止自动迁移到猜测目标。损坏数据库或外键违例直接拒绝，不靠关闭 FK 校验绕过历史问题。系统 sqlite_* 表不导出，sqlite_sequence 的值与自增语义在将来目标转换清单中另行核对。

## 2. 冻结身份与字段映射

- 保留现有主键为 legacy identity，新增规范内部 ID 时保存 `(source_database_fingerprint, physical_table, legacy_id) -> target_id` 映射，重复执行不能生成新 ID。
- username/所有者映射为 workspace 与 principal；NULL user 无权自动成为 public，无法归属的数据隔离并待指定处理。名称是展示/外部 key，内部 release 引用使用稳定 ID。
- 可变旧列表只生成 cutoff 时观察到的 migrated_snapshot/observed_at_cutoff 发布版，不能伪造历史版本。旧版本内容缺失则版本标记 unresolved；不能拿当前 Skill 内容补造历史版本。Agent/评估器缺少固定快照的运行保留 unpinned 来源状态，不宣称可精确复现。
- 旧 Session 的 interactions、langfuseTraceNodes、TraceThreadEvent 和来源关系同时保留。无原生 Span ID 的节点从持久映射创建稳定 ID，不以数组下标独立决定身份；不能把一个 interaction 擅自当成一个原生 Span。
- ExecutionSkillOrigin 保留来源 message/turn/来源键；TraceThread 与 turn/sourceExecutionId 关系保留。SkillDeployment 当前派发/确认状态留 OLTP，SkillDeploymentEvent 历史入 CH。
- 使用 SQLite 实际物理表列名；例如 Prisma @map 字段不能按代码属性名猜测物理列。时间/BigInt/未知值/金额转换有版本化规则，浮点原始位值与 BLOB 不经不精确 JSON 数字转换。

## 3. 每个旧模型的目标分类

以下 96 个模型来自该基线 Prisma schema。表格为逐模型领域归属，不代表已经实现全部逐字段转换；运行时盘点另以真实 sqlite_master 与 PRAGMA 列定义为准。

| 旧模型 | 目标分类 |
| --- | --- |
| `Skill` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `SkillVersion` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `User` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `Execution` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `TraceThread` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `TraceThreadEvent` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `TraceEvaluation` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `ExecutionSkill` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `ExecutionSkillOrigin` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `Tag` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `ExecutionTag` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `Evaluation` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `SkillIssue` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `Config` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `Session` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `UserSettings` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `ParsedFlow` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `ExecutionMatch` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `UserGuideState` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `SkillGeneratorSession` | OLTP 当前会话/计划/任务；CH 消息与迭代历史；制品引用 |
| `SkillGeneratorMessage` | OLTP 当前会话/计划/任务；CH 消息与迭代历史；制品引用 |
| `SkillOptSession` | OLTP 当前会话/计划/任务；CH 消息与迭代历史；制品引用 |
| `SkillOptPlan` | OLTP 当前会话/计划/任务；CH 消息与迭代历史；制品引用 |
| `SkillOptPlanItem` | OLTP 当前会话/计划/任务；CH 消息与迭代历史；制品引用 |
| `SkillOptMessage` | OLTP 当前会话/计划/任务；CH 消息与迭代历史；制品引用 |
| `SkillOptIteration` | OLTP 当前会话/计划/任务；CH 消息与迭代历史；制品引用 |
| `SkillWorkbenchSession` | OLTP 当前会话/计划/任务；CH 消息与迭代历史；制品引用 |
| `SkillWorkbenchMessage` | OLTP 当前会话/计划/任务；CH 消息与迭代历史；制品引用 |
| `SkillWorkbenchTask` | OLTP 当前会话/计划/任务；CH 消息与迭代历史；制品引用 |
| `SkillOptimizationRecord` | OLTP 当前会话/计划/任务；CH 消息与迭代历史；制品引用 |
| `SkillSnapshotEvaluation` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `CustomEvaluatorList` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `AgentEvalDataset` | OLTP 资产/发布状态；CH 样本修订与成员；私有制品独立域 |
| `DebugHistory` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `BatchEvalTask` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `GrayscaleTask` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `DebugJobResult` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `TrajectoryEvalResult` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `RegisteredAgent` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `FaultDiagnosisSession` | OLTP 当前会话/计划/任务；CH 消息与迭代历史；制品引用 |
| `FaultDiagnosisMessage` | OLTP 当前会话/计划/任务；CH 消息与迭代历史；制品引用 |
| `DiagnosisRun` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `AgentDebugReport` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `AgentDebugSkillsAnalysis` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `SkillTriggerEvalSet` | OLTP 资产/发布状态；CH 样本修订与成员；私有制品独立域 |
| `SkillTriggerEvalRun` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `SessionInfraLink` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `InfraSource` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `FaultInjectionTask` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `FaultInjectionRun` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `FaultInjectionWorker` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `RasAnomalyEvent` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `InfraMetricSample` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `Experiment` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `ExperimentCancellation` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `ExperimentLocalExecution` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `ExperimentGroup` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `ExperimentCase` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `BenchmarkDataset` | OLTP 资产/发布状态；CH 样本修订与成员；私有制品独立域 |
| `BenchmarkDatasetCase` | OLTP 资产/发布状态；CH 样本修订与成员；私有制品独立域 |
| `BenchmarkExperimentBinding` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `BenchmarkCaseRun` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `BenchmarkArtifact` | OLTP 制品元数据；ArtifactStore 字节及 CH 分析引用 |
| `BenchmarkDispatchOutbox` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `BenchmarkEvaluation` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `BenchmarkEvaluationArtifact` | OLTP 制品元数据；ArtifactStore 字节及 CH 分析引用 |
| `BenchmarkEvaluationDispatchOutbox` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `ExperimentTraceAttempt` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `ExperimentEvalResult` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `ExperimentEvalComment` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `PlatformUsageEvent` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `PlatformUsageDaily` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `ReliabilityInstallToken` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `ReliabilityClient` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `SkillDeployment` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `SkillDeploymentEvent` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `ReliabilityClientCredential` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `ReliabilityCommand` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `ReliabilityClientConfig` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `ReliabilityConfigSnapshot` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `ReliabilityConfigDelivery` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `ReliabilityConfigLoad` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `GoalPlusSource` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `GoalPlusGoal` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `GoalPlusRun` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `GoalPlusCandidate` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `GoalPlusIteration` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `GoalPlusAgentSession` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `GoalPlusExecutionLink` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `GoalPlusSemanticSnapshot` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `Collaboration` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `CollaborationEvent` | CH 事实/关系/投影，编辑或生命周期指针保留 OLTP |
| `CollaborationEndpointResolution` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `CollaborationSessionBinding` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `TraceDatasetGenerationJob` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |
| `TraceDatasetOperationReceipt` | OLTP 控制/身份/任务，历史事件按领域拆入 CH |

## 4. 分阶段迁移

1. **只读预检**：实际 schema 指纹、表列、索引/触发器/视图、完整性/FK、逐表行数与类型保真摘要；基线之外的 schema 进入 review，不静默忽略。
2. **备份与冻结映射**：验证可恢复备份；分配 migration_id、source schema/content fingerprints、transform_version、workspace/ID 映射。所有源中密钥与 private gold 按敏感制品处理。
3. **分块转换与回填**：从一致快照导出；为每块固定 logical key、顺序、行数和 hash，目标事务批次/CH 幂等实体键分别核对；保存完成检查点。失败只重放未确认块。异常行包含来源表/行定位和原因，原值留私有隔离制品。
4. **增量追平**：旧系统仍在写时必须先实现可靠应用 outbox/变更日志（含 DELETE），或停写后重新完整快照。仅按 updatedAt 扫描不能发现硬删除，也不能作为完整 CDC。不能仅靠当前只读导出工具声称支持在线增量。
5. **影子验证**：按工作区、ID、父子树、事件/正文 hash、有效评分、版本与权限核对；对未固定输入明确标记，记录转换差异而不伪造一致。
6. **短暂停写**：停所有实际写入进程和消费者，排空/冻结任务，记录最终 outbox 高水位，完成最终增量；撤销旧 writer epoch 与租约 fence。
7. **单写切换**：目标 schema/数据核对通过后切换部署 storage profile；CH 路由与资产 ID 保持稳定；旧库只读封存。
8. **观察与解封回退**：目标写入开始后必须保存可反向转换的变更日志/结果引用。回退先停写再迁移切换后增量、提升 writer epoch，并核对新建版本/删除；不能直接指回旧数据库丢掉新写入。不可反向表达的新模型阻止回退或使用已验证完整恢复方案。

## 5. 只读盘点与导出格式

`inventory_database(path)` 返回 format_version、source_schema_sha256、source_content_sha256、integrity_status、tables（按物理表名排序，含 columns、row_count、rows_sha256、classification）、schema_objects 和 unclassified_tables。不会返回原始行数据。

`export_database(path, output_dir)` 要求目标目录不存在；创建 mode 0700 目录，schema/分表 JSONL/manifest 文件 mode 0600，含备份级敏感数据。整个数据集从同一读取事务流式导出。Python 只保留当前行，不缓存全表；但单行本身（例如旧整段 Trace JSON）仍需驻留内存，SQLite 类型保真排序可使用临时磁盘，当前工具不宣称已实现超大单行分块转换或生产规模耗时上界。每表数据文件名使用序号和表名摘要，表名中的引号、斜线不能逃逸输出目录。

每个单元格使用带类型编码：null、integer（十进制字符串）、real（float.hex）、text、blob（base64）。列顺序固定，按全部字段的类型保真单元格编码由 SQLite 排序读取（可使用临时磁盘，Python 不缓存全表；区分正负零等原生等值）；同一表同一多重集合确定摘要，重复行保留次数。哈希按原始 UTF-8 JSONL 字节顺序计算，数值 1 与文本 "1" 不合并。根 source_content_sha256 同时绑定 source_schema_sha256 和按表排序的表名、完整有序列描述（列名、声明类型、NULL、默认 SQL、主键位置、hidden 标记）、行数、行字节摘要；因此清单中的列重命名/重排或类型/默认值损坏也会被检出。schema 对象按 type/name 排序并保存原始 DDL。

创建输出目录后 fsync 父目录，再开始导出写 `.incomplete` 标记；只有所有文件关闭、fsync 与目录落盘后，才原子发布含 status=complete 的 manifest 并移除标记。中断时保留不完整目录，不出现可用 complete manifest；工具拒绝覆盖该目录，重试使用新目录。`verify_export(directory)` 同时检查 complete manifest、无 incomplete 标记、schema/源指纹、每表行数/类型编码/字节摘要、文件清单；拒绝缺失、多余、软链接或路径穿越的表文件。提交标记移除失败时即使 manifest 已出现也判定未完成，必须使用新目录重导。校验用于完整性，不是密码学来源认证：trusted source fingerprint 应随受信迁移清单另行保存；攻击者同时篡改文件和全部摘要不由无签名自描述清单识别。导出不默认上传，不输出行值、凭据或原始异常内容；文件只放受信备份位置。

## 6. 交付证据与后续工作

本阶段测试：真实 SQLite 的读事务、已提交 WAL、字段/BLOB 类型、特殊标识符、坏 FK、未知表、目标目录碰撞、错误中断和权限。未实施目标导入、CDC、生产切换、PG/openGauss 的存量导出或真实客户库操作；这些仍是完整迁移的后续门禁。

## 7. 新核心 schema 的显式升级

`001_core.sql` 已交付后保持字节与摘要不变，IAM 使用追加 `002_iam.sql`。新目标初始化应用全部已知连续迁移；已存在的 001 目标保持可读可执行旧业务，不在 initialize 中静默升级。历史存在空洞、未来版本、文件不连续或已应用摘要漂移时拒绝写入。

SQLite 的 `migrate(backup_path=...)` 先以 SQLite backup API 创建不覆盖的 mode600 同目录备份，包含已提交 WAL；备份有时间预算和完整性/FK/逻辑指纹核查。随后 BEGIN IMMEDIATE 锁住源写入，再比较备份与源的逻辑根指纹，无漂移才在一个事务内应用所有待执行迁移。SQL 不能自行 COMMIT/ATTACH 等逃逸事务；任一步失败回滚全部待执行 DDL 和 schema_meta 记录，备份保留供核查。

PG/openGauss 必须使用显式 DSN 或连接工厂、隔离 schema 和私有制品目录。迁移计划只读；`source_evidence()`在一致性快照中生成数据库名/服务器地址端口、schema、完整迁移历史，以及全部托管表列元数据/行数/类型化内容根摘要。服务端 apply 要求私有备份文件及字节SHA-256、匹配的源证据、writers_stopped、operator、created_at_ms和restore_verified声明。迁移在首个MVCC快照之前取得schema_meta表级排他屏障，等待在途写事务提交后重核源证据；不同源、过期内容或介入写入均拒绝。DDL与版本登记同事务，顶层COMMIT/ROLLBACK/会话控制语句被拒绝，函数体内的BEGIN不受误判。

工具**不会自动执行pg_dump/gs_dump，也不能验证外部备份字节确实承载该源快照或仅凭restore_verified证明恢复成功**。正式部署仍须由运维停写、制作真实备份并完成恢复演练；测试里的外部备份fixture只验证证据门禁，不作生产恢复证明。

关系库适配器的业务写事务暂以schema_meta基础行锁跨进程串行协调（READ COMMITTED）；迁移另用上述表级屏障。只读请求使用REPEATABLE READ READ ONLY，SQLite使用WAL快照，均不取业务写锁；慢CH HTTP与密码派生在写事务外。此批保证领取/取消/续租/终态正确性，不是千级写吞吐实现。PG15.19及openGauss7.0.0 PG兼容模式已分别执行真实合同；openGauss原生SHA256使用官方Linux ARM64 Python驱动，不外推其他发行版或客户端认证组合。

003项目目录增量延续相同备份/锁源/回滚协议：旧workspace逐字保持并映射到default，不因新目录格式约束改变原ID；不回写原业务表或CH事实。当前总计33张事务表、13张CH表。旧Prisma原始导出仍保留原格式，之后目标转换显式使用default；不能把项目映射等同于已有96模型语义迁移完成。


## 离线旧库语义导入契约（第一版）

`legacy_import.py` 在已校验的私有原始导出之上提供独立 `plan-legacy-import`、`apply-legacy-import`、`verify-legacy-import`；原 `plan-legacy` 仍为严格只读诊断，不放宽未知列、所有权或资产缺失门禁。固定转换器目录覆盖 96 个旧模型；这表示模型有明确处理入口，不表示任意旧行、所有客户库或生产切换已验收。无新增迁移 DDL，复用 `migration_checkpoints`、`inbox_receipts`、现有私有制品与各领域真实表；当前目录的总表数由正式表字典统计。

三个命令均要求 `--directory`、稳定 `--source-id`、`--bindings-file`、显式隔离目标 `--config`；apply/verify 还要求 `--actors-file` 与 `--migration-id`。源导出、目标配置、主体映射、凭据必须是受信私有文件。命令不寻找默认旧库、不初始化业务服务、不执行生产切换。可用 `--model` 明确选择部分模型，但部分范围永不代表全库迁移完成。用户先通过正式 IAM 建立真实 principal/workspace，再将旧用户名显式映射；null/未知/歧义 owner 使用 `--row-bindings-file` 按稳定实体键映射，不能按名称猜归属。旧 User API key 仅在私有原始制品留档，目标使用明确提供的当前 API 凭据；不会激活旧密码或旧 key。

实体身份是 `source_id + 物理表 + 带类型主键` 的 SHA-256，正文摘要只用于版本/收据。迁移 ID 固定源快照和映射/文件清单；每行领域写入、私有原始行、检查点和成功收据在同一事务提交。CH 未索引时保留 pending 检查点，重试核验实际目标后才完成收据。重放相同内容幂等；同实体内容变化、目标被用户修改、碰撞或证明缺失明确 Conflict，不覆盖目标。verify 检查真实目标字段/修订、私有字节摘要、当前 IAM、关联及可读事实，而非只数导出行。

Trace 使用实际采集领域和事实流水；保留旧 Execution/Session/子 Agent/Thread/Skill origins/手工字段、原日期与业务 ID。原 Session 字符串及 Node JSON 语义保留，只有 Session 的记录不伪造 Execution。评估器、数据集、Skill 版本进入真实 private/public release、alias 和正文/附件制品。`--files-file` 以实体键提供 base64 字节；`--skill-directories-file` 只读取显式提供的目录并捕获实际字节/模式，不把旧路径当正文；缺文件、软链接、不安全路径或 hash/size 不符拒绝。只有没有外部 assetPath 且文件声明为空或仅根 `SKILL.md` 的纯正文版本可以由真实 SQL content 生成该文件。诊断消息相同时间戳不能推断先后，需 `--message-order-file` 按 sessionId 提供完整 message ID 顺序。

历史 running/pending/busy、控制凭据/命令、基础设施来源、实验、Benchmark job、诊断/报告和生成任务必须 inert：原状态/时间保持，历史租约无执行权，不发模型、worker、采集或外部任务。未整合并验证运行门禁时 `HISTORY_FENCE_VERSION=0`，相关行在 plan 中明确阻断；只有集成验收后才能提升门禁版本。历史 DatasetGenerationJob 存在固定私有历史目录而不进入可领取队列；进度/原 receipt 可以读取，显式删除仍按当前 IAM 作用于真实数据集。Usage raw 仅导原始事件和永久去重收据，Daily 直接导原 count/first/last，不由 raw 二次累计。评测写真实 machine receipt/selected result/human annotation，迁移 work phase=migrate 且终态，不伪造有效评估租约。

旧诊断可只读；显式复测须有 verified 导入收据、原 snapshot 字节、仍一致的真实 Trace/Session、实验/结果、数据集/评估器及 Skill 正文基线，并再次通过当前 IAM。核验从当前真实证据重建快照与旧快照逐项比较；缺证据或来源变化 Conflict，不能臆造旧模型证明。通过后冻结当前真实新模型和新资产，创建全新复测实验/RunPlan，保留历史 diagnosis ID/inputHash origin；绝不恢复旧 lease 或修改旧运行。内部 historical 标志由 Node 消费后剥离，不改变原前端 DTO/界面。

本模块开发快检使用全新临时 SQLite 与内存事实，覆盖重放、目标漂移、事务中断恢复、真实领域读回、历史不执行及来源变更拒绝。三库原生、真实 ClickHouse、原界面和完整旧数据迁移演练由整合阶段集中验收；这些检查未完成前，任何输出的 `production_cutover_ready` 均为 false。
