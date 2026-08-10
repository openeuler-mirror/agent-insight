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

## `ras_control.sock`（遗留，非 stock 依赖）

仅当本地 gateway 仍监听 sock 时可用。stock master **无**该监听器；恢复必须以 Daemon cancel/input 为准。若仍有 sock ack，语义不变：无 ack → `ok=false`。

## FI

**零改动**。RAS Daemon 路径自持 lease，不依赖 FI adapter 接线。
