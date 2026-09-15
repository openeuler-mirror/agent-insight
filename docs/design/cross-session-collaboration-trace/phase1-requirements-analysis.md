# 跨 Session 协作 Trace：需求分析

## 背景

平台已有 Execution 原生调用树，但一次协作任务可能由多个独立 Session 共同完成。Goal Plus 还同时拥有 `.gp` 语义状态和 Pi/Codex 原生 Trace：语义数据知道 Goal、Run、Candidate 与 worker 的成员关系，原生 Trace 则保存真实执行细节。两者不能互相替代。

## 用户问题

- 多个 Session 的 Trace 分散，无法从一个协作入口看到主 Session 与 worker 的关系。
- Trace 晚到、续跑或跨机器上传时，关系容易缺失。
- 工具名和时间只能形成候选依据，若直接写回 Execution 父子树会把推定伪装成事实。
- Goal Plus 已有采集器稳定运行，新增关系能力不能改变其原生 Trace 或 `.gp` 快照采集。

## 目标

1. 接收逐条跨 Session 关系事件，并按事件 ID 幂等保存。
2. 将事件端点独立解析到既有 Execution；Trace 晚到后可重算。
3. Goal Plus 在服务端从既有语义投影生成“逻辑主节点 → worker”关系，不新增采集通道。
4. 唯一主 Trace 时关联具体 Execution；多主会话或证据不足时保留关系并明确歧义。
5. 关系层不修改 Execution 的 `parentExecutionId`、`rootExecutionId`，不参与 Goal Plus 完整性或成败计算。
6. 上报内容复用 Goal Plus 脱敏能力；投影失败不阻断原始 Trace 或语义快照入库。

## 非目标

- 本期不开放协作图前端入口。
- 不引入跨用户共享、实时推送、协作整体完成状态或事件编辑。
- 不用时间接近度定位 Session，不把工具名唯一命中升级为确认关系。
- 不修改 Goal Plus collector、Pi/Codex adapter、OTLP 契约和原生会话解析。

## 验收边界

- 同一事件相同正文重试返回 duplicate，不新增记录；不同正文返回冲突。
- 事件可先于 Trace 保存，Trace 入库后端点从 pending 变为 linked。
- Goal Plus 一个主 Trace、多个 worker 时生成稳定的一对多关系。
- Goal Plus 多个主 Trace 时不任选父级，主端点为 ambiguous。
- Goal Plus 重扫不会新增重复关系；关系投影异常不影响快照成功响应。
- 普通 Trace 与现有 Goal Plus completeness 结果保持不变。
