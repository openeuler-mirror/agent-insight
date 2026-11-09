# 评测 → 智能诊断 → Skill 优化：需求设计

## 交互

沿用灰阶、indigo 交互主色及共享 UI 组件。原型中的红框只用于评审标注，不作为产品默认样式。

| 位置 | 按键 | 行为 |
| --- | --- | --- |
| Case 详情结果区 | 用于智能诊断 | 打开输入确认；默认推荐 fail/warn，但允许用户选择 pass 结果 |
| 诊断输入确认 | 开始诊断 | 展示所选评测、被测 Trace、Skill 版本，创建后台 run |
| 诊断结果区 | 用于 Skill 优化 | 导入勾选发现，选择一个目标 Skill 和基线 |
| 优化输入区 | 生成优化计划 | 合并同类发现，保留证据；冲突条目需仲裁 |
| 优化计划区 | 确认计划并生成候选 | 使用现有优化器生成候选与 Diff |
| 候选结果区 | 按原实验配置复测 | 创建独立复测实验，不覆盖原结果 |

每页显示来源链与回溯入口。生成、复测、发布分开操作；仅满足现有验证门槛才能发布。无可导入发现时禁用并说明原因。运行失败保留输入并提供重试，过程片段不视作最终报告。

## 数据流

ExperimentEvalResult + 被测执行 attempt → 服务端快照 → DiagnosisRun → 用户筛选 Finding → OptimizationInput → SkillOptPlan → 候选 Diff → 原配置复测 → 用户确认发布。

前端只提交标识与用户选择。后端校验归属、状态、Case/experiment/trace 一致性后加载原始数据；URL 不携带完整报告。评分、日志、Skill 内容属于分析资料，不提升为工具执行指令。

## 拟新增模型（未修改 Prisma）

推荐新增 `DiagnosisRun`，不破坏现有仅 Trace 的 AgentDebugReport 行为。新旧入口共用诊断执行内核，新入口使用独立 run 存储。

字段：id、user、experimentId、caseId、executionId、attemptId、inputHash、inputSnapshotJson、generatorVersion、status、reportJson、errorMessage、createdAt、completedAt。run 状态为 pending/running/done/failed；inputSnapshotJson 为不可变快照，reportJson 完成后不可改写。重试创建新 run 并记录 retryOfRunId。另存客户端 requestKey，用 `(user, requestKey)` 唯一约束保证幂等；内容缓存按 user + inputHash + generatorVersion 查找已完成 run，显式重跑可绕过内容缓存。并发领取与完成使用状态条件更新，避免迟到任务覆盖新结果。

输入快照 schemaVersion=1：
- 来源：experimentId、caseId、resultIds、各结果 updatedAt、attemptId / attemptNo、executionId、traceHash。
- 评测：任务输入、预期/实际输出、评估器标识及配置快照、机器 score/verdict、人工 humanScore/humanReason、points/evidence；无分数保留 null，不补零。
- 运行：被测 Agent、模型、数据集版本、执行配置、Skill name/version/contentHash（缺失显式 null）。
- 完整性：缺失项、截断标记、完整证据引用；以规范化内容计算 inputHash，包含人工修正、配置及诊断生成器版本。

诊断输出扩展：findingId、summary、rootCauseCategory、evidenceRefs、correctionGuidance、confidence、skillTargets[]、optimizationEligibility、exclusionReason。evidenceRefs 区分评测结果、Trace 节点和 Skill 文件锚点。模型置信度仅作提示；无证据或无 Skill 关联时标记待确认，不将分数等同确定性。诊断允许得出评估器错误或标准冲突的结论。

优化侧扩展 sourceKind 为 diagnosis，sourceRefsJson 保存 diagnosisRunId、inputHash、findingIds、证据摘要、Skill 基线哈希与原实验引用。拟为计划条目补充 sourceRefsJson，避免把 diagnosis finding ID 冒充 SkillIssue ID。由适配器把最终发现转为已有 plan 的 title/rationale/targetFile/anchorText/proposedEdit；不伪造 Evaluation。

## 数据库无损升级与历史兼容

### 范围与原则

首期采用增量扩展：新增 DiagnosisRun，为 SkillOptPlanItem 增加带默认值 `[]` 的 sourceRefsJson；保留既有 AgentDebugReport、SkillIssue、计划、优化记录、会话及其关联。新来源 diagnosis 仅写入新建的诊断来源任务，不批量改写原有 sourceKind。首期不删除表或列、不改变既有主键、不收紧旧数据约束、不做清理或去重。若实际迁移工具需要重建表，必须审查显式列映射及索引、外键、触发器保留情况，并以逐字段对账证明旧数据完整保留。

旧诊断报告继续由旧存储路径读取，不自动转成带评测上下文的 DiagnosisRun。用户主动从历史报告创建优化输入时，服务端验证归属并冻结当时可取得的最终报告内容，标记 legacy 来源和缺失项；无法恢复当时的评测快照、Skill 版本或内容哈希时保留未知，不能用当前数据冒充历史事实。首期不依赖全量历史回填；未来确需回填时另给可审计映射、幂等与恢复方案。

### 迁移执行契约

1. **定位与预检**：解析部署实际 DATABASE_URL、数据目录及外部资产路径，核对数据库版本、表结构、记录数、磁盘空间和存量完整性问题。不得假设仓根 data 是正在使用的数据目录。发现不支持的结构、异常或容量不足即停止，既有异常单独记录，不静默删除数据。
2. **一致性备份**：在维护窗口暂停业务写入、后台任务、导入和客户端上报；待在途写入结束后，使用 SQLite backup API / `.backup` 生成一致性副本，并备份相关 Skill 文件和报告资产。WAL 模式下不能只复制正在写入的 `.db` 文件。记录备份校验值、应用版本、schema 和资产清单，并验证副本可打开、可恢复。备份含业务数据，不提交到仓库或附带导出密钥。
3. **副本演练**：在隔离副本执行与部署完全相同的版本化迁移脚本。先完成 schema 扩展及校验，再切换应用；使用迁移锁防止多实例并发。重复执行应识别已完成版本并安全跳过；部分失败应回滚事务或按检查点恢复，不能继续启动不匹配的应用。
4. **部署与验收**：真实库迁移期间保持写入暂停。按迁移前快照逐表比对原有主键集合和全部原有字段，包括 JSON 原文、null、评分、人工修正、时间戳、报告、版本与关联；新增字段单独核对默认值。检查行数、确定性内容摘要、索引/唯一约束、`PRAGMA integrity_check` 和 `foreign_key_check`，并验证旧业务读取与关联资产。对已有异常要求明确基线与处理结论，不能以“没有新增异常”掩盖未评估问题。
5. **放行条件**：数据核对、历史业务冒烟、迁移重复执行和恢复演练全部通过后恢复写入并启用新功能；任何未解释的数据差异都阻止放行。

### 当前启动方式的约束

当前 `scripts/develop_start.sh` 存在启动前 schema 同步及历史预处理；`scripts/create_migration_package.sh` 使用仓根 data 路径且带有直接复制回退，不能直接视为本次生产迁移方案。实现时需提供经审查的明确迁移入口并核验启动全过程，禁止 `migrate reset`、`--force-reset`、`--accept-data-loss` 或默认确认重置数据库。启动遇到可能丢数的 schema 差异应停止，不允许自动放行。若需要调整启动脚本，需按仓库流程单独对齐；本轮仅记录设计约束。

### 回滚与兼容窗口

优先关闭新入口、停止相关写入并回退到经过验证的兼容应用版本，保留新增表列及已产生的新数据。兼容版本必须能读取旧数据、容忍新增来源，并且不能在启动时将扩展后的 schema 同步回旧结构。不能把“旧代码还能启动”当作已验证兼容。

迁移后尚未恢复写入时，可停服务后按演练流程恢复一致性备份及匹配资产；恢复时正确处理 SQLite WAL/SHM，禁止直接覆盖一个仍被打开的数据库。已经恢复写入后，不得直接用旧备份覆盖数据库丢弃新增数据；先冻结写入并备份当前状态，选择前向修复，或制定已验证的增量保全与合并恢复方案，核对完成后再开放。回滚验收同时覆盖迁移前历史数据和启用功能后新增数据。

## 拟新增 API（接口契约）

| 接口 | 输入 / 输出 |
| --- | --- |
| POST /api/experiments/:id/cases/:caseId/diagnoses | resultIds、attemptId、requestKey → 202 {runId,status}；可复用时返回已有 run |
| GET /api/diagnosis-runs/:runId | 输入摘要、状态、过程和最终报告 |
| POST /api/skills/by-name/:name/diagnosis-inputs | runId、findingIds、baseVersion、expectedContentHash、requestKey → 优化输入/会话引用 |

第三个接口只创建优化输入，生成计划与候选继续走现有优化流程。鉴权身份取可信会话，不信任 body.user。校验 Skill、实验、报告属于可访问范围；不匹配返回 409，缺少 Trace / 不可用发现返回 422，未授权按统一约定返回 403/404。

## 任务与缓存

复用后台并发限制及进度事件，新增 runId 隔离记录；进程重启后将遗留 running 标记 interrupted/failed 并允许重试，不承诺自动恢复。诊断本体和 Skills 核验均须核对各自输入哈希，避免混用不同输入的缓存。优化导入保存发现快照，不能依赖后续会被覆盖的报告。

## 关键边界

- 无被测 Trace：首期显示「缺少执行证据」，禁用开始诊断；后续结果级诊断须独立标识能力边界。
- 评估器运行 failed 与业务 verdict=fail 分开；前者不能当成任务质量失败证据。
- 多 attempt：固定用户选择且可用的执行，不能自动选无关“最新 Trace”。导入型评测没有 ExperimentTraceAttempt 时，从 ExperimentCase.executionId 解析被测执行，attemptId 允许为空并记录来源类型；不能伪造 attempt。
- 版本变化：默认使用执行时版本；切换到新版本须重新核验锚点与冲突，不能静默重定位。
- 环境/权限/网络错误：默认排除优化；存在独立可改进的容错 Skill 规则时，允许用户明确选入有依据的规则建议。
- 来源删除：保留必要的不可变快照及失效提示，来源链接不可用不改变历史事实；执行既有数据保留/删除策略。
- 大报告：分段读取与摘要限额，保留证据定位和截断标记，不把完整日志一次塞进上下文。
- 候选回归：来源失败例用于定向复测，另加入通过例作回归检查；配置不同不展示误导性提升结论。
