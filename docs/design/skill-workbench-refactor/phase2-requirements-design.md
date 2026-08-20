# Skill 工作台重构：需求设计

## 1. 设计真源与优先级

发生冲突时按以下顺序处理：

1. 本文和原始 phase2 产品设计中的业务规则、状态机与验收口径。
2. `Skill对话工作台-高保真.html` 的布局、交互状态和视觉参考。
3. 现有代码的可复用实现方式。

例如，高保真局部仍出现“注册 Skill”，产品统一使用“发布为新版本”；高保真静态评估使用三段演示进度，实现应覆盖产品设计要求的完整检查阶段。

## 2. 信息架构与路由

### 2.1 开发期旁路

| 路由 | 开发期职责 | 是否影响旧功能 |
|---|---|---|
| `/skill-workbench` | 新工作台开发与兼容入口 | 否，正式导航使用 `/skills` |
| `/skills` | 现有 Skill Hub | 保持不变 |
| `/skill-generator` | 现有生成页 | 保持不变 |
| `/skill-eval` | 现有分析页 | 保持不变 |
| `/skill-opt` | 现有优化页 | 保持不变 |
| `/experiments` | 全局实验中心 | 保持不变 |

### 2.2 验收后目标

| 路由 | 目标职责 |
|---|---|
| `/skills` | Skill 工作台 |
| `/config/skills` | Skill 管理中心 |
| `/skill-workbench` | 兼容呈现与 `/skills` 相同工作台 |
| 旧 Skill 深层链接 | 保留兼容或带上下文跳转到工作台对应页签 |

## 3. 页面结构

工作台分为左右两个独立滚动区域：

- 左侧 Skill Copilot：当前 Skill/版本、历史会话、新对话、消息、任务节点、结果卡和输入工具。
- 右侧工作区：Skill 详情、Skill 评估、Skill 实验、优化记录四个固定页签。

工作台根组件只管理会话和工作上下文，不直接包含生成、评估或实验引擎逻辑。每个页签通过领域适配器读取同一 `SkillWorkbenchContext`。

## 4. 工作台上下文

```ts
interface SkillWorkbenchContext {
  sessionId: string;
  skillName: string | null;
  workVersion: number | null;
  source: 'generated' | 'uploaded' | 'management' | null;
  activeView: 'detail' | 'evaluation' | 'experiment' | 'optimization';
  stage: 'empty' | 'preparing' | 'ready' | 'busy';
}
```

约束：

- 对外 Skill key 始终使用 `name`，`id` 仅在服务端内部解析。
- 切换工作版本必须原子更新四个页签上下文。
- 恢复会话只恢复状态，不触发副作用。
- 同一会话进入任一准备流程后，不再显示三个初始入口。

## 5. 持久化设计

所有变更均为增量模型，不修改旧模型的字段语义。

### 5.1 SkillWorkbenchSession

统一保存用户上下文：

- `id`、`user`、`title`。
- `skillName?`、`workVersion?`、`source?`。
- `activeView`、`stage`。
- `filesJson`：尚未发布的工作文件快照。
- `generatorSessionId?`、`optSessionId?`：兼容调用旧 Agent 会话的内部引用。
- `createdAt`、`updatedAt`。

### 5.2 SkillWorkbenchMessage

- `sessionId`、`role`、`content`、`blocksJson`。
- `taskId?`：将任务进度或结果卡关联到确定性任务。
- 消息仅负责展示；领域真状态不能只存在消息文本中。

### 5.3 SkillWorkbenchTask

统一表示用户明确启动的任务：

- `type`：`evaluation | experiment | optimization | retest | publish`。
- `status`：`pending | running | done | failed | cancelled`。
- `idempotencyKey`：阻止重复点击创建重复任务。
- `progressJson`、`resultType?`、`resultId?`、`errorMessage?`。
- 任务状态映射领域对象，但不复制完整领域结果。

### 5.4 SkillOptimizationRecord

一次优化的完整证据链：

- `sessionId`、`user`、`skillName`、`baseVersion`、`candidateVersionLabel`。
- `candidateFilesJson`、`candidateContentHash`、`summary`、`diffJson`。
- `sourceKind`、`sourceRefsJson`。
- `staticEvaluationId?`、`sourceExperimentId?`、`retestExperimentId?`。
- `status`：`optimizing | pending_retest | retesting | retest_passed | retest_failed | retest_cancelled | published | abandoned | optimization_failed | optimization_cancelled`。
- `publishedVersion?`、时间字段和错误信息。

候选内容保存在优化记录中，不写 `SkillVersion`。发布成功后只追加 `publishedVersion`，优化记录和候选快照继续保留。

### 5.5 SkillSnapshotEvaluation

现有 `Evaluation.skillId` 强制关联正式 `Skill`，不能承载生成/上传/优化阶段的未发布候选。为避免“为了评估而提前发布”，新增独立快照评估记录：

- 关联 `SkillWorkbenchSession`、`skillName`、候选版本标签和 `contentHash`。
- 保存共享静态质量服务的状态、维度分数、问题列表、错误和耗时。
- 发布后不迁移或删除该记录；正式版本后续评估仍写既有 `Evaluation + SkillIssue`。
- `SkillOptimizationRecord.staticEvaluationId` 可引用正式评估或快照评估，调用方通过任务 `resultType` 区分。

### 5.6 Experiment 增量字段

为统一 Skill 实验增加可空字段：

- `preset?`：`trigger | use-case | skill-ab | retest`。
- `skillContextJson?`：参与实验的 Skill 名称与版本。
- `configSnapshotJson?`：Agent、运行目标、模型、数据集、Case 顺序、评估器、超时和重试等冻结配置。
- `sourceExperimentId?`：复测来源。
- `optimizationRecordId?`：复测与优化记录关联。

旧实验不填写这些字段，原列表、详情和执行逻辑不受影响。

## 6. API 边界

新 API 使用独立前缀，避免改变旧路由契约：

| API | 职责 |
|---|---|
| `/api/skill-workbench/sessions` | 会话列表与创建 |
| `/api/skill-workbench/sessions/:sessionId` | 会话恢复与上下文更新 |
| `/api/skill-workbench/sessions/:sessionId/generation` | 创建/同步已有生成 Agent 会话 |
| `/api/skill-workbench/sessions/:sessionId/optimization` | 创建/同步已有优化 Agent 会话 |
| `/api/skill-workbench/sessions/:sessionId/upload` | 解析并保存未发布上传快照 |
| `/api/skill-workbench/sessions/:sessionId/publish` | 质量门禁后确认发布生成/上传快照 |
| `/api/skill-workbench/sessions/:sessionId/tasks` | 确定性任务创建与幂等控制 |
| `/api/skill-workbench/skills/:name/versions/:version/evaluations` | 启动/查询静态评估 |
| `/api/skill-workbench/skills/:name/experiments` | 按预设创建 Skill 实验 |
| `/api/skill-workbench/skills/:name/trigger-datasets` | 生成可编辑、可切换正反例的触发数据集 |
| `/api/skill-workbench/skills/:name/optimizations` | 创建和读取优化记录 |
| `/api/skill-workbench/skills/:name/optimizations/:recordId/retest` | 复制原实验快照复测 |
| `/api/skill-workbench/skills/:name/optimizations/:recordId/publish` | 二次确认并发布正式版本 |
| `/api/skill-management/skills` | 管理中心搜索、筛选和每页 9 条分页 |

路由层只做鉴权、校验和序列化；领域操作放入 `src/lib/skill-workbench/`，供新 BFF 直接调用现有引擎，避免服务端内部 HTTP 转发。

## 7. Skill 准备

### 7.1 生成

- 初始消息只能表达中性生成意图。
- Agent 至少澄清目标、输入输出、适用/不适用场景和安全约束。
- 生成产物先写会话文件快照。
- 共享质量服务对快照执行质量契约；通过后才展示可发布结果。
- 新 Skill 首次发布为 `v0`，必须由用户确认。

### 7.2 上传

- 解析失败时保留上传错误，不创建版本。
- 文件保持原样，不自动调用静态评估。
- 新 Skill 工作版本为 `v0`；同名 Skill 使用最新版本加一作为候选标签。
- 用户确认发布前不激活或覆盖现有版本。

### 7.3 管理中心选择

- 同时选择 Skill 和版本。
- 每页 9 条，搜索和筛选在服务端分页前执行。
- 选择后返回工作台并原子更新会话上下文。

## 8. 统一质量服务

现有静态评估器重构为两个层次：

1. `evaluateSkillSnapshot`：接受文件快照、内容 hash、用户与触发来源，执行共享质量规则。
2. `runStaticEvaluation`：保留旧签名，加载 `SkillVersion` 后调用共享快照层，保证旧 API 行为兼容。

生成和优化调用快照层；用户上传或管理中心版本通过工作台任务启动。进度至少包含：读取校验、结构与描述、流程与安全、汇总结果。最终结果仍落 `Evaluation + SkillIssue`，并绑定版本或内容 hash。

## 9. 统一 Skill 实验

### 9.1 适配原则

- `Experiment` 继续作为执行、Case、结果和详情的唯一真源。
- 工作台预设只负责默认配置和 Skill 上下文，不复制运行引擎。
- Skill 实验与全局实验复用执行内核和 `Experiment` 数据模型，但按 `scope` 隔离列表；全局实验中心不读取工作台创建的触发分析、用例分析、Skill A/B 或候选复测。
- 生成、评估、实验、优化与复测一旦被服务端接受，不得依赖当前页面连接继续执行；站内切页只停止实时订阅，返回后从持久化任务和结果恢复。

### 9.2 三种预设

- 触发分析：使用应触发/不应触发数据集和触发类评估器。
- 用例分析：使用标准任务效果实验配置。
- Skill A/B：仅允许两个 Skill 版本，不展示 LLM 或框架对比。

现有 `SkillTriggerEvalSet/Run`、`BatchEvalTask` 和 `GrayscaleTask` 首期保留。新实验通过适配器复用其已验证的准备逻辑，但新记录必须落标准 Experiment；旧历史通过兼容查询展示。

### 9.3 复测

复测读取 `sourceExperiment.configSnapshotJson` 创建新 Experiment：

- 保持 Agent、运行目标、模型、数据集、Case 顺序、评估器、门禁、超时、重试和统计口径。
- 唯一主动替换变量为候选 Skill 快照/版本。
- 原实验不可修改，新实验通过 `sourceExperimentId` 关联。

## 10. 优化与发布状态机

```text
optimizing → pending_retest → retesting → retest_passed → published
                           │           ├→ retest_failed
                           │           └→ retest_cancelled
                           └→ abandoned
optimizing → optimization_failed / optimization_cancelled
```

规则：

- 优化依据必须保存为具体评估、实验或用户要求引用。
- 候选生成后不自动复测。
- 复测前候选运行指标一律显示“待复测”。
- 只有真实复测结果可以计算提升、回归和门禁结论。
- 只有 `retest_passed` 才展示发布主操作；服务端发布接口仍重新校验记录状态和版本冲突。
- 发布追加不可变 `SkillVersion` 并切换工作版本，不删除优化记录或候选快照。

## 11. 并发与幂等

- 相同会话、任务类型和目标快照使用唯一 `idempotencyKey`。
- 运行中的重复请求返回原任务，不创建副本。
- 发布前重新读取最新 Skill 版本；版本号冲突返回 409，要求用户确认新的版本号。
- 复测与原实验通过不可变快照关联，配置页面的后续修改不影响运行中任务。

## 12. 兼容与切流

1. 新模型与新 API 上线，旧功能不读取新字段。
2. 新工作台在 `/skill-workbench` 完成开发和验收。
3. 为旧历史增加只读兼容适配器。
4. 全量测试通过后，将现有 Skill Hub 页面移动到 `/config/skills`。
5. `/skills` 切换为工作台；旧入口根据可表达的上下文跳到对应页签，否则保留原页面。
6. 至少一个稳定版本后再评估删除旧 UI；本需求不执行删除。
