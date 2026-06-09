# AgentDebug 与 Skills 分析并行化开发计划

## Phase 1: 独立存储

1. 在 `prisma/schema.prisma` 增加 `AgentDebugSkillsAnalysis` model。
2. 在 `report-store.ts` 增加建表、查询、running/done/failed upsert、删除函数。
3. 移除 `updateAgentDebugSkillsAnalysis` 对 `AgentDebugReport.reportJson` 的写入语义。

## Phase 2: API 解耦

1. 主诊断 API 不再读取或合并 `reportJson.skillsAnalysis`。
2. Skills 分析 API 不再要求主诊断报告存在。
3. Skills 分析 API 增加 GET，用于前端独立轮询。
4. 删除旧嵌入数据读取路径。

## Phase 3: 前端并行显示

1. `AgentDebugCard` 增加独立 `skillsAnalysis` state。
2. 点击启动或重新诊断时同时触发两个 POST。
3. 主诊断完成后立即渲染主诊断卡片。
4. Skills 分析完成后独立刷新 Skills 区块。
5. 文案从“保存到当前 AgentDebug 诊断报告”调整为“保存到 AgentDebug Skills 分析缓存”。

## Phase 4: 文档与验证

1. 更新用户指南中的智能诊断流程说明。
2. 更新开发者指南中的数据模型、API 契约和数据流说明。
3. 跑类型检查和测试。
4. 询问是否启动 dev server 做浏览器 golden path 验证。

