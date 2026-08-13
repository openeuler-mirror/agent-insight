# xiaoO upstream notes

Against **stock** xiaoO `origin/master`（不改上游源码）：

| Capability | RAS 用法 |
|------------|----------|
| Shared gateway + `run_agent_loop` | CLI/TUI/daemon 共用 |
| Plugin hooker (Chat / Tool / Session) | L1 采点；`tool_post` **不** hello |
| `HookAction` | master 仅 create/switch/send_prompt；**无** `cancel_active_turn`；CLI 丢弃 SendPrompt |
| `LoopEventSink` | **无配置挂载**；私改注入已废止 |
| `POST /api/v1/runtimes/open\|input\|cancel\|close` | **正式** Stream/Host：SSE 观测 + cancel/input 恢复（RAS 持有 lease） |

SessionHub 跨 hooker 子进程：`platform_adapter.common.transport.subprocess_ipc`。

## Daemon 契约（RAS 客户端）

| 接口 | 用途 |
|------|------|
| `POST /api/v1/runtimes/open` | 开会话；body 含 `runtime_id` / `conversation_id` / `sender_id` / `client_id` |
| `POST /api/v1/runtimes/input` | `Accept: text/event-stream`；字段 `text`（非 prompt） |
| `POST /api/v1/runtimes/cancel` | lease 持有者取消当前 turn |
| `POST /api/v1/runtimes/close` | 释放 |

SSE 事件：`text_delta` / `thinking_delta` / `tool_call` / `tool_result` / `done` / `cancelled` / `error` …

实现：[`daemon_client.py`](daemon_client.py)、[`daemon_session.py`](daemon_session.py)。

## 控制面

stock master **无** `ras_control.sock` 监听器。该遗留 Host 路径已从 RAS 删除；恢复必须以 Daemon `cancel`/`input` 为准。Plugin hooker 将 wire 映射为 stdout HookAction。

## FI

**零改动** `agent_fault_injection/**`。RAS Daemon 路径自持 lease，不依赖 FI adapter 接线。

Insight FI Worker **只**跑 `agent_fault_injection.cli`，**不得** spawn RAS（含历史上的 `fi_daemon_runner` 杂交入口，已删除）。RAS 是否参与会话，只由本机是否已挂载 RAS（hooker / Daemon 产品路径）决定。
