# 实验取消与评测服务停止：设计

统一取消业务入口负责权限、持久化取消意图和关联执行定位；各执行器负责定向终止及确认。实验和 Case 的逻辑删除不物理移除取消依据。待确认取消需可查询及重试，禁止迟到结果复活任务。

平台删除接口显式区分运行条目的停止删除和原有 draft 回滚；Case 操作仅影响本次实验中的行。A/B Case 包含两侧及重复运行。列表和汇总过滤逻辑删除条目，取消不计入失败成绩。

远端使用结构化 runId 取消，复用控制通道，不接受自由命令或 PID。客户端持久化取消后中断对应进程树，回执报告真实结果。普通评测取消需传递到模型请求和 Agent session。

评测服务以数据卷中的停止标记禁止恢复和接单；管理脚本持有实例级管理锁，与启动互斥。先关闭 Controller 并关闭自动重启，再对账和清理其受管容器。镜像按持久化归属逐个非强制删除；保留数据卷、配置及外部引用。清理工具不得启动服务后台维护。

存储：`Experiment`、`ExperimentCase` 增加可空 `deletedAt`；`ExperimentCancellation` 按 `(experimentId, caseKey)` 唯一持久化取消目标、状态、错误和归属用户；`ExperimentLocalExecution` 记录正在执行的本地受控工作，实际退出后移除，不依赖单进程内存推断退出。异常退出残留不自动判成功。

接口：保留原实验 DELETE 草稿补偿语义，`?stop=true` 进入运行条目停止删除；新增 Case DELETE 和当前用户取消摘要 GET。Case 可为真实实验 Case ID，Skill 使用 `dataset:<caseId>` 统一涵盖 A/B 和重复轮次。取消先写数据库事务再异步下发，返回 202/200 表示待确认/完成；后台重试失败目标，取消全部确认后才推进后续 Case。

客户端新增结构化 `CANCEL_EXPERIMENT_RUN`；Evaluator 复用原 POST 入口 `operation=cancel`，校验既有请求摘要。管理脚本使用数据卷停止/取消标记及镜像登记，离线工具通过本地已有 Controller 镜像运行，不启动评测后台。

沿用原鉴权边界；具体字段与状态见 [API 契约](../../developer-guide/04-api-and-contracts.md)，命令边界和升级要求见[部署指南](../../developer-guide/benchmark/service-deployment-guide.md#11-立即停止与镜像清理)。
