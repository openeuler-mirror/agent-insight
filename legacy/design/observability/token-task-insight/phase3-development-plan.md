# Token 与任务分析：开发计划

## 改动清单

| 文件 | 说明 |
| --- | --- |
| `src/lib/task-insight/types.ts` | 分类、阈值、响应类型与六类任务定义 |
| `src/lib/task-insight/classify.ts` | 规则分类、长时判定、可延后判定 |
| `src/lib/task-insight/aggregate.ts` | 汇总、占比、时段、用户、调度建议与 Top 任务 |
| `src/app/api/observe/task-insight/route.ts` | 查询 root trace 并返回分析结果；参数校验与截断 |
| `src/components/task-insight/TaskInsightPanel.tsx` | 分析页面主体 |
| `src/app/(main)/task-insight/page.tsx` | 页面入口 |
| `src/components/shell/sidebar-navigation.ts` | 运行观测下新增入口 |
| `src/locales/zh.ts` / `src/locales/en.ts` | 导航文案 |
| `test/task-insight.test.ts` | 分类、长时原因、可延后与聚合回归 |
| `docs/zh/how-to/observability/token-task-insight.md` | 使用说明与口径 |

不新增依赖、不改 Prisma schema、不改 Agent 执行链路。

## 实施步骤

1. 先实现纯函数分类与聚合，用单测钉住六类分类、四个长时维度、实时词与可延后规则。
2. 再接 API：限定 root trace、时间范围、单次上限、阈值参数。
3. 最后接页面与导航，复用共享设计令牌和现有卡片/表格样式。

## 验证

- `node --import tsx --test test/task-insight.test.ts`
- `NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit -p tsconfig.json`（仓库存在既有基线错误，检查新增文件无报错）
- 浏览器验证：本次未执行；页面与 API 的真实 UI 走查待维护者确认后进行。

## 后续可扩展

- 引入基于真实分布的分位数阈值，减少固定阈值偏差。
- 按模型/Agent 维度拆分 token，并接入模型路由建议。
- 把可延后任务直接接入异步队列或夜间批处理（需另立需求）。
