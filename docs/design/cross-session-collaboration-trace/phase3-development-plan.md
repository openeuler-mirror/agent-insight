# 跨 Session 协作 Trace：开发计划

## 1. 通用后端

- 扩展 Prisma：Collaboration、CollaborationEvent、CollaborationEndpointResolution。
- 实现严格事件契约、规范化 hash、幂等落库与冲突返回。
- 实现端点精确解析、工具/Shell 候选和有条件的组内时间排序。
- 增加 ingest、列表、详情和重算 API。

## 2. Goal Plus 适配

- 新增内部 Goal Plus projector 与稳定 ID 构造。
- 在语义 ingest、手工 relink 和 Execution 保存后的既有关联流程中触发投影。
- 多主会话保持 ambiguous；缺少 Trace 保持 pending；旧派生端点标记 superseded。
- 每个投影调用独立捕获异常，验证不影响双通道原始采集。

## 3. 验证

- 契约：严格字段、长度、日期、定位器和稳定 hash。
- 幂等：同 eventId 相同正文、正文冲突、并发唯一约束。
- 解析：晚到 Trace、重复 Session ID、候选/歧义/time_ordered。
- Goal Plus：一个主 Trace 对多个 worker、多主会话、不重复投影、Pi/Codex 混合、source/run 隔离。
- 回归：`npm run test`；浏览器验证需用户确认后启动开发服务。

## 4. 后续前端

本阶段只提供查询模型，不开放导航。后续协作图页面应明确区分 `confirmed`、`candidate`、`time_ordered`、`ambiguous` 和 pending，不把 Goal Plus 的“编排成员关系”文案显示成“确定的某次工具调用”。
