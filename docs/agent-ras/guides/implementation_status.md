# Agent RAS 架构与实现状态

本文是 Agent RAS 当前唯一的权威状态说明。其他 `docs/agent-ras/guides/` 文档中，现行指南见同级文件；历史方案见 [`archive/`](archive/)，不代表当前承诺。

## 稳定能力

- 单 Agent：通过 `create_deep_agent(agent_ras=AgentRASConfig(...))` 启用。
- Team：`TeamAgentRASConfig` 根据 `monitor_roles` 为 leader/teammate 装配 Rail；成员异常通过 Team event 汇聚到 leader，leader 本地异常直接路由。
- 检测角色：仅支持 `detection`；语义内容检测默认开启，需显式设置 `semantic_content_enabled=false` 关闭。
- 流检测：`AgentRASRail` 在 `before_invoke` 挂载 harness `StreamObserver`，监听 `{session_id}write_stream`（`Session.write_stream` 真正写入前触发），转发 `Monitor.on_stream_chunk`；不扩展 core Rail 事件。
- HITL：流中 ask（`Monitor._start_stream_hitl_ask`）；用户确认异常后通过 `AgentCallbackContext.request_abort_stream` 打断进行中的 `llm.stream`（允许多吐少量 token）。
- 隔离：Detector、恢复预算、流缓冲按真实 `session_id` 创建 invoke-scoped Monitor；跨 invoke 仅 HITL blob 落在 session.state。

## 组件边界

- `AgentRASRail`：生命周期钩子采集 Signal；按 session_id 懒创建 Monitor，在 `after_invoke` 自行 stop/pop；时机转发给 Monitor。
- `AgentRASMonitor`：统一编排 — `detection` 跑 Detector，`recovery` 按故障类型映射原子操作并驱动执行；拥有 stream/HITL/async 恢复生命周期。
- `recovery/engine`：`AnomalyKind`/`Severity` → `set[RecoveryAction]` 映射、限流、`RecoveryExecutor` 分发。
- `recovery/operations`：原子副作用（suppress/steer/notice/terminate）与 AskUser interrupt 持久化。
- `recovery/robustness_prompt`：中英文案与 HITL 问题渲染。

稳定公共 API 仅包括 `AgentRASConfig`、`AgentRASRail`、核心模型/协议、`RecoveryAction` 和 `build_agent_ras_rail`。

## 数据边界

Agent RAS 与其他 Rail 一样使用原始 callback 数据，不在检测链路内修改或递归脱敏。异常 evidence 遵循最小证据原则；稳定 in-process 路径不复制完整 tool result。日志、外部模型和 transport 的安全策略由对应框架边界统一负责。

## 实验能力

out-of-process 配置、Messager Rail 和 service 均位于 `openjiuwen.harness.agent_ras.experimental`。当前不承诺多 session 路由、可靠重放、命令 ACK、HITL 对齐或生产安全性，稳定 `AgentRASConfig` 会拒绝 process/transport 字段。

## 应用接入

jiuwenclaw 只负责将 YAML 转换为 `AgentRASConfig` 并透传给 core factory，不访问 Rail 或 Monitor 私有字段。本地 editable dependency 覆盖不得写入项目 `pyproject.toml`。

## Agent Insight 看板侧（本仓产品面）

环内 runtime 之外，本仓还提供：

- 旁路 ingest：`POST /api/ingest/ras-events`（见 [`../contracts/`](../contracts/) 与 developer-guide API 契约）
- 独立导航「AgentRAS 可靠性」：`/agent-ras/trace`、`/agent-ras/fault-modes`、`/agent-ras/fault-injection`
- 安装：`npx agent-insight install-ras` / 安装指导内嵌同版本安装器

产品面实现状态以全仓与 [`../design/README.md`](../design/README.md) 清单为准；普通 `/trace` **不**再挂 RAS 徽章。
