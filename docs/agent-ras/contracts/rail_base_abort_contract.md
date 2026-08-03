# Core abort / steering 契约（索引）

本仓 **不** fork `openjiuwen.core`。环内停流与纠偏依赖 agent-core 已合入的最小契约。

权威说明（已拷贝）：

- [`guides/agent-core-rail-base修改说明.md`](../guides/agent-core-rail-base修改说明.md)

## 涉及源文件（仍在 jiuwenswarm_enterprise / agent-core）

| 文件 | 契约 |
|------|------|
| `openjiuwen/core/single_agent/rail/base.py` | `AgentCallbackContext.request_abort_stream` / `consume_abort_stream` / `has_abort_stream_request`；steering queue（`bind_steering_queue` / `push_steering` / drain） |
| `openjiuwen/core/single_agent/agents/react_agent.py` | 流式 `llm.stream` 在 chunk 边界消费 abort，`aclose` provider 流；下一轮 drain steering |
| `openjiuwen/core/session/agent.py` | `write_stream` 写入前 `trigger("{session_id}write_stream")`，供 `StreamObserver` 挂载 |

## 与本仓 runtime 的关系

- `agent_ras/stream_observer.py`：注册 `{session_id}write_stream` callback。
- `agent_ras/monitor.py` / `recovery/operations.py`：确认异常后调用 `request_abort_stream`、`push_steering`、`request_force_finish`、用户 notice。
- 抽核后这些调用应收拢为 `HostControl` Port（见 [`../design/package-baseline/development_plan.md`](../design/package-baseline/development_plan.md)）。
