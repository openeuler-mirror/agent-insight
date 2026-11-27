# Trace Bundle 导入导出：开发计划

## 阶段一：契约与纯逻辑

- 新增 Trace Bundle 类型、格式校验、父子拓扑校验。
- 新增统一 identity 冲突映射和 interactions Session 引用重写。
- 为无冲突、局部冲突、嵌套树和原始 span ID 保留补单测。

## 阶段二：服务与 API

- 实现 root Trace 树导出。
- 实现归属校验、导入写入、ExecutionSkill 重建和失败回滚。
- 新增 export/import API 路由。

## 阶段三：页面

- 改造详情页“保存 trace”。
- 在列表页右上角增加“导入 Trace”。
- 增加成功摘要 Dialog、错误提示和列表刷新。

## 阶段四：验证与文档

- 运行 Trace Bundle 聚焦测试、`npm run test`、`npx tsc --noEmit`、`git diff --check`。
- 更新用户指南、开发指南 API/数据流说明。
- 浏览器 golden path 与边界场景按用户确认后执行。
