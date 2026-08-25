# Skill 工作台重构：开发计划

> 当前状态：Phase A–G 已实现并完成专项自动化验证；Phase H 已完成入口与文档切换，浏览器 golden path 仍需用户确认启动本地开发服务后执行。

## 总体策略

采用“新增旁路 → 复用内核 → 自动化回归 → 浏览器验收 → 最后切流”的顺序。每一批必须保持旧入口和旧 API 可用；发现需要破坏旧契约时停止该批次，改用适配层或单独对齐设计。

## Phase A：领域基础与安全边界

1. 在 Prisma 中新增 `SkillWorkbenchSession`、`SkillWorkbenchMessage`、`SkillWorkbenchTask`、`SkillOptimizationRecord`。
2. 为 `Experiment` 增加可空的预设、Skill 上下文、配置快照和来源关联字段。
3. 运行 `npx prisma generate`；使用无数据丢失的 `prisma db push` 流程验证增量 schema。
4. 新增 `src/lib/skill-workbench/`：领域类型、状态机、序列化、幂等键和权限解析。
5. 新增状态机与兼容性单元测试。

完成条件：旧 Prisma 模型、旧 API 和现有测试不需要修改即可继续运行。

## Phase B：旁路工作台骨架

1. 新增 `src/app/(main)/skill-workbench/page.tsx`，暂不加入侧栏。
2. 新增 `src/components/skill-workbench/`，拆分为 Shell、Copilot、WorkspaceTabs 和 ContextProvider。
3. 实现空会话、三个准备入口、工作版本卡和四个空态页签。
4. 新增会话 BFF，支持创建、列表、恢复和 activeView 更新。
5. 所有样式只使用共享设计令牌。

完成条件：直接访问 `/skill-workbench` 可恢复会话；旧 `/skills` 页面无代码行为变化。

## Phase C：Skill 管理中心与详情

1. 新增 `/api/skill-management/skills` 服务端搜索、筛选和 9 条分页。
2. 抽取可复用的 Skill 卡片和版本选择器，不直接嵌入旧 `SkillCatalogV2` 巨型页面。
3. 新增旁路 `/config/skills-preview` 或仅在工作台选择弹窗中使用管理中心组件；正式 `/config/skills` 留到切流阶段。
4. 接入现有 Skill 文件读取、文件树、预览和下载能力。
5. 验证跨页搜索、筛选和版本选择。

## Phase D：生成、上传和工作快照

1. 为现有生成 bridge 增加工作台适配器，保留旧 `/api/skill-generator/chat` 契约。
2. 统一消息 block 映射，不复制 Agent 执行逻辑。
3. 新增工作台上传解析服务；只写会话文件快照，不调用旧上传即发布路由。
4. 新增从工作快照发布 `v0`/新版本的确认服务。
5. 验证上传解析失败、同名版本冲突和重复点击。

## Phase E：共享静态质量评估

1. 从现有 `runStaticEvaluation` 抽取文件快照入口，旧函数变为兼容包装器。
2. 工作台评估任务返回 202 和 task/evaluation 引用，前端轮询进度。
3. 生成与优化在候选阶段调用同一质量入口。
4. 上传内容不自动评估；旧 `/api/skills/upload` 继续保持旧行为，避免回归。
5. 验证模型未配置、部分失败、重试、内容变化和历史结果不覆盖。

## Phase F：统一 Skill 实验

1. 抽取通用实验创建服务，使旧 `/api/experiments` 与工作台 BFF 复用同一校验和落库逻辑。
2. 增加 `trigger`、`use-case`、`skill-ab` 三种预设转换器。
3. 保存完整配置快照和 Skill 版本上下文。
4. 触发用例编辑器仅保留输入和应触发/不应触发。
5. A/B 向导只开放 Skill 版本变量。
6. 工作台实验详情复用现有进度与结果组件；工作台与全局实验列表按 `scope` 隔离。

## Phase G：候选版、复测和发布

1. 优化 bridge 结果写入 `SkillOptimizationRecord`，不调用旧 apply 路由。
2. 保存候选文件、Diff、证据、静态质量结果和实际状态。
3. 实现复制原实验快照的复测服务。
4. 复测完成后计算真实前后差异；失败、取消、部分完成不宣称提升。
5. 发布接口要求 `retest_passed`、二次确认和版本冲突检查。
6. 发布只追加正式 `SkillVersion`，保留候选和优化记录。

## Phase H：切流与文档

1. 在用户确认后启动 `bash scripts/develop_start.sh`。
2. 浏览器验证 golden path：生成或选择 Skill → 评估 → 实验 → 优化 → 复测 → 发布。
3. 验证至少一个边界场景：重复点击、评估失败、无原实验、复测失败或版本冲突。
4. 运行 `npm run test`，并补充工作台定向测试。
5. 更新 `docs/user-guide/skills/`。
6. 更新开发者指南的架构、模块、API、数据流和前端页面，并刷新 provenance commit。
7. 将 Skill Hub 迁到 `/config/skills`，再把 `/skills` 切到工作台。
8. 为旧入口添加兼容跳转；不删除旧代码和旧表。

## 非回归测试矩阵

| 范围 | 必测内容 |
|---|---|
| Skill 管理 | 旧列表、详情、版本下载、上传和激活保持原行为 |
| Skill 生成 | 旧生成会话、流式 blocks、附件、下载和发布测试 |
| 静态评估 | 旧 evaluate/summary API、L1+L2 结果和历史查询 |
| 触发分析 | 旧数据集 CRUD、运行、取消和历史结果 |
| A/B | 旧 GrayscaleTask 创建、执行、重试、评分和 backing Experiment |
| 通用实验 | 创建/运行事务、已有 Trace、生成 Trace、FI、重试和详情聚合 |
| Skill 优化 | 旧会话、计划、草稿、自验证和 apply 路由保持通过 |
| 新工作台 | 会话恢复、上下文一致、幂等任务、候选状态机、复测与发布 |

## 回滚策略

- 切流前：不暴露 `/skill-workbench` 导航即可回滚，新表和可空字段可保留。
- 切流后：把侧栏和 `/skills` 页面恢复到旧 Hub；新工作台数据不影响旧模型读取。
- 不通过删除表、删除字段或重置数据库回滚。

## 每批交付格式

每批完成后报告：改动范围、未触碰范围、自动化测试、未验证项、下一批风险。未完成浏览器验收时必须明确说明“未在浏览器中验证”。
